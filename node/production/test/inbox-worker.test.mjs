import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runOne, runWorker } from '../src/inbox/worker.mjs';
import { signJob } from '../src/inbox/protocol.mjs';
import { fixture, cid } from './runtime-fixture.mjs';

for (const claimed of [null, false, 0, '', [], {}, { error: 'unexpected' }, { work: false }, { work: 0 }, { work: '' }]) {
    test(`malformed claim ${JSON.stringify(claimed)} reports unavailable, not idle, and recovers`, async () => {
        const controller = new AbortController();
        const state = {};
        const records = [];
        let polls = 0;
        await runWorker({ config: { mode: 'ipfs' }, target: 'test', state, signal: controller.signal, pollIntervalMs: 1,
            api: async path => {
                assert.equal(path, '/v1/worker/claim');
                if (++polls === 1) return claimed;
                controller.abort();
                return { work: null, leaseMs: 3000 };
            },
            log: record => records.push([record.event, state.status]),
        });
        assert.equal(polls, 2);
        assert.deepEqual(records, [
            ['worker_started', undefined], ['inbox_unavailable', 'inbox_unavailable'],
            ['worker_idle', 'idle'], ['worker_stopped', 'stopped'],
        ]);
    });
}

for (const event of ['job_claimed', 'ipfs_published', 'job_result', 'job_retry']) {
    test(`throwing ${event} logger cannot change job processing or leak renewal timers`, async t => {
        const f = await fixture(t);
        const job = await signJob(f.agent, 'test', 'worker logging regression');
        const work = { job, requestId: job.requestId, lease: randomUUID(), attempts: 1, checkpoint: {} };
        const calls = [];
        const records = [];
        const state = {};
        const timers = new Set();
        const start = globalThis.setInterval;
        const stop = globalThis.clearInterval;
        t.mock.method(globalThis, 'setInterval', (...args) => {
            const timer = start(...args); timers.add(timer); return timer;
        });
        t.mock.method(globalThis, 'clearInterval', timer => { timers.delete(timer); stop(timer); });
        t.after(() => { for (const timer of timers) stop(timer); });
        const fail = event === 'job_retry';
        f.state.ipfsFailure = fail;
        const api = async (path, body) => {
            calls.push({ path, body });
            if (path.endsWith('/claim')) return { work, leaseMs: 3000 };
            return {};
        };
        assert.equal(await runOne({ api, config: { ...f.config, mode: 'ipfs' }, target: 'test',
            allowedSigners: [f.agent.address], fetch: f.transport, state,
            log: record => { records.push(record); if (record.event === event) throw new Error('log sink failed'); } }), true);
        assert.equal(timers.size, 0);
        assert.equal(Object.hasOwn(state, 'requestId'), false);
        assert.equal(state.status, fail ? 'retrying' : 'idle');
        assert.equal(state.completed ?? 0, fail ? 0 : 1);
        assert.equal(f.state.uploads, 1);
        assert.equal(records.filter(record => record.event === event).length, 1);
        assert.deepEqual(calls.map(call => call.path), fail
            ? ['/v1/worker/claim', '/v1/worker/retry']
            : ['/v1/worker/claim', '/v1/worker/checkpoint', '/v1/worker/complete']);
        if (!fail) {
            assert.deepEqual(calls[1].body.checkpoint, { cid });
            assert.deepEqual(calls[2].body.result, { status: 'published', cid });
            assert.deepEqual(state.lastResult, calls[2].body.result);
        }
    });
}

for (const event of ['worker_started', 'worker_idle', 'inbox_unavailable', 'worker_stopped']) {
    test(`throwing ${event} logger cannot stop polling or shutdown`, async () => {
        const controller = new AbortController();
        const state = {};
        const events = [];
        let polls = 0;
        await runWorker({ config: { mode: 'ipfs' }, target: 'test', state, signal: controller.signal, pollIntervalMs: 1,
            api: async () => {
                if (++polls === 1) return { work: null };
                controller.abort();
                throw new Error('inbox disconnected');
            },
            log: record => { events.push(record.event); if (record.event === event) throw new Error('log sink failed'); },
        });
        assert.equal(polls, 2);
        assert.equal(state.status, 'stopped');
        assert.deepEqual(events, ['worker_started', 'worker_idle', 'inbox_unavailable', 'worker_stopped']);
    });
}
