// ============================================================
// Tests: Integration Tests
// Tests the full request flow without external dependencies
// FIX: Sets ENCRYPTION_KEY env before importing API handler
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// FIX: Set ENCRYPTION_KEY BEFORE any import that triggers config-store.js
process.env.ENCRYPTION_KEY = 'test-encryption-key-32-chars-minimum-ok!';

// Mock external dependencies
const originalFetch = global.fetch;

describe('Integration Tests', () => {
    let handler;

    beforeEach(async () => {
        vi.resetModules();
        global.fetch = vi.fn();
        // Re-import handler with fresh modules
        handler = (await import('../api/index.js')).default;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    function makeReqRes(method, url, body = null, extraHeaders = {}) {
        const req = {
            method,
            url,
            headers: { host: 'localhost:3000', ...extraHeaders },
            body,
            socket: { remoteAddress: '127.0.0.1' },
        };

        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
            send: vi.fn().mockReturnThis(),
            end: vi.fn().mockReturnThis(),
            setHeader: vi.fn().mockReturnThis(),
            headers: {},
        };
        res.req = req;
        return { req, res };
    }

    describe('Health Check Endpoint', () => {
        it('should return healthy status', async () => {
            const { res } = makeReqRes('GET', '/health');

            await handler({ ...makeReqRes('GET', '/health').req }, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                status: expect.stringMatching(/^(ok|degraded)$/),
                type: 'flixpatrol_scraper',
                version: expect.any(String),
            }));
        });

        it('should include rate limit information', async () => {
            const { req, res } = makeReqRes('GET', '/health');
            await handler(req, res);

            const jsonCall = res.json.mock.calls[0][0];
            expect(jsonCall.rateLimits).toBeDefined();
            expect(jsonCall.rateLimits.api).toBeDefined();
            expect(jsonCall.rateLimits.catalog).toBeDefined();
        });
    });

    describe('Metrics Endpoint', () => {
        it('should return Prometheus-compatible metrics', async () => {
            const { req, res } = makeReqRes('GET', '/metrics');
            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; version=0.0.4');
        });
    });

    describe('Configuration Page', () => {
        it('should return HTML for root path', async () => {
            const { req, res } = makeReqRes('GET', '/');
            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html;charset=UTF-8');
        });

        it('should return HTML for /configure path', async () => {
            const { req, res } = makeReqRes('GET', '/configure');
            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalled();
            const html = res.send.mock.calls[0][0];
            expect(html).toContain('<!DOCTYPE html>');
        });
    });

    describe('CORS Preflight', () => {
        it('should handle OPTIONS requests', async () => {
            const { req, res } = makeReqRes('OPTIONS', '/any-path');
            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Max-Age', '86400');
        });
    });

    describe('Save Config Endpoint', () => {
        it('should reject missing API key', async () => {
            const { req, res } = makeReqRes('POST', '/api/save-config', {});
            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                error: expect.stringContaining('API key'),
            }));
        });

        it('should reject invalid API key format', async () => {
            const { req, res } = makeReqRes('POST', '/api/save-config', { tmdbApiKey: 'short' });
            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                error: expect.stringContaining('Invalid'),
            }));
        });

        it('should save valid configuration', async () => {
            const { req, res } = makeReqRes('POST', '/api/save-config', {
                tmdbApiKey: 'validapikey12345678901234567890',
                country: 'Global',
            }, { 'x-forwarded-proto': 'https' });

            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                token: expect.any(String),
                manifestUrl: expect.any(String),
                installUrl: expect.any(String),
            }));
        });
    });

    describe('Manifest Endpoint', () => {
        it('should reject invalid token format', async () => {
            const { req, res } = makeReqRes('GET', '/invalid-token/manifest.json');
            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                error: 'Invalid token format',
            }));
        });

        it('should return 404 for non-existent token', async () => {
            const validToken = 'A'.repeat(32);
            const { req, res } = makeReqRes('GET', `/${validToken}/manifest.json`);
            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    describe('Request ID', () => {
        it('should include request ID in response headers', async () => {
            const { req, res } = makeReqRes('GET', '/');
            await handler(req, res);

            const requestIdCalls = res.setHeader.mock.calls.filter(
                call => call[0] === 'X-Request-Id'
            );
            expect(requestIdCalls.length).toBeGreaterThan(0);
            expect(requestIdCalls[0][1]).toMatch(/^[A-Za-z0-9]+$/);
        });
    });

    describe('Security Headers', () => {
        it('should set security headers on all responses', async () => {
            const { req, res } = makeReqRes('GET', '/health');
            await handler(req, res);

            const headerNames = res.setHeader.mock.calls.map(call => call[0]);
            expect(headerNames).toContain('X-Content-Type-Options');
            expect(headerNames).toContain('X-Frame-Options');
            expect(headerNames).toContain('X-XSS-Protection');
        });
    });

    describe('404 Handler', () => {
        it('should return 404 for unknown paths', async () => {
            const { req, res } = makeReqRes('GET', '/unknown-path-12345');
            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.send).toHaveBeenCalledWith('Not Found');
        });
    });
});
