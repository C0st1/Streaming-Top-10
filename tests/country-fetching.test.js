// ============================================================
// Tests: Country & Global Fetching
// Verifies that the scraper correctly handles ALL countries,
// validates slug whitelisting, and returns proper data shapes.
// Tests FlixPatrol slug -> URL mapping, HTML parsing, and dedup.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalFetch = global.fetch;

describe('Country & Global Fetching', () => {
    let fetchFlixPatrolTitles, getAvailableCountries;
    let getFlixPatrolSlug;
    let ALLOWED_COUNTRY_SLUGS, FLIXPATROL_COUNTRIES;

    beforeEach(async () => {
        vi.resetModules();
        global.fetch = vi.fn();

        const scraper = await import('../lib/scraper.js');
        fetchFlixPatrolTitles = scraper.fetchFlixPatrolTitles;
        getAvailableCountries = scraper.getAvailableCountries;

        const utils = await import('../lib/utils.js');
        getFlixPatrolSlug = utils.getFlixPatrolSlug;

        const constants = await import('../lib/constants.js');
        ALLOWED_COUNTRY_SLUGS = constants.ALLOWED_COUNTRY_SLUGS;
        FLIXPATROL_COUNTRIES = constants.FLIXPATROL_COUNTRIES;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    describe('Country Slug Whitelist (SEC-11)', () => {
        it('should have all FLIXPATROL_COUNTRIES in the allowed slugs set', () => {
            for (const country of FLIXPATROL_COUNTRIES) {
                const slug = getFlixPatrolSlug(country);
                if (slug === 'world') continue; // 'world' is always allowed
                expect(ALLOWED_COUNTRY_SLUGS.has(slug)).toBe(true);
            }
        });

        it('should reject injection attempts via country slug', async () => {
            const titles = await fetchFlixPatrolTitles('Films', '../../../etc/passwd');
            expect(titles).toEqual([]);
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('should reject SQL injection in country names', async () => {
            const titles = await fetchFlixPatrolTitles('Films', "'; DROP TABLE countries;--");
            expect(titles).toEqual([]);
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('should reject path traversal attempts', async () => {
            const titles = await fetchFlixPatrolTitles('Films', '..%2F..%2Fetc%2Fpasswd');
            expect(titles).toEqual([]);
            expect(global.fetch).not.toHaveBeenCalled();
        });
    });

    describe('URL Construction for All Countries', () => {
        it('should construct correct FlixPatrol URLs for every country', async () => {
            const mockHtml = `
                <html><body>
                    <div class="card">
                        <h3>TOP 10 Movies</h3>
                        <table><tr><td><a href="/title/test-2024/">Test Movie</a></td></tr></table>
                    </div>
                </body></html>
            `;

            // Test a representative sample of countries
            const sampleCountries = [
                'Global', 'United States', 'Japan', 'Brazil', 'Germany',
                'France', 'South Korea', 'India', 'United Kingdom', 'Australia',
                'Trinidad and Tobago', 'New Zealand', 'Czech Republic',
                'Dominican Republic', 'Hong-Kong'
            ];

            for (const country of sampleCountries) {
                vi.resetModules();
                global.fetch = vi.fn();
                global.fetch.mockResolvedValueOnce({
                    ok: true,
                    text: () => Promise.resolve(mockHtml)
                });

                // Re-import to get fresh module with mock
                const scraper = await import('../lib/scraper.js');
                await scraper.fetchFlixPatrolTitles('Films', country);

                const expectedSlug = getFlixPatrolSlug(country);
                expect(global.fetch).toHaveBeenCalledWith(
                    `https://flixpatrol.com/top10/netflix/${expectedSlug}/`,
                    expect.objectContaining({
                        headers: expect.objectContaining({ 'User-Agent': expect.any(String) })
                    })
                );
            }
        });
    });

    describe('Global Fetching', () => {
        const mockGlobalHtml = `
            <html><body>
                <div class="card">
                    <h3>TOP 10 Movies</h3>
                    <table>
                        <tr><td><a href="/title/movie1-2024/">Movie One</a></td></tr>
                        <tr><td><a href="/title/movie2-2023/">Movie Two</a></td></tr>
                        <tr><td><a href="/title/movie3-2024/">Movie Three</a></td></tr>
                        <tr><td><a href="/title/movie4-2023/">Movie Four</a></td></tr>
                        <tr><td><a href="/title/movie5-2024/">Movie Five</a></td></tr>
                        <tr><td><a href="/title/movie6-2023/">Movie Six</a></td></tr>
                        <tr><td><a href="/title/movie7-2024/">Movie Seven</a></td></tr>
                        <tr><td><a href="/title/movie8-2023/">Movie Eight</a></td></tr>
                        <tr><td><a href="/title/movie9-2024/">Movie Nine</a></td></tr>
                        <tr><td><a href="/title/movie10-2023/">Movie Ten</a></td></tr>
                    </table>
                </div>
            </body></html>
        `;

        it('should fetch Global movies', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(mockGlobalHtml)
            });

            const titles = await fetchFlixPatrolTitles('Films', 'Global');

            expect(global.fetch).toHaveBeenCalledWith(
                'https://flixpatrol.com/top10/netflix/world/',
                expect.any(Object)
            );
            expect(titles.length).toBe(10);
            expect(titles[0].title).toBe('Movie One');
            expect(titles[0].year).toBe('2024');
        });

        it('should fetch Global TV shows', async () => {
            const tvHtml = `
                <html><body>
                    <div class="card">
                        <h3>TOP 10 TV Shows</h3>
                        <table>
                            <tr><td><a href="/title/show1-2024/">Show One</a></td></tr>
                            <tr><td><a href="/title/show2-2023/">Show Two</a></td></tr>
                            <tr><td><a href="/title/show3-2024/">Show Three</a></td></tr>
                        </table>
                    </div>
                </body></html>
            `;

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(tvHtml)
            });

            const titles = await fetchFlixPatrolTitles('TV', 'Global');

            expect(titles.length).toBe(3);
            expect(titles[0].title).toBe('Show One');
        });
    });

    describe('Country-Specific Fetching', () => {
        it('should fetch movies for United States', async () => {
            const usHtml = `
                <html><body>
                    <div class="card">
                        <h3>TOP 10 Movies</h3>
                        <table>
                            <tr><td><a href="/title/us-movie-2024/">American Movie</a></td></tr>
                            <tr><td><a href="/title/us-film-2023/">American Film</a></td></tr>
                        </table>
                    </div>
                </body></html>
            `;

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(usHtml)
            });

            const titles = await fetchFlixPatrolTitles('Films', 'United States');

            expect(global.fetch).toHaveBeenCalledWith(
                'https://flixpatrol.com/top10/netflix/united-states/',
                expect.any(Object)
            );
            expect(titles.length).toBe(2);
            expect(titles[0].title).toBe('American Movie');
        });

        it('should fetch TV shows for Japan', async () => {
            const japanHtml = `
                <html><body>
                    <div class="card">
                        <h3>TOP 10 TV Shows</h3>
                        <table>
                            <tr><td><a href="/title/anime1-2024/">Anime Show 1</a></td></tr>
                            <tr><td><a href="/title/drama1-2023/">J-Drama</a></td></tr>
                        </table>
                    </div>
                </body></html>
            `;

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(japanHtml)
            });

            const titles = await fetchFlixPatrolTitles('TV', 'Japan');

            expect(global.fetch).toHaveBeenCalledWith(
                'https://flixpatrol.com/top10/netflix/japan/',
                expect.any(Object)
            );
            expect(titles.length).toBe(2);
        });
    });

    describe('Data Shape Validation', () => {
        it('should return objects with title and year fields', async () => {
            const html = `
                <html><body>
                    <div class="card">
                        <h3>TOP 10 Movies</h3>
                        <table>
                            <tr><td><a href="/title/movie-with-year-2024/">Title</a></td></tr>
                            <tr><td><a href="/title/movie-no-year/">Title No Year</a></td></tr>
                        </table>
                    </div>
                </body></html>
            `;

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(html)
            });

            const titles = await fetchFlixPatrolTitles('Films', 'Global');

            for (const t of titles) {
                expect(t).toHaveProperty('title');
                expect(typeof t.title).toBe('string');
                expect(t.title.length).toBeGreaterThan(0);
                // year can be string or null
                expect(t.year === null || typeof t.year === 'string').toBe(true);
            }
        });

        it('should extract year from href when present', async () => {
            const html = `
                <html><body>
                    <div class="card">
                        <h3>TOP 10 Movies</h3>
                        <table>
                            <tr><td><a href="/title/flick-2024/">Flick</a></td></tr>
                        </table>
                    </div>
                </body></html>
            `;

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(html)
            });

            const titles = await fetchFlixPatrolTitles('Films', 'Global');
            expect(titles[0].year).toBe('2024');
        });

        it('should set year to null when not in href', async () => {
            const html = `
                <html><body>
                    <div class="card">
                        <h3>TOP 10 Movies</h3>
                        <table>
                            <tr><td><a href="/title/some-title/">Some Title</a></td></tr>
                        </table>
                    </div>
                </body></html>
            `;

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(html)
            });

            const titles = await fetchFlixPatrolTitles('Films', 'Global');
            expect(titles[0].year).toBeNull();
        });

        it('should limit results to 10 titles maximum', async () => {
            const manyTitles = Array.from({ length: 15 }, (_, i) =>
                `<tr><td><a href="/title/movie-${i}-2024/">Movie ${i}</a></td></tr>`
            ).join('');

            const html = `
                <html><body>
                    <div class="card">
                        <h3>TOP 10 Movies</h3>
                        <table>${manyTitles}</table>
                    </div>
                </body></html>
            `;

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(html)
            });

            const titles = await fetchFlixPatrolTitles('Films', 'Global');
            expect(titles.length).toBeLessThanOrEqual(10);
        });
    });

    describe('Deduplication', () => {
        it('should remove duplicate titles within same result', async () => {
            const html = `
                <html><body>
                    <div class="card">
                        <h3>TOP 10 Movies</h3>
                        <table>
                            <tr><td><a href="/title/movie-2024/">Same Movie</a></td></tr>
                            <tr><td><a href="/title/movie-2024/">Same Movie</a></td></tr>
                            <tr><td><a href="/title/other-2024/">Other Movie</a></td></tr>
                        </table>
                    </div>
                </body></html>
            `;

            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(html)
            });

            const titles = await fetchFlixPatrolTitles('Films', 'Global');
            const titleNames = titles.map(t => t.title);
            expect(titleNames).toEqual(['Same Movie', 'Other Movie']);
        });
    });

    describe('Error Handling', () => {
        it('should return empty array for HTTP errors', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
            });

            const titles = await fetchFlixPatrolTitles('Films', 'Global');
            expect(titles).toEqual([]);
        });

        it('should return empty array for network errors', async () => {
            global.fetch.mockRejectedValueOnce(new Error('DNS resolution failed'));

            const titles = await fetchFlixPatrolTitles('Films', 'Global');
            expect(titles).toEqual([]);
        });

        it('should return empty array for timeout errors', async () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            global.fetch.mockRejectedValueOnce(err);

            const titles = await fetchFlixPatrolTitles('Films', 'Global');
            expect(titles).toEqual([]);
        });

        it('should return empty array for empty/malformed HTML', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve('<html><body>No data here</body></html>')
            });

            const titles = await fetchFlixPatrolTitles('Films', 'Global');
            expect(titles).toEqual([]);
        });
    });

    describe('getAvailableCountries', () => {
        it('should return the full list of 90+ countries', () => {
            const countries = getAvailableCountries();
            expect(countries.length).toBeGreaterThanOrEqual(90);
        });

        it('should always include Global as first entry', () => {
            const countries = getAvailableCountries();
            expect(countries[0]).toBe('Global');
        });

        it('should include key countries', () => {
            const countries = getAvailableCountries();
            const required = ['United States', 'United Kingdom', 'Japan', 'Brazil', 'India', 'Germany', 'France'];
            for (const c of required) {
                expect(countries).toContain(c);
            }
        });

        it('should return same reference on multiple calls', () => {
            const a = getAvailableCountries();
            const b = getAvailableCountries();
            expect(a).toBe(b);
        });
    });
});
