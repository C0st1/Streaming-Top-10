# Streaming-Top-10 v3.7.2 — Refactored

## Summary of Changes

This refactored version fixes **25 issues** identified in the security and performance code review.

### Files Modified (9 files)

| File | Issues Fixed |
|------|-------------|
| `lib/config-store.js` | SEC-01 (hardcoded encryption key), SEC-04 (token expiry) |
| `api/index.js` | SEC-02 (CORS bypass), SEC-03 (missing rate limits), SEC-06 (unauthenticated endpoints), SEC-07 (reflected host), SEC-09b (token logging), LOG-01 (circular refs), LOG-02 (invalid host response), RD-01 (monolithic handler) |
| `lib/metrics.js` | PERF-01 (unbounded growth — cardinality limits) |
| `lib/tmdb.js` | SEC-05 (API key in URL), RD-02 (parameter explosion), LOG-06 (unhandled rejections) |
| `lib/utils.js` | RD-03 (require inside function) |
| `lib/constants.js` | LOG-07 (version mismatch), SEC-03 (new rate limit entries), SEC-08 (CSP hardened) |
| `lib/manifest.js` | LOG-04 (in-flight map no limit) |
| `lib/circuit-breaker.js` | LOG-05 (non-atomic state transitions) |
| `lib/scraper.js` | LOG-03 (require inside function) |

### Files Unchanged (4 files)

These files required no modifications: `cache.js`, `logger.js`, `template.js`, `openapi.json`

### Critical Fixes

1. **SEC-01**: ENCRYPTION_KEY is now required at startup — no hardcoded fallback
2. **SEC-02**: CORS uses exact hostname comparison instead of substring `.includes()`
3. **PERF-01**: Metrics registry has cardinality limits and path sanitization
4. **SEC-04**: Tokens expire after 90 days
5. **SEC-05**: TMDB API key is NEVER in URL query string (always in Authorization header)

### Deployment Note

You **must** set the `ENCRYPTION_KEY` environment variable before deploying:

```bash
# Generate a secure key (run once)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Set it in Vercel
vercel env add ENCRYPTION_KEY
```

Existing tokens encrypted with the old default key will become invalid after deployment.
Users will need to regenerate their install links.
