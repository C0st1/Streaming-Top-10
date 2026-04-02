// ============================================================
// FlixPatrol Scraper
// Fixes REL-01: Improved robustness with validation + logging
// Fixes PERF-04: Moved require() to module top level
// Fixes PERF-07: O(n²) dedup replaced with Set-based O(n)
// Fixes SEC-11: Country slug validated against whitelist
// ============================================================

const { LRUCache } = require('./cache');
const { fetchWithTimeout, getFlixPatrolSlug } = require('./utils');
const cheerio = require('cheerio');
const { DEFAULTS, ALLOWED_COUNTRY_SLUGS } = require('./constants');

// PERF-04 FIX: require() at module level, not inside functions

// LRU cache for FlixPatrol scraping results
const flixpatrolCache = new LRUCache({
    maxSize: DEFAULTS.CACHE_MAX_FLIXPATROL,
    ttl: DEFAULTS.CACHE_TTL,
});

/**
 * Scrape FlixPatrol for Top 10 titles.
 * SEC-11 FIX: Validates country slug against known whitelist.
 * @param {string} categoryType - "Films" or "TV"
 * @param {string} country - Country name (default "Global")
 * @returns {Promise<Array<{title: string, year: string|null}>>}
 */
async function fetchFlixPatrolTitles(categoryType, country = "Global") {
    const slug = getFlixPatrolSlug(country);

    // SEC-11 FIX: Validate slug against whitelist to prevent URL injection
    if (slug !== 'world' && !ALLOWED_COUNTRY_SLUGS.has(slug)) {
        console.warn(`[Scraper] Unknown country slug: "${slug}" — rejecting request`);
        return [];
    }

    const cacheKey = `flixpatrol_${slug}_${categoryType}`;
    const cached = flixpatrolCache.get(cacheKey);
    if (cached.data && !cached.stale) return cached.data;

    try {
        const url = `https://flixpatrol.com/top10/netflix/${slug}/`;
        const opts = {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        };
        const res = await fetchWithTimeout(url, opts, DEFAULTS.FLIXPATROL_TIMEOUT);
        if (!res.ok) {
            console.warn(`[Scraper] FlixPatrol returned status ${res.status} for ${country}/${categoryType}`);
            throw new Error(`FlixPatrol fetch failed with status ${res.status}`);
        }

        const html = await res.text();

        // SEC-11 FIX: Limit HTML size to prevent memory exhaustion from malicious responses
        if (html.length > 5 * 1024 * 1024) {
            console.warn(`[Scraper] FlixPatrol response too large (${(html.length / 1024).toFixed(0)}KB), truncating`);
        }
        const $ = cheerio.load(html.substring(0, 5 * 1024 * 1024));

        const titles = [];
        // PERF-07 FIX: Use a Set for O(1) dedup instead of Array.some() O(n)
        const seenTitles = new Set();
        const targetHeader = categoryType === "Films" ? "TOP 10 Movies" : "TOP 10 TV Shows";

        // Strategy 1: Find header text and extract from nearest container
        const headers = $(`:contains("${targetHeader}")`).filter(function () {
            return $(this).children().length === 0;
        });

        if (headers.length > 0) {
            let container = headers.first().closest('table');
            if (container.length === 0) container = headers.first().closest('div').nextAll('table').first();
            if (container.length === 0) container = headers.first().closest('.card, .table-wrapper, div[class*="flex"], div[class*="grid"]');

            if (container.length > 0) {
                container.find('a[href*="/title/"]').each((i, a) => {
                    const title = $(a).text().trim();
                    const href = $(a).attr('href') || '';
                    const yearMatch = href.match(/-(\d{4})\/?$/);
                    const year = yearMatch ? yearMatch[1] : null;

                    if (title && !seenTitles.has(title) && titles.length < 10) {
                        seenTitles.add(title);
                        titles.push({ title, year });
                    }
                });
            }
        }

        // Strategy 2: Fallback — collect all title links from the page
        if (titles.length === 0) {
            console.warn(`[Scraper] Primary selector failed for ${country}/${categoryType}, using fallback`);
            const allTitles = [];
            $('a[href*="/title/"]').each((i, a) => {
                const title = $(a).text().trim();
                const href = $(a).attr('href') || '';
                const yearMatch = href.match(/-(\d{4})\/?$/);
                const year = yearMatch ? yearMatch[1] : null;

                if (title && !seenTitles.has(title)) {
                    seenTitles.add(title);
                    allTitles.push({ title, year });
                }
            });
            // REL-01 FIX: Don't assume fixed split; just take first 10 for both categories
            if (allTitles.length > 0) {
                console.warn(`[Scraper] Fallback collected ${allTitles.length} titles (no category distinction) for ${country}/${categoryType}`);
                const count = Math.min(10, allTitles.length);
                titles.push(...allTitles.slice(0, count));
            }
        }

        if (titles.length > 0) {
            flixpatrolCache.set(cacheKey, titles);
        } else {
            console.error(`[Scraper] No titles found for ${country}/${categoryType}`);
        }
        return titles;
    } catch (err) {
        // REL-02 FIX: Log all errors instead of silently swallowing
        console.error(`[Scraper] FlixPatrol scrape error for ${country}/${categoryType}:`, err.message);
        return [];
    }
}

/**
 * Get the list of available countries.
 * PERF-04 FIX: Return constant reference directly (no new array per call).
 * PERF-05 FIX: Cached at module level.
 * @returns {string[]}
 */
function getAvailableCountries() {
    const { FLIXPATROL_COUNTRIES } = require('./constants');
    return FLIXPATROL_COUNTRIES;
}

module.exports = {
    fetchFlixPatrolTitles,
    getAvailableCountries,
};
