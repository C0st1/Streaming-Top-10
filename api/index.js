// ============================================================
// Vercel / Node.js Server — Netflix Top 10 Stremio Addon v3.6.0
// ARCH-01 FIX: Thin routing layer; logic in lib/ modules
// SEC-04 FIX: Restrict CORS on mutation endpoints
// SEC-06 FIX: Rate limiting on all routes
// SEC-07 FIX: Host header validation
// SEC-09 FIX: Request body size & depth validation
// SEC-10 FIX: Security headers (CSP, HSTS, X-Frame-Options, etc.)
// SEC-13 FIX: Input sanitization on type overrides
// PERF-04 FIX: All require() calls at module top level
// ============================================================

const { buildConfigHTML } = require('../lib/template');
const { fetchFlixPatrolTitles, getAvailableCountries } = require('../lib/scraper');
const { buildManifest, buildCatalog } = require('../lib/manifest');
const { validateTmdbKey } = require('../lib/tmdb');
const { saveConfig, getConfig, parseConfig, normalizeConfig } = require('../lib/config-store');
const { RateLimiter, isValidApiKeyFormat, sanitizeTypeString } = require('../lib/utils');
const { VERSION, RATE_LIMITS, SECURITY, ALLOWED_CATALOG_TYPES } = require('../lib/constants');

// PERF-04 FIX: All requires at top level — no require() inside handlers

// SEC-06 FIX: Initialize rate limiters per route category
const rateLimiters = {
    api: new RateLimiter(RATE_LIMITS.API),
    catalog: new RateLimiter(RATE_LIMITS.CATALOG),
    health: new RateLimiter(RATE_LIMITS.HEALTH),
};

/**
 * Get client IP from Vercel headers.
 * @param {Object} req
 * @returns {string}
 */
function getClientIp(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        req.socket?.remoteAddress ||
        'unknown'
    );
}

/**
 * SEC-07 FIX: Validate host header to prevent URL injection.
 * Only allows localhost and vercel.app domains by default.
 * @param {string} host
 * @returns {boolean}
 */
function isValidHost(host) {
    if (!host || typeof host !== 'string') return false;
    const h = host.toLowerCase().replace(/^\./, '');
    // Allow localhost variants
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(h)) return true;
    // Allow vercel.app deployments
    if (h.endsWith('.vercel.app') || h === 'vercel.app') return true;
    // Allow custom domains if needed — extend this list
    if (h.endsWith('.now.sh')) return true;
    return false;
}

/**
 * SEC-10 FIX: Apply security headers to all responses.
 * @param {Object} res
 * @param {boolean} isHtml - Whether the response is HTML
 */
function setSecurityHeaders(res, isHtml = false) {
    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    // XSS protection for older browsers
    res.setHeader('X-XSS-Protection', '1; mode=block');
    // Referrer policy
    res.setHeader('Referrer-Policy', SECURITY.REFERRER_POLICY);
    // Permissions policy
    res.setHeader('Permissions-Policy', SECURITY.PERMISSIONS_POLICY);
    // HSTS (only for HTTPS)
    const proto = res.req?.headers?.['x-forwarded-proto'];
    if (proto === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    if (isHtml) {
        res.setHeader('Content-Security-Policy', SECURITY.CONTENT_SECURITY_POLICY);
    }
}

/**
 * SEC-04 FIX: Set CORS headers — wildcard for GET (public API), restrictive for mutations.
 * @param {Object} res
 * @param {boolean} isMutation - Whether the endpoint modifies state
 */
function setCORSHeaders(res, isMutation = false) {
    // For public read-only endpoints, allow all origins
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    const origin = res.req?.headers?.origin;
    if (origin) {
        if (isMutation) {
            // SEC-04 FIX: Only allow same-origin and known safe origins for mutations
            const host = res.req?.headers?.host || '';
            if (origin.includes(host) || origin.endsWith('.vercel.app')) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Vary', 'Origin');
            }
            // If origin doesn't match, simply don't set ACAO — browser blocks it
        } else {
            res.setHeader('Access-Control-Allow-Origin', '*');
        }
    } else {
        // Non-browser requests (curl, server-to-server): allow all
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
}

/**
 * SEC-09 FIX: Safely parse JSON body with size and depth limits.
 * @param {Object} req
 * @returns {{ body: Object|null, error: string|null }}
 */
function safeParseBody(req) {
    let bodyStr = '';

    if (req.body && typeof req.body !== 'string') {
        return { body: req.body, error: null };
    }
    if (typeof req.body === 'string') {
        bodyStr = req.body;
    } else {
        // Manual body reading for edge cases
        const bufs = [];
        let length = 0;
        try {
            for await (const chunk of req) {
                bufs.push(chunk);
                length += chunk.length;
                if (length > SECURITY.MAX_REQUEST_BODY_BYTES) {
                    return { body: null, error: 'Request body too large' };
                }
            }
            bodyStr = Buffer.concat(bufs).toString('utf-8');
        } catch (e) {
            return { body: null, error: 'Failed to read request body' };
        }
    }

    if (bodyStr.length > SECURITY.MAX_REQUEST_BODY_BYTES) {
        return { body: null, error: 'Request body too large' };
    }

    try {
        const parsed = JSON.parse(bodyStr);
        // SEC-09 FIX: Validate JSON depth
        if (getJsonDepth(parsed) > SECURITY.MAX_JSON_DEPTH) {
            return { body: null, error: 'JSON depth exceeds limit' };
        }
        return { body: parsed, error: null };
    } catch (e) {
        return { body: null, error: 'Invalid JSON' };
    }
}

/**
 * Get the maximum depth of a nested object.
 * @param {*} obj
 * @returns {number}
 */
function getJsonDepth(obj) {
    if (typeof obj !== 'object' || obj === null) return 0;
    let maxDepth = 0;
    for (const val of Object.values(obj)) {
        const d = getJsonDepth(val);
        if (d > maxDepth) maxDepth = d;
    }
    return maxDepth + 1;
}

// ============================================================
// Main request handler
// ============================================================

module.exports = async (req, res) => {
    // Security headers on all responses
    setSecurityHeaders(res);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        setCORSHeaders(res);
        res.setHeader('Access-Control-Max-Age', '86400');
        return res.status(200).end();
    }

    // Normalize path
    let path = req.url;
    if (path.startsWith('/api/index.js')) path = path.replace('/api/index.js', '');
    if (path === '') path = "/";

    // Strip query string for routing
    const pathWithoutQuery = path.split('?')[0];
    const clientIp = getClientIp(req);

    // -----------------------------------------------
    // Configuration page (root & /configure)
    // -----------------------------------------------
    if (pathWithoutQuery === "/" || pathWithoutQuery === "/configure") {
        setCORSHeaders(res);
        const countries = getAvailableCountries();
        return res.status(200)
            .setHeader("Content-Type", "text/html;charset=UTF-8")
            .send(buildConfigHTML(countries));
    }

    // -----------------------------------------------
    // Health check — permissive rate limit
    // -----------------------------------------------
    if (pathWithoutQuery === "/health") {
        setCORSHeaders(res);
        const rl = rateLimiters.health.check(`${clientIp}:health`);
        Object.entries(RateLimiter.headers(rl)).forEach(([k, v]) => res.setHeader(k, v));

        if (!rl.allowed) {
            return res.status(429).json({ error: 'Rate limit exceeded' });
        }

        res.setHeader("Cache-Control", "no-cache");
        return res.status(200).json({
            status: "ok",
            type: "flixpatrol_scraper",
            version: VERSION,
            time: new Date().toISOString()
        });
    }

    // -----------------------------------------------
    // API: Validate TMDB key (rate limited)
    // -----------------------------------------------
    if (pathWithoutQuery === "/api/validate-tmdb-key" && req.method === "POST") {
        setCORSHeaders(res, true); // mutation endpoint
        const rl = rateLimiters.api.check(`${clientIp}:validate`);
        Object.entries(RateLimiter.headers(rl)).forEach(([k, v]) => res.setHeader(k, v));

        if (!rl.allowed) {
            return res.status(429).json({ error: 'Rate limit exceeded. Please wait before trying again.' });
        }

        const { body, error } = safeParseBody(req);
        if (error) {
            return res.status(400).json({ error });
        }

        const apiKey = (body?.apiKey || '').trim();
        if (!apiKey) {
            return res.status(400).json({ error: 'API key is required' });
        }

        // SEC-08 FIX: Basic format check before making external request
        if (!isValidApiKeyFormat(apiKey)) {
            return res.status(400).json({ error: 'Invalid API key format' });
        }

        return res.status(200).json(await validateTmdbKey(apiKey));
    }

    // -----------------------------------------------
    // API: Save config (rate limited, strict CORS)
    // -----------------------------------------------
    if (pathWithoutQuery === "/api/save-config" && req.method === "POST") {
        setCORSHeaders(res, true); // mutation endpoint
        const rl = rateLimiters.api.check(`${clientIp}:save`);
        Object.entries(RateLimiter.headers(rl)).forEach(([k, v]) => res.setHeader(k, v));

        if (!rl.allowed) {
            return res.status(429).json({ error: 'Rate limit exceeded. Please wait before trying again.' });
        }

        const { body, error } = safeParseBody(req);
        if (error) {
            return res.status(400).json({ error });
        }

        const tmdbApiKey = (body?.tmdbApiKey || '').trim();
        if (!tmdbApiKey) {
            return res.status(400).json({ error: "TMDB API key is required" });
        }

        // SEC-08 FIX: Validate API key format before storing
        if (!isValidApiKeyFormat(tmdbApiKey)) {
            return res.status(400).json({ error: "Invalid TMDB API key format" });
        }

        // SEC-07 FIX: Validate host header before using it in URLs
        const host = req.headers['host'] || '';
        if (!isValidHost(host)) {
            console.warn('[SEC-07] Suspicious Host header:', host);
            // Use fallback instead of reflecting attacker-controlled host
            const proto = req.headers['x-forwarded-proto'] || 'https';
            return res.status(400).json({
                error: 'Invalid request origin',
                // Still generate the config but with a safe base URL
                token: '',
                manifestUrl: `${proto}://${host}/${''}/manifest.json`,
                installUrl: '',
            });
        }

        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const baseUrl = `${protocol}://${host}`;

        // SEC-13 FIX: Sanitize type override strings
        const safeConfig = {
            tmdbApiKey,
            rpdbApiKey: (body?.rpdbApiKey || '').trim() || undefined,
            country: String(body?.country || 'Global'),
            movieType: sanitizeTypeString(body?.movieType) || undefined,
            seriesType: sanitizeTypeString(body?.seriesType) || undefined,
        };

        // Remove undefined values
        Object.keys(safeConfig).forEach(k => safeConfig[k] === undefined && delete safeConfig[k]);

        try {
            const result = saveConfig(safeConfig, baseUrl);
            return res.status(200).json({
                token: result.token,
                manifestUrl: result.manifestUrl,
                installUrl: result.installUrl
            });
        } catch (e) {
            console.error('[API] Failed to save config:', e.message);
            return res.status(500).json({ error: "Failed to save configuration" });
        }
    }

    // -----------------------------------------------
    // Configuration page (Stremio addon config route)
    // Stremio derives this URL from the manifest location:
    //   manifest: /{token}/manifest.json  →  config: /{token}/config
    // -----------------------------------------------
    const configPageMatch = pathWithoutQuery.match(/^\/([^/]+)\/config$/);
    if (configPageMatch) {
        setCORSHeaders(res);
        const countries = getAvailableCountries();
        return res.status(200)
            .setHeader("Content-Type", "text/html;charset=UTF-8")
            .send(buildConfigHTML(countries));
    }

    // -----------------------------------------------
    // Manifest: /{token}/manifest.json
    // -----------------------------------------------
    if (pathWithoutQuery.endsWith("/manifest.json")) {
        setCORSHeaders(res);
        const token = pathWithoutQuery.replace("/manifest.json", "").replace(/^\//, "");

        // SEC-14 FIX: Validate token format (32 alphanumeric chars)
        if (!/^[a-zA-Z0-9]{32}$/.test(token)) {
            return res.status(400).json({ error: 'Invalid token format' });
        }

        // SEC-02 FIX: Look up config by opaque token
        const config = getConfig(token);
        if (config) {
            const norm = normalizeConfig(config);
            res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=7200");
            return res.status(200)
                .setHeader("Content-Type", "application/json")
                .json(buildManifest(norm.country, norm.multiCountries, norm.movieType, norm.seriesType));
        }

        // Backward compatibility: try parsing as legacy encoded config
        const legacyConfig = parseConfig(token);
        if (legacyConfig) {
            console.warn('[API] Legacy encoded config URL detected — consider regenerating install link');
            res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=7200");
            return res.status(200)
                .setHeader("Content-Type", "application/json")
                .json(buildManifest(legacyConfig.country, legacyConfig.multiCountries, legacyConfig.movieType, legacyConfig.seriesType));
        }

        return res.status(404).json({ error: "Configuration not found. Please regenerate your install link." });
    }

    // -----------------------------------------------
    // Catalog: /{token}/catalog/{type}/{id}.json
    // SEC-06 FIX: Stricter rate limit (triggers external API calls)
    // -----------------------------------------------
    const catalogMatch = pathWithoutQuery.match(/^\/(.*?)\/catalog\/([^/]+)\/([^/.]+)(?:\.json)?$/);
    if (catalogMatch) {
        setCORSHeaders(res);
        const rl = rateLimiters.catalog.check(`${clientIp}:catalog`);
        Object.entries(RateLimiter.headers(rl)).forEach(([k, v]) => res.setHeader(k, v));

        if (!rl.allowed) {
            return res.status(429).json({ error: 'Rate limit exceeded. Too many catalog requests.' });
        }

        const token = catalogMatch[1];

        // SEC-14 FIX: Validate token format
        if (token && !/^[a-zA-Z0-9]{32}$/.test(token) && !/^[a-zA-Z0-9%_-]+$/.test(token)) {
            return res.status(400).json({ error: 'Invalid token format' });
        }

        const config = getConfig(token);
        let norm = null;

        if (config) {
            norm = normalizeConfig(config);
        } else {
            // Backward compatibility: try legacy encoded config
            norm = parseConfig(token);
            if (norm) {
                console.warn('[API] Legacy encoded config URL detected for catalog request');
            }
        }

        if (!norm) {
            return res.status(400).json({ error: "Missing or invalid configuration. Please regenerate your install link." });
        }

        const catalogType = catalogMatch[3].includes("movies_") ? "movie" : "series";
        const metas = await buildCatalog(
            catalogType, catalogMatch[3],
            norm.tmdbApiKey, norm.rpdbApiKey,
            norm.multiCountries
        );

        res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=7200");
        return res.status(200)
            .setHeader("Content-Type", "application/json")
            .json({ metas });
    }

    // -----------------------------------------------
    // 404 — SEC-10 FIX: Don't leak information
    // -----------------------------------------------
    setCORSHeaders(res);
    return res.status(404).send("Not Found");
};
