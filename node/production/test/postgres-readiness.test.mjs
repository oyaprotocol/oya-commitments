import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForPostgres } from '../scripts/postgres-readiness.mjs';

test('PostgreSQL fixture waits through startup connection resets before tests run', async () => {
    const errors = [
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('database is starting'), { code: '57P03' }),
        new Error('Connection terminated unexpectedly'),
        Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    ];
    let probes = 0;
    await waitForPostgres({ async query(sql) {
        assert.equal(sql, 'SELECT 1');
        const error = errors[probes++];
        if (error) throw error;
        return { rows: [{ '?column?': 1 }] };
    } }, { pollIntervalMs: 1 });
    assert.equal(probes, errors.length + 1);
});

test('PostgreSQL fixture does not retry authentication, database, or SQL errors', async () => {
    for (const code of ['28P01', '3D000', '42601']) {
        const error = Object.assign(new Error('Permanent fixture configuration error'), { code });
        let probes = 0;
        await assert.rejects(waitForPostgres({ async query() { probes++; throw error; } }), thrown => thrown === error);
        assert.equal(probes, 1);
    }
});

test('PostgreSQL fixture rejects cancellation during a successful probe', async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('Fixture cancelled'), { code: 'ECONNRESET' });
    let probes = 0;
    await assert.rejects(waitForPostgres({ async query() {
        probes++;
        controller.abort(reason);
    } }, { signal: controller.signal }), error => error === reason);
    assert.equal(probes, 1);
});

test('PostgreSQL fixture rejects success at or beyond the deadline', async t => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    for (const elapsed of [10, 11]) {
        now = 0;
        await assert.rejects(waitForPostgres({ async query() { now = elapsed; } }, { timeoutMs: 10 }),
            /did not become ready before its startup deadline/);
    }
});

test('PostgreSQL fixture does not start a probe after the retry budget expires', async t => {
    const times = [0, 0, 9, 10];
    t.mock.method(performance, 'now', () => times.shift() ?? 10);
    let probes = 0;
    await assert.rejects(waitForPostgres({ async query() {
        if (++probes === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    } }, { timeoutMs: 10, pollIntervalMs: 1 }), /did not become ready before its startup deadline/);
    assert.equal(probes, 1);
});

test('PostgreSQL fixture bounds persistent resets and respects cancellation', async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    await assert.rejects(waitForPostgres({ async query() { throw reset; } }, { timeoutMs: 10, pollIntervalMs: 1 }),
        /did not become ready before its startup deadline/);
    const controller = new AbortController();
    controller.abort(new Error('Fixture cancelled'));
    await assert.rejects(waitForPostgres({ query() { assert.fail('No connection attempt after cancellation'); } },
        { signal: controller.signal }), /Fixture cancelled/);
});
