// ============================================================
// Tests: TMDB Advanced Tests
// Tests TMDB key validation, header construction, API key handling,
// title override matching, and IMDB cache behavior
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalFetch = global.fetch;

describe('TMDB Advanced Tests', () => {
    beforeEach(() => {
        vi.resetModules();
        global.fetch = vi.fn();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    describe('validateTmdbKey', () => {
        it('should validate a working API key', async () => {
            const { validateTmdbKey } = await import('../lib/tmdb.js');

            global.fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
            });

            const result = await validateTmdbKey('valid-key-123');
            expect(result.valid).toBe(true);
            expect(result.message).toBe('Valid API key!');
        });

        it('should reject invalid API key (401)', async () => {
            const { validateTmdbKey } = await import('../lib/tmdb.js');

            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 401,
            });

            const result = await validateTmdbKey('bad-key');
            expect(result.valid).toBe(false);
            expect(result.message).toBe('Unauthorized.');
        });

        it('should handle empty API key', async () => {
            const { validateTmdbKey } = await import('../lib/tmdb.js');

            const result = await validateTmdbKey('');
            expect(result.valid).toBe(false);
            expect(result.message).toContain('empty');
        });

        it('should handle network error', async () => {
            const { validateTmdbKey } = await import('../lib/tmdb.js');

            global.fetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await validateTmdbKey('some-key');
            expect(result.valid).toBe(false);
            expect(result.message).toContain('Network error');
        });

        it('should send API key via Authorization header (SEC-05)', async () => {
            const { validateTmdbKey } = await import('../lib/tmdb.js');

            global.fetch.mockResolvedValueOnce({ ok: true });

            await validateTmdbKey('test-key-123');

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.themoviedb.org/3/configuration',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer test-key-123',
                    })
                })
            );
        });

        it('should NEVER include API key in URL (SEC-05)', async () => {
            const { validateTmdbKey } = await import('../lib/tmdb.js');

            global.fetch.mockResolvedValueOnce({ ok: true });

            await validateTmdbKey('secret-api-key');

            const calledUrl = global.fetch.mock.calls[0][0];
            expect(calledUrl).not.toContain('api_key=');
            expect(calledUrl).not.toContain('secret-api-key');
        });
    });

    describe('matchTMDB', () => {
        it('should return null for missing API key', async () => {
            const { matchTMDB } = await import('../lib/tmdb.js');
            const result = await matchTMDB({ title: 'Test' }, 'movie', '');
            expect(result).toBeNull();
        });

        it('should return null for null API key', async () => {
            const { matchTMDB } = await import('../lib/tmdb.js');
            const result = await matchTMDB({ title: 'Test' }, 'movie', null);
            expect(result).toBeNull();
        });

        it('should return null when TMDB search finds no results', async () => {
            const { matchTMDB } = await import('../lib/tmdb.js');

            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ results: [] }),
            });

            const result = await matchTMDB({ title: 'Nonexistent Movie 999' }, 'movie', 'fake-key');
            expect(result).toBeNull();
        });

        it('should match movie and return meta with IMDB ID', async () => {
            const { matchTMDB } = await import('../lib/tmdb.js');

            global.fetch
                // Search response
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        results: [{
                            id: 12345,
                            title: 'Exact Match Movie',
                            original_title: 'Exact Match Movie',
                            poster_path: '/poster.jpg',
                            backdrop_path: '/backdrop.jpg',
                            overview: 'A great movie',
                            release_date: '2024-01-15',
                        }]
                    }),
                })
                // Details (external_ids)
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        external_ids: { imdb_id: 'tt1234567' }
                    }),
                });

            const result = await matchTMDB({ title: 'Exact Match Movie' }, 'movie', 'fake-key');

            expect(result).not.toBeNull();
            expect(result.id).toBe('tt1234567');
            expect(result.type).toBe('movie');
            expect(result.name).toBe('Exact Match Movie');
            expect(result.tmdbPoster).toBe('https://image.tmdb.org/t/p/w500/poster.jpg');
        });

        it('should match TV show and return series type', async () => {
            const { matchTMDB } = await import('../lib/tmdb.js');

            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        results: [{
                            id: 54321,
                            name: 'Test Show',
                            original_name: 'Test Show',
                            poster_path: null,
                            backdrop_path: null,
                            overview: '',
                            first_air_date: '2024-06-01',
                        }]
                    }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        external_ids: { imdb_id: 'tt9876543' }
                    }),
                });

            const result = await matchTMDB({ title: 'Test Show' }, 'tv', 'fake-key');

            expect(result).not.toBeNull();
            expect(result.type).toBe('series');
            expect(result.id).toBe('tt9876543');
            expect(result.tmdbPoster).toBeNull();
        });

        it('should handle TMDB search failure gracefully', async () => {
            const { matchTMDB } = await import('../lib/tmdb.js');

            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 429,
            });

            const result = await matchTMDB({ title: 'Some Movie' }, 'movie', 'fake-key');
            expect(result).toBeNull();
        });

        it('should prefer exact title match over partial', async () => {
            const { matchTMDB } = await import('../lib/tmdb.js');

            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        results: [
                            { id: 1, title: 'The Dark Knight', original_title: 'The Dark Knight', poster_path: null, backdrop_path: null, overview: '', release_date: '2008' },
                            { id: 2, title: 'Dark Knight', original_title: 'Dark Knight', poster_path: null, backdrop_path: null, overview: '', release_date: '2020' },
                            { id: 3, title: 'The Dark Knight Rises', original_title: 'The Dark Knight Rises', poster_path: null, backdrop_path: null, overview: '', release_date: '2012' },
                        ]
                    }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        external_ids: { imdb_id: 'tt0000001' }
                    }),
                });

            const result = await matchTMDB({ title: 'The Dark Knight' }, 'movie', 'fake-key');
            expect(result.name).toBe('The Dark Knight');
        });

        it('should use year filter when provided', async () => {
            const { matchTMDB } = await import('../lib/tmdb.js');

            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ results: [] }),
            });

            await matchTMDB({ title: 'Some Movie', year: '2024' }, 'movie', 'fake-key');

            const calledUrl = global.fetch.mock.calls[0][0];
            expect(calledUrl).toContain('primary_release_year=2024');
        });

        it('should use first_air_date_year for TV type', async () => {
            const { matchTMDB } = await import('../lib/tmdb.js');

            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ results: [] }),
            });

            await matchTMDB({ title: 'Some Show', year: '2023' }, 'tv', 'fake-key');

            const calledUrl = global.fetch.mock.calls[0][0];
            expect(calledUrl).toContain('first_air_date_year=2023');
        });
    });

    describe('getRpdbPosterUrl', () => {
        it('should return correct RPDB URL', async () => {
            const { getRpdbPosterUrl } = await import('../lib/tmdb.js');
            const url = getRpdbPosterUrl('tt1234567', 'rpdb-key');
            expect(url).toBe('https://api.ratingposterdb.com/rpdb-key/imdb/poster-default/tt1234567.jpg');
        });

        it('should return null for missing RPDB key', async () => {
            const { getRpdbPosterUrl } = await import('../lib/tmdb.js');
            expect(getRpdbPosterUrl('tt1234567', null)).toBeNull();
            expect(getRpdbPosterUrl('tt1234567', '')).toBeNull();
            expect(getRpdbPosterUrl('tt1234567', undefined)).toBeNull();
        });

        it('should return null for non-IMDB IDs', async () => {
            const { getRpdbPosterUrl } = await import('../lib/tmdb.js');
            expect(getRpdbPosterUrl('tmdb:12345', 'rpdb-key')).toBeNull();
            expect(getRpdbPosterUrl('invalid', 'rpdb-key')).toBeNull();
            expect(getRpdbPosterUrl(null, 'rpdb-key')).toBeNull();
        });

        it('should return null for invalid RPDB key format', async () => {
            const { getRpdbPosterUrl } = await import('../lib/tmdb.js');
            expect(getRpdbPosterUrl('tt1234567', 'key with spaces')).toBeNull();
            expect(getRpdbPosterUrl('tt1234567', 'key<script>')).toBeNull();
        });
    });

    describe('formatMeta', () => {
        it('should correctly format movie meta', async () => {
            const { formatMeta } = await import('../lib/tmdb.js');

            const result = formatMeta({
                id: 100,
                title: 'Test Film',
                poster_path: '/p.jpg',
                backdrop_path: '/b.jpg',
                overview: 'Test overview text',
                release_date: '2024-03-15',
            }, 'tt100200', 'movie');

            expect(result).toEqual({
                id: 'tt100200',
                type: 'movie',
                name: 'Test Film',
                tmdbPoster: 'https://image.tmdb.org/t/p/w500/p.jpg',
                background: 'https://image.tmdb.org/t/p/w1280/b.jpg',
                description: 'Test overview text',
                releaseInfo: '2024',
            });
        });

        it('should correctly format TV meta with series type', async () => {
            const { formatMeta } = await import('../lib/tmdb.js');

            const result = formatMeta({
                id: 200,
                name: 'Test Series',
                poster_path: null,
                backdrop_path: null,
                overview: '',
                first_air_date: '2023-11-01',
            }, 'tt200300', 'tv');

            expect(result).toEqual({
                id: 'tt200300',
                type: 'series',
                name: 'Test Series',
                tmdbPoster: null,
                background: null,
                description: '',
                releaseInfo: '2023',
            });
        });

        it('should handle missing all optional fields', async () => {
            const { formatMeta } = await import('../lib/tmdb.js');

            const result = formatMeta({
                id: 1,
                title: 'Minimal',
            }, 'tmdb:1', 'movie');

            expect(result.tmdbPoster).toBeNull();
            expect(result.background).toBeNull();
            expect(result.description).toBe('');
            expect(result.releaseInfo).toBe('');
        });
    });
});
