// ============================================================
// Tests: Config Store
// Tests encrypted stateless token-based config storage
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { saveConfig, getConfig, parseConfig, normalizeConfig } from '../lib/config-store.js';

describe('Config Store', () => {
    beforeEach(() => {
        // Reset internal state between tests by importing fresh
        // Note: The new implementation uses encrypted tokens, no server-side state
    });

    describe('saveConfig', () => {
        it('should save config and return an encrypted token', () => {
            const result = saveConfig({
                tmdbApiKey: 'test-key-123',
                country: 'Global'
            }, 'https://example.com');

            expect(result.token).toBeDefined();
            // Encrypted tokens are longer than 50 chars
            expect(result.token.length).toBeGreaterThan(50);
            expect(result.manifestUrl).toMatch(/\/.+\/manifest\.json$/);
            expect(result.installUrl).toMatch(/^stremio:\/\//);
        });

        it('should store config retrievable by token', () => {
            const result = saveConfig({
                tmdbApiKey: 'my-secret-key',
                rpdbApiKey: 'rpdb-key',
                country: 'Japan,Brazil',
                movieType: 'films'
            }, 'https://example.com');

            const config = getConfig(result.token);
            expect(config.tmdbApiKey).toBe('my-secret-key');
            expect(config.rpdbApiKey).toBe('rpdb-key');
            expect(config.country).toBe('Japan,Brazil');
            expect(config.movieType).toBe('films');
        });

        it('should NOT expose API key in plaintext in the token', () => {
            const result = saveConfig({
                tmdbApiKey: 'super-secret-key-12345',
                country: 'Global'
            }, 'https://example.com');

            // Token should NOT contain the API key in plaintext
            expect(result.token).not.toContain('super-secret');
            expect(result.token).not.toContain('secret-key');
            // Token should be URL-safe base64
            expect(result.token).toMatch(/^[A-Za-z0-9._~-]+$/);
        });

        it('should work across different invocations (stateless)', () => {
            const result = saveConfig({
                tmdbApiKey: 'test-api-key-12345',
                country: 'United States'
            }, 'https://example.com');

            // Simulate a "new" invocation by getting the config again
            const config = getConfig(result.token);
            expect(config).not.toBeNull();
            expect(config.tmdbApiKey).toBe('test-api-key-12345');
            expect(config.country).toBe('United States');
        });
    });

    describe('getConfig', () => {
        it('should return null for invalid tokens', () => {
            const config = getConfig('invalid-token');
            expect(config).toBeNull();
        });

        it('should return null for malformed encrypted data', () => {
            const config = getConfig('not-valid-base64-chars!!!');
            expect(config).toBeNull();
        });
    });

    describe('parseConfig (legacy backward compat)', () => {
        it('should parse a valid legacy config string', () => {
            const config = {
                tmdbApiKey: 'test-key',
                country: 'Japan,Brazil',
                movieType: 'films',
                seriesType: 'tvshows'
            };
            const encoded = encodeURIComponent(JSON.stringify(config));
            const result = parseConfig(encoded);

            expect(result.tmdbApiKey).toBe('test-key');
            expect(result.multiCountries).toEqual(['Japan', 'Brazil']);
            expect(result.movieType).toBe('films');
            expect(result.seriesType).toBe('tvshows');
        });

        it('should return null for empty API key', () => {
            const config = { tmdbApiKey: '', country: 'Global' };
            const encoded = encodeURIComponent(JSON.stringify(config));
            expect(parseConfig(encoded)).toBeNull();
        });

        it('should return null for invalid JSON', () => {
            expect(parseConfig('not-json')).toBeNull();
        });

        it('should default to Global when no country specified', () => {
            const config = { tmdbApiKey: 'key' };
            const encoded = encodeURIComponent(JSON.stringify(config));
            const result = parseConfig(encoded);
            expect(result.country).toBe('Global');
            expect(result.multiCountries).toEqual(['Global']);
        });
    });

    describe('normalizeConfig', () => {
        it('should normalize a raw config object', () => {
            const result = normalizeConfig({
                tmdbApiKey: '  key123  ',
                rpdbApiKey: '  rpdb  ',
                country: ' Japan , Brazil ',
                movieType: ' films ',
                seriesType: '  '
            });

            expect(result.tmdbApiKey).toBe('key123');
            expect(result.rpdbApiKey).toBe('rpdb');
            expect(result.multiCountries).toEqual(['Japan', 'Brazil']);
            expect(result.country).toBe('Japan');
            expect(result.movieType).toBe('films');
            expect(result.seriesType).toBe('series'); // defaults
        });

        it('should return null for missing API key', () => {
            expect(normalizeConfig({})).toBeNull();
            expect(normalizeConfig(null)).toBeNull();
            expect(normalizeConfig({ tmdbApiKey: '  ' })).toBeNull();
        });
    });

    describe('Encryption/Decryption', () => {
        it('should produce different tokens for same config (random IV)', () => {
            const config = { tmdbApiKey: 'test-key', country: 'Global' };
            
            const result1 = saveConfig(config, 'https://example.com');
            const result2 = saveConfig(config, 'https://example.com');
            
            // Tokens should be different due to random IV
            expect(result1.token).not.toBe(result2.token);
            
            // But both should decrypt to the same config
            const config1 = getConfig(result1.token);
            const config2 = getConfig(result2.token);
            expect(config1.tmdbApiKey).toBe(config2.tmdbApiKey);
            expect(config1.country).toBe(config2.country);
        });

        it('should handle special characters in API keys', () => {
            const result = saveConfig({
                tmdbApiKey: 'key-with-special-chars!@#$%',
                country: 'Global'
            }, 'https://example.com');

            const config = getConfig(result.token);
            expect(config.tmdbApiKey).toBe('key-with-special-chars!@#$%');
        });
    });
});
