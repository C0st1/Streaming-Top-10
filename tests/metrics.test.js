// ============================================================
// Tests: Metrics Module
// Tests MetricsRegistry, cardinality limits, Prometheus export
// ============================================================

import { describe, it, expect } from 'vitest';
import { MetricsRegistry, MetricType, sanitizePathForMetrics } from '../lib/metrics.js';

describe('MetricsRegistry', () => {
    describe('Counter', () => {
        it('should increment counter by default value (1)', () => {
            const r = new MetricsRegistry({ maxCardinality: 100 });
            r.register('test_counter', MetricType.COUNTER, 'Test counter');
            r.incrementCounter('test_counter');

            const exported = r.export();
            expect(exported).toContain('test_counter 1');
        });

        it('should increment counter by custom value', () => {
            const r = new MetricsRegistry({ maxCardinality: 100 });
            r.register('test_counter', MetricType.COUNTER, 'Test counter');
            r.incrementCounter('test_counter', {}, 5);

            const exported = r.export();
            expect(exported).toContain('test_counter 5');
        });

        it('should track labels on counters', () => {
            const r = new MetricsRegistry({ maxCardinality: 100 });
            r.register('requests', MetricType.COUNTER, 'Requests');
            r.incrementCounter('requests', { method: 'GET', path: '/health' });
            r.incrementCounter('requests', { method: 'POST', path: '/api/save-config' });

            const exported = r.export();
            expect(exported).toContain('method="GET",path="/health"');
            expect(exported).toContain('method="POST",path="/api/save-config"');
        });
    });

    describe('Gauge', () => {
        it('should set gauge value', () => {
            const r = new MetricsRegistry({ maxCardinality: 100 });
            r.register('temperature', MetricType.GAUGE, 'Temperature');
            r.setGauge('temperature', 42.5);

            const exported = r.export();
            expect(exported).toContain('temperature 42.5');
        });

        it('should overwrite gauge value for same labels', () => {
            const r = new MetricsRegistry({ maxCardinality: 100 });
            r.register('temp', MetricType.GAUGE, 'Temp');
            r.setGauge('temp', 10);
            r.setGauge('temp', 20);

            const exported = r.export();
            expect(exported).toContain('temp 20');
            expect(exported).not.toContain('temp 10');
        });
    });

    describe('Histogram', () => {
        it('should observe values and track buckets', () => {
            const r = new MetricsRegistry({ maxCardinality: 100 });
            r.register('duration', MetricType.HISTOGRAM, 'Duration');
            r.observe('duration', 0.5);

            const exported = r.export();
            expect(exported).toContain('duration_count 1');
            expect(exported).toContain('duration_sum 0.5');
        });

        it('should populate correct histogram buckets', () => {
            const r = new MetricsRegistry({ maxCardinality: 100 });
            r.register('latency', MetricType.HISTOGRAM, 'Latency');
            r.observe('latency', 0.01);
            r.observe('latency', 0.1);
            r.observe('latency', 5.0);

            const exported = r.export();
            expect(exported).toContain('latency_count 3');
            expect(exported).toContain('le="0.01"');
            expect(exported).toContain('le="+Inf"');
        });
    });

    describe('Cardinality Limits (PERF-01)', () => {
        it('should drop new counter label combos beyond maxCardinality', () => {
            const r = new MetricsRegistry({ maxCardinality: 3 });
            r.register('requests', MetricType.COUNTER, 'Requests');

            r.incrementCounter('requests', { path: '/a' });
            r.incrementCounter('requests', { path: '/b' });
            r.incrementCounter('requests', { path: '/c' });
            r.incrementCounter('requests', { path: '/d' }); // dropped

            const exported = r.export();
            expect(exported).toContain('path="/a"');
            expect(exported).toContain('path="/b"');
            expect(exported).toContain('path="/c"');
            expect(exported).not.toContain('path="/d"');
        });

        it('should drop new gauge label combos beyond maxCardinality', () => {
            const r = new MetricsRegistry({ maxCardinality: 2 });
            r.register('gauges', MetricType.GAUGE, 'Gauges');

            r.setGauge('gauges', 1, { key: 'k1' });
            r.setGauge('gauges', 2, { key: 'k2' });
            r.setGauge('gauges', 3, { key: 'k3' }); // Should be dropped

            const exported = r.export();
            expect(exported).toContain('key="k1"');
            expect(exported).toContain('key="k2"');
            expect(exported).not.toContain('key="k3"');
        });

        it('should still increment existing labels beyond maxCardinality', () => {
            const r = new MetricsRegistry({ maxCardinality: 2 });
            r.register('counter', MetricType.COUNTER, 'Counter');

            r.incrementCounter('counter', { path: '/a' });
            r.incrementCounter('counter', { path: '/b' });
            r.incrementCounter('counter', { path: '/c' }); // dropped (3rd unique)
            r.incrementCounter('counter', { path: '/a' }); // should still work (existing)

            const exported = r.export();
            // The value for path="/a" should be 2 (incremented twice)
            expect(exported).toContain('counter{path="/a"} 2');
            expect(exported).toContain('counter{path="/b"} 1');
            expect(exported).not.toContain('path="/c"');
        });
    });

    describe('export()', () => {
        it('should produce valid Prometheus text format', () => {
            const r = new MetricsRegistry({ maxCardinality: 100 });
            r.register('http_requests_total', MetricType.COUNTER, 'Total requests');
            r.incrementCounter('http_requests_total', { method: 'GET' });

            const exported = r.export();

            expect(exported).toContain('# HELP http_requests_total Total requests');
            expect(exported).toContain('# TYPE http_requests_total counter');
            expect(exported).toContain('http_requests_total{method="GET"} 1');
        });

        it('should always include version info', () => {
            const r = new MetricsRegistry();
            const exported = r.export();
            expect(exported).toContain('# HELP netflix_top10_version');
            expect(exported).toContain('# TYPE netflix_top10_version gauge');
        });

        it('should handle empty registry gracefully', () => {
            const r = new MetricsRegistry();
            const exported = r.export();
            expect(typeof exported).toBe('string');
            expect(exported.length).toBeGreaterThan(0);
        });
    });

    describe('reset()', () => {
        it('should clear all metrics', () => {
            const r = new MetricsRegistry({ maxCardinality: 100 });
            r.register('counter', MetricType.COUNTER, 'C');
            r.incrementCounter('counter', {}, 42);

            r.reset();
            const exported = r.export();
            expect(exported).not.toContain('counter 42');
        });
    });
});

describe('sanitizePathForMetrics', () => {
    it('should replace long token segments with {token}', () => {
        const token = 'A'.repeat(30);
        expect(sanitizePathForMetrics(`/${token}/manifest.json`)).toBe('/{token}/manifest.json');
        expect(sanitizePathForMetrics(`/${token}/catalog/movie/test.json`)).toBe('/{token}/catalog/movie/test.json');
    });

    it('should not replace short path segments', () => {
        expect(sanitizePathForMetrics('/health')).toBe('/health');
        expect(sanitizePathForMetrics('/api/save-config')).toBe('/api/save-config');
        expect(sanitizePathForMetrics('/short/manifest.json')).toBe('/short/manifest.json');
    });

    it('should handle paths without tokens', () => {
        expect(sanitizePathForMetrics('/')).toBe('/');
        expect(sanitizePathForMetrics('')).toBe('');
        expect(sanitizePathForMetrics('/metrics')).toBe('/metrics');
    });
});
