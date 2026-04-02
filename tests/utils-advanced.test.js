// ============================================================
// Tests: All Utility Functions
// Tests fetchWithTimeout, pMap, isValidSlug, isValidApiKeyFormat,
// sanitizeTypeString, validateTypeOverride, and all slug mappings
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('fetchWithTimeout', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        global.fetch = vi.fn();
    });
    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('should call fetch with abort signal', async () => {
        const { fetchWithTimeout } = await import('../lib/utils.js');
        global.fetch.mockResolvedValue({ ok: true });

        await fetchWithTimeout('https://example.com', {}, 5000);

        expect(global.fetch).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({
                signal: expect.any(AbortSignal),
            })
        );
    });

    it('should pass through options', async () => {
        const { fetchWithTimeout } = await import('../lib/utils.js');
        global.fetch.mockResolvedValue({ ok: true });

        await fetchWithTimeout('https://example.com', {
            headers: { 'X-Custom': 'test' },
            method: 'POST',
        }, 5000);

        expect(global.fetch).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({
                headers: { 'X-Custom': 'test' },
                method: 'POST',
            })
        );
    });

    it('should return response when successful', async () => {
        const { fetchWithTimeout } = await import('../lib/utils.js');
        const mockRes = { ok: true, status: 200 };
        global.fetch.mockResolvedValue(mockRes);

        const res = await fetchWithTimeout('https://example.com', {}, 5000);
        expect(res).toBe(mockRes);
    });

    it('should throw on timeout', async () => {
        const { fetchWithTimeout } = await import('../lib/utils.js');

        global.fetch.mockImplementation((url, opts) => {
            return new Promise((_, reject) => {
                const id = setTimeout(() => {
                    reject(new DOMException('Aborted', 'AbortError'));
                }, 10);
                // The abort controller should trigger the rejection
                opts.signal.addEventListener('abort', () => {
                    clearTimeout(id);
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });
        });

        await expect(fetchWithTimeout('https://slow.example.com', {}, 50)).rejects.toThrow();
    }, 10000);

    it('should clear timeout after successful fetch', async () => {
        const { fetchWithTimeout } = await import('../lib/utils.js');
        const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
        global.fetch.mockResolvedValue({ ok: true });

        await fetchWithTimeout('https://example.com', {}, 5000);
        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
    });
});

describe('pMap', () => {
    it('should map items with concurrency limit', async () => {
        const { pMap } = await import('../lib/utils.js');

        const items = [1, 2, 3, 4, 5];
        const results = await pMap(items, async (x) => x * 2, 2);

        expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it('should respect concurrency limit', async () => {
        const { pMap } = await import('../lib/utils.js');

        let concurrent = 0;
        let maxConcurrent = 0;

        const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        await pMap(items, async (x) => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise(r => setTimeout(r, 10));
            concurrent--;
            return x;
        }, 3);

        expect(maxConcurrent).toBeLessThanOrEqual(3);
    });

    it('should handle empty array', async () => {
        const { pMap } = await import('../lib/utils.js');
        const results = await pMap([], async (x) => x * 2, 3);
        expect(results).toEqual([]);
    });

    it('should handle errors in individual items', async () => {
        const { pMap } = await import('../lib/utils.js');

        await expect(
            pMap([1, 2, 3], async (x) => {
                if (x === 2) throw new Error('fail');
                return x;
            }, 2)
        ).rejects.toThrow('fail');
    });
});

describe('isValidSlug', () => {
    it('should accept valid slugs', async () => {
        const { isValidSlug } = await import('../lib/utils.js');
        expect(isValidSlug('united-states')).toBe(true);
        expect(isValidSlug('global')).toBe(true);
        expect(isValidSlug('south_korea')).toBe(true);
        expect(isValidSlug('a')).toBe(true);
        expect(isValidSlug('a-b_c')).toBe(true);
    });

    it('should reject invalid slugs', async () => {
        const { isValidSlug } = await import('../lib/utils.js');
        expect(isValidSlug('')).toBe(false);
        expect(isValidSlug('../etc/passwd')).toBe(false);
        expect(isValidSlug('has space')).toBe(false);
        expect(isValidSlug('has.camels')).toBe(false); // dots NOT in regex
        expect(isValidSlug('<script>')).toBe(false);
        expect(isValidSlug('a'.repeat(101))).toBe(false); // too long
    });

    it('should reject non-string inputs', async () => {
        const { isValidSlug } = await import('../lib/utils.js');
        expect(isValidSlug(null)).toBe(false);
        expect(isValidSlug(undefined)).toBe(false);
        expect(isValidSlug(123)).toBe(false);
    });
});

describe('isValidApiKeyFormat', () => {
    it('should accept valid API key formats', async () => {
        const { isValidApiKeyFormat } = await import('../lib/utils.js');
        expect(isValidApiKeyFormat('abc123def456abc123def456abc123')).toBe(true); // 32 chars
        expect(isValidApiKeyFormat('valid_key-with-dashes')).toBe(true);
        expect(isValidApiKeyFormat('a'.repeat(20))).toBe(true);
        expect(isValidApiKeyFormat('a'.repeat(200))).toBe(true);
    });

    it('should reject invalid API key formats', async () => {
        const { isValidApiKeyFormat } = await import('../lib/utils.js');
        expect(isValidApiKeyFormat('')).toBe(false);
        expect(isValidApiKeyFormat('short')).toBe(false);
        expect(isValidApiKeyFormat('a'.repeat(19))).toBe(false); // too short
        expect(isValidApiKeyFormat('a'.repeat(201))).toBe(false); // too long
        expect(isValidApiKeyFormat('key with spaces')).toBe(false);
        expect(isValidApiKeyFormat('key@invalid!chars')).toBe(false);
        expect(isValidApiKeyFormat(null)).toBe(false);
        expect(isValidApiKeyFormat(12345)).toBe(false);
    });

    it('should trim before validation', async () => {
        const { isValidApiKeyFormat } = await import('../lib/utils.js');
        expect(isValidApiKeyFormat('  validkey123456789012  ')).toBe(true);
    });
});

describe('sanitizeTypeString', () => {
    it('should sanitize valid type strings', async () => {
        const { sanitizeTypeString } = await import('../lib/utils.js');
        expect(sanitizeTypeString('Films')).toBe('Films');
        expect(sanitizeTypeString('TV Shows')).toBe('TV Shows');
        expect(sanitizeTypeString('  anime  ')).toBe('anime');
    });

    it('should remove special characters', async () => {
        const { sanitizeTypeString } = await import('../lib/utils.js');
        expect(sanitizeTypeString('films<script>')).toBe('filmsscript');
        expect(sanitizeTypeString('type@#$')).toBe('type');
    });

    it('should enforce max length of 50', async () => {
        const { sanitizeTypeString } = await import('../lib/utils.js');
        const long = 'a'.repeat(60);
        expect(sanitizeTypeString(long).length).toBe(50);
    });

    it('should handle non-string inputs', async () => {
        const { sanitizeTypeString } = await import('../lib/utils.js');
        expect(sanitizeTypeString(null)).toBe('');
        expect(sanitizeTypeString(undefined)).toBe('');
        expect(sanitizeTypeString(123)).toBe('');
    });
});

describe('Country Slug Mapping (All Countries)', () => {
    it('should correctly map every FlixPatrol country to a valid slug', async () => {
        const { getFlixPatrolSlug } = await import('../lib/utils.js');
        const { FLIXPATROL_COUNTRIES } = await import('../lib/constants.js');

        // Every defined country should produce a valid slug
        for (const country of FLIXPATROL_COUNTRIES) {
            const slug = getFlixPatrolSlug(country);
            expect(slug).toMatch(/^[a-z0-9-]+$/);
            expect(slug.length).toBeGreaterThan(0);
        }
    });

    it('should map Global to world', async () => {
        const { getFlixPatrolSlug } = await import('../lib/utils.js');
        expect(getFlixPatrolSlug('Global')).toBe('world');
        expect(getFlixPatrolSlug('global')).toBe('world');
        expect(getFlixPatrolSlug('Worldwide')).toBe('world');
        expect(getFlixPatrolSlug('WORLDWIDE')).toBe('world');
    });

    it('should produce unique slugs for all countries', async () => {
        const { getFlixPatrolSlug } = await import('../lib/utils.js');
        const { FLIXPATROL_COUNTRIES } = await import('../lib/constants.js');

        const slugs = FLIXPATROL_COUNTRIES.map(c => getFlixPatrolSlug(c));
        const uniqueSlugs = new Set(slugs);
        expect(uniqueSlugs.size).toBe(slugs.length);
    });

    it('should produce correct slugs for specific countries', async () => {
        const { getFlixPatrolSlug } = await import('../lib/utils.js');

        const expectedSlugs = {
            'United States': 'united-states',
            'United Kingdom': 'united-kingdom',
            'South Korea': 'south-korea',
            'New Zealand': 'new-zealand',
            'Trinidad and Tobago': 'trinidad-and-tobago',
            'Czech Republic': 'czech-republic',
            'Dominican Republic': 'dominican-republic',
            'Saudi Arabia': 'saudi-arabia',
            'South Africa': 'south-africa',
            'Hong-Kong': 'hong-kong',
            'Costa Rica': 'costa-rica',
        };

        for (const [country, expected] of Object.entries(expectedSlugs)) {
            expect(getFlixPatrolSlug(country)).toBe(expected);
        }
    });
});

describe('ID Slug Mapping', () => {
    it('should convert countries to underscore slugs', async () => {
        const { toIdSlug } = await import('../lib/utils.js');
        expect(toIdSlug('United States')).toBe('united_states');
        expect(toIdSlug('Global')).toBe('global');
        expect(toIdSlug('South Korea')).toBe('south_korea');
        expect(toIdSlug('Hong-Kong')).toBe('hong_kong');
    });

    it('should produce unique ID slugs for all countries', async () => {
        const { toIdSlug } = await import('../lib/utils.js');
        const { FLIXPATROL_COUNTRIES } = await import('../lib/constants.js');

        const slugs = FLIXPATROL_COUNTRIES.map(c => toIdSlug(c));
        const uniqueSlugs = new Set(slugs);
        expect(uniqueSlugs.size).toBe(slugs.length);
    });
});
