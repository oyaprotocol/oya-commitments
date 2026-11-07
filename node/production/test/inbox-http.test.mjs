import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createInboxServer } from '../src/inbox/http.mjs';
import { InboxStore } from '../src/inbox/store.mjs';

async function fixture(t) {
    const config = { target: 'test', execution: { mode: 'ipfs' }, leaseMs: 30000 };
    const store = new InboxStore({}, config);
    t.after(() => store.close());
    let calls = 0;
    let fail = false;
    store.locked = async () => { calls++; if (fail) throw new Error('private database details'); return null; };
    const workerToken = randomUUID();
    const server = createInboxServer({ config, workerToken, store });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return {
        store, calls: () => calls, fail: () => { fail = true; },
        async post(route, body, authenticated = true) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${route}`, {
                method: 'POST', headers: { 'content-type': 'application/json',
                    ...(authenticated ? { authorization: `Bearer ${workerToken}` } : {}) },
                body: JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
        },
    };
}

for (const route of ['claim', 'renew', 'checkpoint', 'complete', 'retry']) {
    test(`worker ${route} rejects non-object bodies before accessing the store`, async t => {
        const f = await fixture(t);
        for (const body of [null, [], 'text', 1, true]) {
            assert.deepEqual(await f.post(`worker/${route}`, body),
                { status: 400, body: { error: 'invalid_worker_request' } });
        }
        assert.equal(f.calls(), 0);
    });
}

test('claim requires an execution object, retaining identity conflict and service errors', async t => {
    const f = await fixture(t);
    for (const execution of [undefined, null, [], 'ipfs', 1, true]) {
        assert.deepEqual(await f.post('worker/claim', { target: 'test', execution }),
            { status: 400, body: { error: 'invalid_worker_request' } });
    }
    assert.equal(f.calls(), 0);
    assert.deepEqual(await f.post('worker/claim', { target: 'test', execution: { mode: 'ledger' } }),
        { status: 409, body: { error: 'execution_identity_mismatch' } });
    assert.deepEqual(await f.post('worker/claim', { target: 'other', execution: { mode: 'ipfs' } }),
        { status: 409, body: { error: 'target_mismatch' } });
    assert.deepEqual(await f.post('worker/claim', { target: 'test', execution: { mode: 'ipfs' } }),
        { status: 200, body: { work: null, leaseMs: 30000 } });
    f.fail();
    assert.deepEqual(await f.post('worker/claim', { target: 'test', execution: { mode: 'ipfs' } }),
        { status: 503, body: { error: 'inbox_unavailable' } });
});

test('worker authentication and public signed-job validation keep their precedence', async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.post('worker/claim', null, false),
        { status: 401, body: { error: 'worker_auth_required' } });
    for (const route of ['jobs', 'status']) {
        assert.deepEqual(await f.post(route, null, false),
            { status: 403, body: { error: 'invalid_signed_job' } });
    }
    assert.equal(f.calls(), 0);
});

for (const clockShift of [-3600000, 3600000]) {
    test(`public request budget ignores wall-clock shift ${clockShift}`, async t => {
        let elapsed = 1000;
        let wallTime = 1700000000000;
        t.mock.method(performance, 'now', () => elapsed);
        t.mock.method(Date, 'now', () => wallTime);
        const f = await fixture(t);
        const invalid = { status: 403, body: { error: 'invalid_signed_job' } };
        const limited = { status: 429, body: { error: 'request_limit' } };
        for (let i = 0; i < 240; i++) {
            assert.deepEqual(await f.post(i % 2 ? 'status' : 'jobs', null, false), invalid);
        }
        assert.deepEqual(await f.post('jobs', null, false), limited);
        wallTime += clockShift;
        elapsed += 59999;
        assert.deepEqual(await f.post('status', null, false), limited);
        assert.deepEqual(await f.post('worker/claim', { target: 'test', execution: { mode: 'ipfs' } }),
            { status: 200, body: { work: null, leaseMs: 30000 } });
        elapsed++;
        for (let i = 0; i < 240; i++) {
            assert.deepEqual(await f.post('jobs', null, false), invalid);
        }
        assert.deepEqual(await f.post('status', null, false), limited);
        assert.equal(f.calls(), 1);
    });
}

test('valid worker mutation bodies are forwarded unchanged', async t => {
    const f = await fixture(t);
    const requestId = randomUUID();
    const lease = randomUUID();
    for (const route of ['renew', 'checkpoint', 'complete', 'retry']) {
        const extra = route === 'checkpoint' ? { checkpoint: { cid: 'fixture' } } :
            route === 'complete' ? { result: { status: 'published', cid: 'fixture' } } : {};
        let args;
        f.store[route] = async (...values) => { args = values; return { accepted: true }; };
        assert.deepEqual(await f.post(`worker/${route}`, { requestId, lease, ...extra }),
            { status: 200, body: { accepted: true } });
        assert.deepEqual(args, [requestId, lease, ...Object.values(extra)]);
    }
});
