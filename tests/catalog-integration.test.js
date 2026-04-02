// ============================================================
// Tests: Catalog Building Integration Tests
// Tests the full manifest -> catalog -> TMDB matching flow
// with mocked FlixPatrol and TMDB API responses
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalFetch = global.fetch;

describe('Catalog Integration Tests', () => {
    let buildManifest, buildCatalog;

    beforeEach(async () => {
        vi.resetModules();
        global.fetch = vi.fn();

        // Set encryption key before importing
        process.env.ENCRYPTION_KEY = 'test-encryption-key-32-chars-minimum-ok!';

        const manifest = await import('../lib/manifest.js');
        buildManifest = manifest.buildManifest;
        buildCatalog = manifest.buildCatalog;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    // Helper to build mock HTML
    const mockFlixPatrolHtml = (titles) => `
        <html><body>
            <div class="card">
                <h3>TOP 10 Movies</h3>
                <table>
                    ${titles.map(t => `<tr><td><a href="/title/${t.slug}-2024/">${t.title}</a></td></tr>`).join('')}
                </table>
            </div>
        </body></html>
    `;

    const mockTmdbSearch = (title, id) => ({
        results: [{
            id: id || Math.floor(Math.random() * 100000),
            title: title,
            name: title,
            poster_path: '/poster.jpg',
            backdrop_path: '/backdrop.jpg',
            overview: `Overview of ${title}`,
            release_date: '2024-01-15',
            original_title: title,
        }]
    });

    describe('buildManifest', () => {
        it('should include all required Stremio manifest fields', () => {
            const m = buildManifest();
            expect(m.id).toBe('org.stremio.netflixtop10');
            expect(m.version).toBeDefined();
            expect(m.name).toBe('Netflix Top 10');
            expect(m.resources).toEqual(['catalog']);
            expect(m.behaviorHints).toEqual({ configurable: true });
            expect(m.logo).toBeDefined();
            expect(m.config).toBeDefined();
            expect(m.types).toContain('movie');
            expect(m.types).toContain('series');
        });

        it('should create 2 catalogs per country (movie + series)', () => {
            const m = buildManifest('Global', ['Global', 'Japan', 'Brazil', 'Germany']);
            expect(m.catalogs.length).toBe(8);
        });

        it('should handle single country', () => {
            const m = buildManifest('France');
            expect(m.catalogs.length).toBe(2);
            expect(m.catalogs[0].id).toContain('france');
        });

        it('should use correct catalog IDs for each country', () => {
            const countries = ['Global', 'Japan', 'United States', 'South Korea'];
            const m = buildManifest('Global', countries);

            const expectedIds = [
                'netflix_top10_movies_global',
                'netflix_top10_series_global',
                'netflix_top10_movies_japan',
                'netflix_top10_series_japan',
                'netflix_top10_movies_united_states',
                'netflix_top10_series_united_states',
                'netflix_top10_movies_south_korea',
                'netflix_top10_series_south_korea',
            ];

            expect(m.catalogs.map(c => c.id)).toEqual(expectedIds);
        });

        it('should pass through custom type overrides as-is', () => {
            const m = buildManifest('Global', [], 'Films', 'TV Shows');
            expect(m.catalogs[0].type).toBe('Films');
            expect(m.catalogs[1].type).toBe('TV Shows');
            expect(m.types).toContain('Films');
            expect(m.types).toContain('TV Shows');
        });

        it('should deduplicate types', () => {
            const m = buildManifest('Global', [], 'movie', 'movie');
            expect(m.types).toHaveLength(1);
        });

        it('should produce manifest with correct version', () => {
            const m = buildManifest();
            expect(m.version).toBe('3.7.2');
        });
    });

    describe('buildCatalog', () => {
        it('should return movies with correct metadata structure', async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    text: () => Promise.resolve(mockFlixPatrolHtml([
                        { title: 'Test Movie Alpha', slug: 'test-movie-alpha' }
                    ]))
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockTmdbSearch('Test Movie Alpha', 12345))
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ external_ids: { imdb_id: 'tt0012345' } })
                });

            const metas = await buildCatalog('movie', 'netflix_top10_movies_global', 'fake-api-key', null, ['Global']);

            expect(metas.length).toBe(1);
            expect(metas[0].id).toMatch(/^tt\d+$/);
            expect(metas[0].type).toBe('movie');
            expect(metas[0].name).toBe('Test Movie Alpha');
            expect(metas[0].poster).toBeDefined();
        });

        it('should return series for TV catalog', async () => {
            const tvHtml = `
                <html><body>
                    <div class="card">
                        <h3>TOP 10 TV Shows</h3>
                        <table>
                            <tr><td><a href="/title/test-show-beta-2024/">Test Show Beta</a></td></tr>
                        </table>
                    </div>
                </body></html>
            `;

            global.fetch
                .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(tvHtml) })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        results: [{
                            id: 54321, name: 'Test Show Beta', title: 'Test Show Beta',
                            poster_path: '/poster.jpg', backdrop_path: null, overview: '',
                            first_air_date: '2024-03-01', original_name: 'Test Show Beta',
                        }]
                    })
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ external_ids: { imdb_id: 'tt5432100' } })
                });

            const metas = await buildCatalog('series', 'netflix_top10_series_global', 'fake-api-key', null, ['Global']);

            expect(metas.length).toBe(1);
            expect(metas[0].type).toBe('series');
            expect(metas[0].name).toBe('Test Show Beta');
        });

        it('should return empty array when FlixPatrol has no titles', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve('<html><body>No data here</body></html>')
            });

            // Use different catalog ID to avoid cache pollution from other tests
            const metas = await buildCatalog('movie', 'netflix_top10_movies_japan', 'fake-api-key', null, ['Japan']);
            expect(metas).toEqual([]);
        });

        it('should handle country-specific catalogs', async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    text: () => Promise.resolve(mockFlixPatrolHtml([
                        { title: 'French Movie Gamma', slug: 'french-movie-gamma' }
                    ]))
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockTmdbSearch('French Movie Gamma', 99999))
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ external_ids: { imdb_id: 'tt0099999' } })
                });

            const metas = await buildCatalog('movie', 'netflix_top10_movies_france', 'fake-api-key', null, ['France']);
            expect(metas.length).toBe(1);
            expect(metas[0].name).toBe('French Movie Gamma');
        });

        it('should use RPDB poster when API key is provided', async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    text: () => Promise.resolve(mockFlixPatrolHtml([
                        { title: 'Poster Test Delta', slug: 'poster-test-delta' }
                    ]))
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockTmdbSearch('Poster Test Delta', 11111))
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ external_ids: { imdb_id: 'tt1111111' } })
                });

            const metas = await buildCatalog('movie', 'netflix_top10_movies_global', 'fake-api-key', 'rpdb-key-123', ['Global']);
            expect(metas.length).toBe(1);
            expect(metas[0].poster).toContain('ratingposterdb.com');
        });

        it('should filter out null TMDB results', async () => {
            const html = `
                <html><body>
                    <div class="card">
                        <h3>TOP 10 Movies</h3>
                        <table>
                            <tr><td><a href="/title/good-movie-epsilon-2024/">Good Movie Epsilon</a></td></tr>
                            <tr><td><a href="/title/unknown-movie-zeta-2024/">Unknown Movie Zeta</a></td></tr>
                        </table>
                    </div>
                </body></html>
            `;

            global.fetch
                .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(html) })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(mockTmdbSearch('Good Movie Epsilon', 22222))
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ external_ids: { imdb_id: 'tt2222222' } })
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ results: [] })
                });

            // Use different catalog ID to avoid cache pollution from other tests
            const metas = await buildCatalog('movie', 'netflix_top10_movies_brazil', 'fake-api-key', null, ['Brazil']);
            expect(metas.length).toBe(1);
            expect(metas[0].name).toBe('Good Movie Epsilon');
        });
    });
});
