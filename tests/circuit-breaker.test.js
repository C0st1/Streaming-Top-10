// ============================================================
// Tests: Circuit Breaker Module
// Tests state transitions, failure thresholds, and execute guards
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, CircuitState } from '../lib/circuit-breaker.js';

describe('CircuitBreaker', () => {
    describe('Initial State', () => {
        it('should start in CLOSED state', () => {
            const cb = new CircuitBreaker('test');
            expect(cb.state).toBe(CircuitState.CLOSED);
            expect(cb.failureCount).toBe(0);
            expect(cb.successCount).toBe(0);
        });

        it('should allow execution in CLOSED state', () => {
            const cb = new CircuitBreaker('test');
            const check = cb.canExecute();
            expect(check.allowed).toBe(true);
            expect(check.state).toBe(CircuitState.CLOSED);
        });
    });

    describe('State Transitions', () => {
        it('should open after reaching failure threshold', () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 3,
                timeout: 30000,
                monitoringWindow: 60000,
            });

            for (let i = 0; i < 3; i++) {
                cb.recordFailure();
            }

            expect(cb.state).toBe(CircuitState.OPEN);
        });

        it('should block execution when OPEN', () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 2,
                timeout: 30000,
                monitoringWindow: 60000,
            });

            cb.recordFailure();
            cb.recordFailure();

            const check = cb.canExecute();
            expect(check.allowed).toBe(false);
            expect(check.state).toBe(CircuitState.OPEN);
        });

        it('should transition to HALF_OPEN after timeout', async () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 2,
                timeout: 100, // 100ms for fast test
                monitoringWindow: 60000,
            });

            cb.recordFailure();
            cb.recordFailure();
            expect(cb.state).toBe(CircuitState.OPEN);

            // Wait for timeout
            await new Promise(r => setTimeout(r, 150));

            const check = cb.canExecute();
            expect(check.state).toBe(CircuitState.HALF_OPEN);
            expect(check.allowed).toBe(true);
        });

        it('should close after successThreshold successes in HALF_OPEN', () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 2,
                timeout: 0,
                successThreshold: 3,
                monitoringWindow: 60000,
            });

            // Force to open
            cb.recordFailure();
            cb.recordFailure();
            expect(cb.state).toBe(CircuitState.OPEN);

            // Force to half-open (timeout is 0 so should transition)
            cb.canExecute();
            expect(cb.state).toBe(CircuitState.HALF_OPEN);

            // Record successes
            cb.recordSuccess();
            cb.recordSuccess();
            cb.recordSuccess();
            expect(cb.state).toBe(CircuitState.CLOSED);
        });

        it('should go back to OPEN on failure in HALF_OPEN', () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 2,
                timeout: 0,
                monitoringWindow: 60000,
            });

            cb.recordFailure();
            cb.recordFailure();
            cb.canExecute(); // -> HALF_OPEN

            cb.recordFailure();
            expect(cb.state).toBe(CircuitState.OPEN);
        });

        it('should reset failureCount on success', () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 5,
                monitoringWindow: 60000,
            });

            cb.recordFailure();
            cb.recordFailure();
            expect(cb.failureCount).toBe(2);

            cb.recordSuccess();
            expect(cb.failureCount).toBe(0);
        });
    });

    describe('execute()', () => {
        it('should execute function and record success', async () => {
            const cb = new CircuitBreaker('test');
            const fn = vi.fn().mockResolvedValue('result');

            const result = await cb.execute(fn);

            expect(result).toBe('result');
            expect(fn).toHaveBeenCalledTimes(1);
            expect(cb.state).toBe(CircuitState.CLOSED);
        });

        it('should throw when circuit is OPEN', async () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 1,
                timeout: 30000,
                monitoringWindow: 60000,
            });

            cb.recordFailure(); // Opens circuit

            const fn = vi.fn();
            await expect(cb.execute(fn)).rejects.toThrow(/OPEN/);
            expect(fn).not.toHaveBeenCalled();
        });

        it('should record failure and re-throw on function error', async () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 3,
                monitoringWindow: 60000,
            });

            const fn = vi.fn().mockRejectedValue(new Error('fail'));
            await expect(cb.execute(fn)).rejects.toThrow('fail');
            expect(cb.failureCount).toBe(1);
        });
    });

    describe('executeWithFallback()', () => {
        it('should return function result when circuit is CLOSED', async () => {
            const cb = new CircuitBreaker('test');
            const fn = vi.fn().mockResolvedValue('primary');

            const result = await cb.executeWithFallback(fn, () => 'fallback');
            expect(result).toBe('primary');
        });

        it('should return fallback when circuit is OPEN', async () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 1,
                timeout: 30000,
                monitoringWindow: 60000,
            });

            cb.recordFailure();
            const fn = vi.fn();
            const fallback = vi.fn().mockReturnValue('fallback');

            const result = await cb.executeWithFallback(fn, fallback);
            expect(result).toBe('fallback');
            expect(fn).not.toHaveBeenCalled();
            expect(fallback).toHaveBeenCalledTimes(1);
        });

        it('should return fallback when function throws', async () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 3,
                monitoringWindow: 60000,
            });

            const fn = vi.fn().mockRejectedValue(new Error('fail'));
            const fallback = vi.fn().mockReturnValue('fallback');

            const result = await cb.executeWithFallback(fn, fallback);
            expect(result).toBe('fallback');
            expect(cb.failureCount).toBe(1);
        });
    });

    describe('reset()', () => {
        it('should reset to initial state', () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 1,
                monitoringWindow: 60000,
            });

            cb.recordFailure();
            expect(cb.state).toBe(CircuitState.OPEN);

            cb.reset();
            expect(cb.state).toBe(CircuitState.CLOSED);
            expect(cb.failureCount).toBe(0);
            expect(cb.successCount).toBe(0);
            expect(cb.failures).toEqual([]);
            expect(cb.openedAt).toBeNull();
        });
    });

    describe('getStatus()', () => {
        it('should return full status object', () => {
            const cb = new CircuitBreaker('my-service', {
                failureThreshold: 5,
                timeout: 30000,
            });

            const status = cb.getStatus();
            expect(status.name).toBe('my-service');
            expect(status.state).toBe('closed');
            expect(status.failureCount).toBe(0);
            expect(status.successCount).toBe(0);
            expect(status.lastFailureTime).toBeNull();
            expect(status.openedAt).toBeNull();
        });
    });

    describe('Monitoring Window', () => {
        it('should clean up old failures outside monitoring window', async () => {
            const cb = new CircuitBreaker('test', {
                failureThreshold: 3,
                monitoringWindow: 100, // 100ms
            });

            // Record 2 failures
            cb.recordFailure();
            cb.recordFailure();
            expect(cb.failureCount).toBe(2);

            // Wait for monitoring window to expire
            await new Promise(r => setTimeout(r, 150));

            // canExecute cleans old failures
            cb.canExecute();
            expect(cb.failureCount).toBe(0);
        });
    });
});
