// ============================================================
// Tests: Logger Module
// Tests structured JSON logging, log levels, and request context
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Logger Module', () => {
    let createLogger, LogLevel;

    beforeEach(async () => {
        vi.resetModules();
        const mod = await import('../lib/logger.js');
        createLogger = mod.createLogger;
        LogLevel = mod.LogLevel;
    });

    describe('createLogger', () => {
        it('should create a logger with all log methods', () => {
            const log = createLogger();
            expect(log.debug).toBeDefined();
            expect(log.info).toBeDefined();
            expect(log.warn).toBeDefined();
            expect(log.error).toBeDefined();
            expect(log.withRequestId).toBeDefined();
            expect(log.getRequestId).toBeDefined();
        });

        it('should return null requestId by default', () => {
            const log = createLogger();
            expect(log.getRequestId()).toBeNull();
        });

        it('should store and return a requestId', () => {
            const log = createLogger('req-123');
            expect(log.getRequestId()).toBe('req-123');
        });

        it('should create child logger with new requestId', () => {
            const log = createLogger('parent-123');
            const child = log.withRequestId('child-456');
            expect(child.getRequestId()).toBe('child-456');
            expect(log.getRequestId()).toBe('parent-123');
        });
    });

    describe('Log Output', () => {
        let consoleSpy;

        beforeEach(() => {
            consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        });
        afterEach(() => {
            consoleSpy.mockRestore();
        });

        it('should output valid JSON', () => {
            const log = createLogger();
            log.info('test message');

            expect(consoleSpy).toHaveBeenCalledTimes(1);
            const output = consoleSpy.mock.calls[0][0];
            const parsed = JSON.parse(output);
            expect(parsed.message).toBe('test message');
            expect(parsed.level).toBe('info');
            expect(parsed.timestamp).toBeDefined();
            expect(parsed.service).toBe('netflix-top10-addon');
            expect(parsed.version).toBeDefined();
        });

        it('should include requestId when set', () => {
            const log = createLogger('req-abc');
            log.info('test');

            const output = consoleSpy.mock.calls[0][0];
            const parsed = JSON.parse(output);
            expect(parsed.requestId).toBe('req-abc');
        });

        it('should include data when provided', () => {
            const log = createLogger();
            log.info('test', { key: 'value', num: 42 });

            const output = consoleSpy.mock.calls[0][0];
            const parsed = JSON.parse(output);
            expect(parsed.data).toEqual({ key: 'value', num: 42 });
        });

        it('should not include data key when data is null', () => {
            const log = createLogger();
            log.info('test', null);

            const output = consoleSpy.mock.calls[0][0];
            const parsed = JSON.parse(output);
            expect(parsed.data).toBeUndefined();
        });

        it('should not include data key when data is empty object', () => {
            const log = createLogger();
            log.info('test', {});

            const output = consoleSpy.mock.calls[0][0];
            const parsed = JSON.parse(output);
            expect(parsed.data).toBeUndefined();
        });
    });

    describe('Log Levels', () => {
        it('should respect log level ordering', () => {
            expect(LogLevel.DEBUG).toBe('debug');
            expect(LogLevel.INFO).toBe('info');
            expect(LogLevel.WARN).toBe('warn');
            expect(LogLevel.ERROR).toBe('error');
        });
    });
});
