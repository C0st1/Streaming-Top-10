// ============================================================
// Config Store — Opaque token-based configuration storage
// Fixes SEC-02: API keys no longer embedded in URLs
// Fixes SEC-13: Input validation on movieType/seriesType
// ============================================================

const { LRUCache } = require('./cache');
const { generateToken } = require('./utils');
const { DEFAULTS, ALLOWED_CATALOG_TYPES } = require('./constants');

// LRU cache for config tokens
const configStore = new LRUCache({
    maxSize: DEFAULTS.CONFIG_STORE_MAX,
    ttl: 30 * 24 * 60 * 60 * 1000, // 30 days
});

/**
 * Validate and sanitize a type override string.
 * Only allows known safe values or custom alphanumeric names.
 * @param {string} value
 * @param {string} fallback
 * @returns {string}
 */
function validateTypeOverride(value, fallback) {
    if (!value || typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    if (!trimmed) return fallback;

    // Allow known safe type values (lowercase match)
    if (ALLOWED_CATALOG_TYPES.includes(trimmed.toLowerCase())) {
        return trimmed.toLowerCase();
    }

    // Allow custom names but sanitize: alphanumeric + spaces + hyphens, max 50 chars
    const sanitized = trimmed.replace(/[^a-zA-Z0-9\s\-_]/g, '').substring(0, 50).trim();
    return sanitized || fallback;
}

/**
 * Save a configuration and return an opaque token.
 * The token can be used in manifest/catalog URLs without exposing credentials.
 *
 * @param {Object} config - User configuration
 * @param {string} config.tmdbApiKey
 * @param {string} [config.rpdbApiKey]
 * @param {string} config.country - Comma-separated countries
 * @param {string} [config.movieType]
 * @param {string} [config.seriesType]
 * @returns {{token: string, manifestUrl: string, installUrl: string}}
 */
function saveConfig(config, baseUrl) {
    const token = generateToken();
    configStore.set(token, {
        tmdbApiKey: String(config.tmdbApiKey || '').trim(),
        rpdbApiKey: config.rpdbApiKey ? String(config.rpdbApiKey).trim() : '',
        country: String(config.country || 'Global'),
        // SEC-13 FIX: Validate type overrides before storing
        movieType: validateTypeOverride(config.movieType, 'movie'),
        seriesType: validateTypeOverride(config.seriesType, 'series'),
        createdAt: Date.now(),
    });
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const manifestUrl = `${cleanBase}/${token}/manifest.json`;
    const installUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://');
    return { token, manifestUrl, installUrl };
}

/**
 * Look up configuration by opaque token.
 * @param {string} token
 * @returns {Object|null}
 */
function getConfig(token) {
    const result = configStore.get(token);
    return result.data;
}

/**
 * Parse a legacy encoded config from URL (backward compatibility).
 * @param {string} configStr
 * @returns {Object|null}
 */
function parseConfig(configStr) {
    try {
        const config = JSON.parse(decodeURIComponent(configStr));
        if (!config?.tmdbApiKey?.trim()) return null;
        const mc = (config.country || "Global").split(",").map(c => c.trim()).filter(c => c);
        return {
            tmdbApiKey: config.tmdbApiKey.trim(),
            rpdbApiKey: config.rpdbApiKey?.trim() || null,
            country: mc[0] || "Global",
            multiCountries: mc,
            movieType: validateTypeOverride(config.movieType, 'movie'),
            seriesType: validateTypeOverride(config.seriesType, 'series'),
        };
    } catch (err) {
        console.warn(`[Config] Failed to parse config string:`, err.message);
        return null;
    }
}

/**
 * Normalize a config object (from store or parsed) to a standard shape.
 * @param {Object} config
 * @returns {Object|null}
 */
function normalizeConfig(config) {
    if (!config?.tmdbApiKey?.trim()) return null;
    const mc = (config.country || "Global").split(",").map(c => c.trim()).filter(c => c);
    return {
        tmdbApiKey: config.tmdbApiKey.trim(),
        rpdbApiKey: config.rpdbApiKey?.trim() || null,
        country: mc[0] || "Global",
        multiCountries: mc,
        movieType: validateTypeOverride(config.movieType, 'movie'),
        seriesType: validateTypeOverride(config.seriesType, 'series'),
    };
}

module.exports = {
    saveConfig,
    getConfig,
    parseConfig,
    normalizeConfig,
};
