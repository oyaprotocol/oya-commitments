import { setTimeout as delay } from 'node:timers/promises';

const startupCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P03']);
const startupMessages = new Set([
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
]);

// Test-fixture readiness only: callers bound connection/query duration on the pool.
// Probe through the same published TCP endpoint and credentials as the actual tests.
export async function waitForPostgres(pool, { timeoutMs = 30000, pollIntervalMs = 200, signal } = {}) {
    const deadline = performance.now() + timeoutMs;
    while (true) {
        signal?.throwIfAborted();
        try {
            await pool.query('SELECT 1');
            return;
        } catch (error) {
            if (!startupCodes.has(error.code) && !startupMessages.has(error.message)) throw error;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error('PostgreSQL fixture did not become ready before its startup deadline.');
        await delay(Math.min(pollIntervalMs, remaining), undefined, { signal });
    }
}
