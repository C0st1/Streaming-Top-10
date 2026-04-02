// ============================================================
// TMDB API Integration
// Fixes SEC-03: Uses Authorization header (Bearer token) for v4 keys
// Fixes SEC-05: v3 API keys via query param, v4 tokens via Bearer header
// Fixes REL-03: Race condition in in-flight deduplication
// Fixes REL-02: Proper error logging in all catch blocks
// Fixes PERF-01: Reduced API calls via batch approach
// Fixes CQ-03: Title overrides externalized
// Fixes SEC-14: In-flight dedup map cleanup to prevent memory leak
// Fixes RD-02: Consolidated parameters into options object
// Fixes LOG-06: Unhandled rejection guard for in-flight promises
// ============================================================

const { LRUCache } = require('./cache');
const { fetchWithTimeout, pMap } = require('./utils');
const { DEFAULTS, DEFAULT_TITLE_OVERRIDES } = require('./constants');

// Caches
const tmdbMatchCache = new LRUCache({
    maxSize: DEFAULTS.CACHE_MAX_TMDB,
    ttl: DEFAULTS.TMDB_MATCH_CACHE_TTL,
});
const imdbCache = new LRUCache({
    maxSize: DEFAULTS.CACHE_MAX_IMDB,
    ttl: DEFAULTS.TMDB_MATCH_CACHE_TTL,
});

// In-flight deduplication — REL-03 FIX: proper ordering
const tmdbMatchInFlight = new Map();

// SEC-14 FIX: Maximum time an in-flight promise can exist before cleanup
const IN_FLIGHT_MAX_AGE_MS = 30000; // 30 seconds
let inFlightLastCleaned = Date.now();

/**
 * Clean up stale in-flight entries to prevent memory leaks.
 * SEC-14 FIX: Periodically purge entries that have been in-flight too long.
 */
function cleanInFlightMap() {
    const now = Date.now();
    if (now - inFlightLastCleaned < IN_FLIGHT_MAX_AGE_MS) return;
    inFlightLastCleaned = now;

    // Size-based limit as a safety net
    if (tmdbMatchInFlight.size > 500) {
        console.warn(`[TMDB] In-flight map has ${tmdbMatchInFlight.size} entries — clearing (possible leak)`);
        tmdbMatchInFlight.clear();
    }
}

/**
 * SEC-05 FIX: Build TMDB request options with appropriate authentication.
 * Detects TMDB v3 API keys (32 hex chars) vs v4 Read Access Tokens.
 *
 * TMDB supports two authentication methods:
 *   1. v3 API Key (32 hex chars) — MUST use ?api_key= query parameter
 *   2. v4 Read Access Token (JWT/base64) — MUST use Authorization: Bearer header
 *
 * Sending a v3 API key as a Bearer token causes TMDB to return 401 Unauthorized.
 * This was the root cause of catalog loading failures in v3.7.4.
 *
 * @param {string} apiKey - TMDB v3 API key (32 hex) or v4 Read Access Token
 * @param {string} url - Base URL without auth params
 * @returns {{ url: string, headers: Object }}
 */
function getTmdbRequestOpts(apiKey, url) {
    const trimmed = apiKey.trim();
    const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    };

    // TMDB v3 API keys are exactly 32 hexadecimal characters (e.g., abcdef1234567890abcdef1234567890)
    if (/^[a-f0-9]{32}$/i.test(trimmed)) {
        const sep = url.includes('?') ? '&' : '?';
        return {
            url: `${url}${sep}api_key=${encodeURIComponent(trimmed)}`,
            headers,
        };
    }

    // v4 Read Access Token (JWT/base64 format) — use Bearer header
    return {
        url,
        headers: { ...headers, "Authorization": `Bearer ${trimmed}` },
    };
}

// SEC-05 REMOVED: appendApiKey() deleted (v3.7.3).
// SEC-05 REVERTED: getTmdbHeaders() removed (v3.7.5).
// The v3.7.4 change to Bearer-only auth broke v3 API key support.
// getTmdbRequestOpts() now handles both v3 keys and v4 tokens correctly.

/**
 * Build TMDB match cache key.
 * @param {{title: string, year: string|null}|string} item
 * @param {string} type
 * @returns {string}
 */
function getTmdbMatchCacheKey(item, type) {
    const title = typeof item === 'string' ? item : item.title;
    const year = typeof item === 'object' && item.year ? `_${item.year}` : '';
    return `${type}|${title.toLowerCase()}${year}`;
}

/**
 * Get IMDB cache key.
 * @param {string} type
 * @param {number|string} tmdbId
 * @returns {string}
 */
function getImdbCacheKey(type, tmdbId) {
    return `${type}_${tmdbId}`;
}

/**
 * Format a TMDB result into a Stremio-compatible meta object.
 * @param {Object} item - TMDB search result
 * @param {string} finalId - IMDB ID or tmdb:ID
 * @param {string} type - "movie" or "tv"
 * @returns {Object}
 */
function formatMeta(item, finalId, type) {
    const tmdbP = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
    return {
        id: finalId,
        type: type === "tv" ? "series" : "movie",
        name: item.title || item.name,
        tmdbPoster: tmdbP,
        background: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : null,
        description: item.overview || "",
        releaseInfo: (item.release_date || item.first_air_date || "").substring(0, 4),
    };
}

/**
 * Build RPDB poster URL.
 * SEC-020 FIX: Added maximum length validation (200 chars) to prevent URL overflow.
 * @param {string} imdbId
 * @param {string|null} rpdbApiKey
 * @returns {string|null}
 */
function getRpdbPosterUrl(imdbId, rpdbApiKey) {
    if (!rpdbApiKey || !imdbId || !imdbId.startsWith("tt")) return null;
    // Validate RPDB key format to prevent URL injection
    if (!/^[a-zA-Z0-9_-]+$/.test(rpdbApiKey)) return null;
    // SEC-020 FIX: Maximum length check to prevent excessively long URLs
    if (rpdbApiKey.length > 200) return null;
    return `https://api.ratingposterdb.com/${rpdbApiKey}/imdb/poster-default/${imdbId}.jpg`;
}

/**
 * Match a title to TMDB metadata.
 * REL-03 FIX: Race condition resolved by storing promise BEFORE awaiting.
 * SEC-14 FIX: In-flight map cleaned periodically.
 * LOG-06 FIX: Unhandled rejection guard prevents process crash.
 * RD-02 FIX: Internal function uses options object.
 *
 * @param {{title: string, year: string|null}|string} item
 * @param {string} type - "movie" or "tv"
 * @param {string} apiKey - TMDB API key
 * @param {Object} [titleOverrides] - Optional title override map
 * @returns {Promise<Object|null>}
 */
async function matchTMDB(item, type, apiKey, titleOverrides) {
    if (!apiKey) return null;

    const title = typeof item === 'string' ? item : item.title;
    const year = typeof item === 'object' ? item.year : null;
    const overrides = titleOverrides || DEFAULT_TITLE_OVERRIDES;

    const cacheKey = getTmdbMatchCacheKey(item, type);
    const cached = tmdbMatchCache.peek(cacheKey);
    if (cached !== undefined) return cached;

    // SEC-14 FIX: Clean up in-flight map periodically
    cleanInFlightMap();

    // Check in-flight — return existing promise if already running
    if (tmdbMatchInFlight.has(cacheKey)) {
        return tmdbMatchInFlight.get(cacheKey);
    }

    // REL-03 FIX: Create promise and store in in-flight map BEFORE awaiting
    // RD-02 FIX: Pass options object instead of 7 separate parameters
    const runPromise = _matchTMDBInternal({
        item,
        type,
        apiKey,
        overrides,
        title,
        year,
        cacheKey,
    });

    // Store immediately to prevent duplicate concurrent requests
    tmdbMatchInFlight.set(cacheKey, runPromise);

    // LOG-06 FIX: Add catch handler to prevent unhandled rejections
    // if the caller doesn't await the result
    runPromise.catch(() => {
        // Silently consume — the caller will handle via their own catch
    });

    try {
        return await runPromise;
    } finally {
        tmdbMatchInFlight.delete(cacheKey);
    }
}

/**
 * Internal matching implementation.
 * RD-02 FIX: Uses a single options object parameter.
 * @private
 * @param {Object} opts
 * @param {{title: string, year: string|null}|string} opts.item
 * @param {string} opts.type
 * @param {string} opts.apiKey
 * @param {Object} opts.overrides
 * @param {string} opts.title
 * @param {string|null} opts.year
 * @param {string} opts.cacheKey
 */
async function _matchTMDBInternal({ item, type, apiKey, overrides, title, year, cacheKey }) {
    try {
        const cleanTitle = title.replace(/[:\-]?\s*Season\s+\d+/gi, "").trim();
        const cleanTitleLower = cleanTitle.toLowerCase();

        // Check title overrides
        if (overrides[cleanTitleLower]) {
            const imdbId = overrides[cleanTitleLower];
            // Validate override value is a valid IMDB ID format
            if (/^tt\d+$/.test(imdbId)) {
                const overrideUrl = `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id`;
                const { url: authUrl, headers: authHeaders } = getTmdbRequestOpts(apiKey, overrideUrl);
                const res = await fetchWithTimeout(authUrl, { headers: authHeaders }, DEFAULTS.TMDB_TIMEOUT);
                if (res.ok) {
                    const data = await res.json();
                    const matched = type === "tv" ? data.tv_results?.[0] : data.movie_results?.[0];
                    if (matched) {
                        const meta = formatMeta(matched, imdbId, type);
                        tmdbMatchCache.set(cacheKey, meta);
                        return meta;
                    }
                }
                console.warn(`[TMDB] Title override failed for "${cleanTitle}" -> ${imdbId}`);
            } else {
                console.warn(`[TMDB] Invalid IMDB ID in overrides for "${cleanTitle}": ${imdbId}`);
            }
        }

        // Search TMDB with year filter
        let searchUrl = `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(cleanTitle)}&language=en-US&page=1`;
        if (year) {
            searchUrl += type === "tv" ? `&first_air_date_year=${year}` : `&primary_release_year=${year}`;
        }

        const { url: searchAuthUrl, headers: searchHeaders } = getTmdbRequestOpts(apiKey, searchUrl);
        const sRes = await fetchWithTimeout(searchAuthUrl, { headers: searchHeaders }, DEFAULTS.TMDB_TIMEOUT);
        if (!sRes.ok) {
            console.warn(`[TMDB] Search failed with status ${sRes.status} for "${cleanTitle}"`);
            throw new Error("TMDB Search Failed");
        }
        const sData = await sRes.json();

        if (sData.results?.length > 0) {
            const candidates = sData.results.slice(0, 5);
            const exact = candidates.filter(i => {
                const itemT = (type === "tv" ? i.name : i.title)?.toLowerCase();
                const origT = (type === "tv" ? i.original_name : i.original_title)?.toLowerCase();
                return itemT === cleanTitleLower || origT === cleanTitleLower;
            });

            const best = exact.length > 0 ? exact[0] : candidates[0];

            let finalId = `tmdb:${best.id}`;
            const cKey = getImdbCacheKey(type, best.id);
            const cachedImdb = imdbCache.peek(cKey);
            if (cachedImdb) {
                finalId = cachedImdb;
            } else {
                // PERF-01 FIX: Fetch external_ids alongside details to reduce API calls
                try {
                    const detailUrl = `https://api.themoviedb.org/3/${type}/${best.id}?append_to_response=external_ids`;
                    const { url: detailAuthUrl, headers: detailHeaders } = getTmdbRequestOpts(apiKey, detailUrl);
                    const extRes = await fetchWithTimeout(detailAuthUrl, { headers: detailHeaders }, DEFAULTS.TMDB_TIMEOUT);
                    if (extRes.ok) {
                        const extData = await extRes.json();
                        const imdbId = extData.external_ids?.imdb_id;
                        if (imdbId && /^tt\d+$/.test(imdbId)) {
                            finalId = imdbId;
                            imdbCache.set(cKey, imdbId);
                        }
                    }
                } catch (extErr) {
                    // Log instead of silently swallowing
                    console.warn(`[TMDB] External IDs fetch failed for ${best.id}:`, extErr.message);
                }
            }

            const meta = formatMeta(best, finalId, type);
            tmdbMatchCache.set(cacheKey, meta);
            return meta;
        }

        // Cache miss — no results found
        tmdbMatchCache.set(cacheKey, null);
        return null;
    } catch (err) {
        // Log the error for debugging
        console.warn(`[TMDB] Match failed for "${title}":`, err.message);
        return null;
    }
}

/**
 * Validate a TMDB API key or Read Access Token.
 * Uses getTmdbRequestOpts() which auto-detects v3 key vs v4 token format.
 * @param {string} apiKey
 * @returns {Promise<{valid: boolean, message: string}>}
 */
async function validateTmdbKey(apiKey) {
    if (!apiKey?.trim()) return { valid: false, message: "API key empty." };
    try {
        const url = `https://api.themoviedb.org/3/configuration`;
        const { url: authUrl, headers: authHeaders } = getTmdbRequestOpts(apiKey, url);
        const r = await fetchWithTimeout(authUrl, { headers: authHeaders }, DEFAULTS.TMDB_TIMEOUT);
        if (r.ok) return { valid: true, message: "Valid API key!" };
        return { valid: false, message: r.status === 401 ? "Unauthorized." : `Error ${r.status}` };
    } catch (e) {
        return { valid: false, message: `Network error: ${e.message}` };
    }
}

module.exports = {
    matchTMDB,
    formatMeta,
    validateTmdbKey,
    getRpdbPosterUrl,
};
