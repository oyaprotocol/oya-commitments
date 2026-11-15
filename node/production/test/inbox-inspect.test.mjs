import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createInboxServer } from '../src/inbox/http.mjs';
import { inspectQueue, readWorkerToken, validateInspection } from '../src/inbox/inspection.mjs';

const execute = promisify(execFile);
const workerToken = randomBytes(32).toString('base64url');
const config = { target: 'inspection-test', execution: { mode: 'ipfs' }, leaseMs: 30000, maxJobs: 10 };
const snapshot = () => ({ target: config.target, observedAt: new Date().toISOString(),
    capacity: { maxJobs: 10, retainedJobs: 0, availableJobs: 10 },
    counts: { queued: 0, processing: 0, published: 0, logged: 0, failed: 0, expired: 0 },
    queued: { ready: 0, expiredPendingSweep: 0, oldestCreatedAt: null }, head: null });
async function listen(t, server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t) {
    let calls = 0;
    const store = { inspect: async () => { calls++; return snapshot(); }, renew: async () => ({ renewed: true }) };
    const url = await listen(t, createInboxServer({ config, workerToken, store }));
    return { store, url, calls: () => calls,
        async post(body = { target: config.target }, credential = workerToken, route = 'inspect') {
            const response = await fetch(`${url}/v1/worker/${route}`, { method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }, body: JSON.stringify(body) });
            return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
        } };
}

test('inspection authenticates and binds exact target before accessing storage', async t => {
    const f = await fixture(t);
    for (const credential of ['', 'wrong', workerToken.slice(1) + 'x']) {
        assert.equal((await f.post({ target: config.target }, credential)).status, 401);
    }
    for (const body of [null, [], {}, { target: config.target, execution: {} }, { target: config.target, limit: 1 }]) {
        assert.equal((await f.post(body)).status, 400);
    }
    assert.equal((await f.post({ target: 'other' })).status, 409);
    assert.equal(f.calls(), 0);
    const result = await f.post();
    assert.equal(result.status, 200);
    assert.equal(result.cache, 'no-store');
    assert.equal(validateInspection(result.body, config.target), result.body);
    assert.equal(f.calls(), 1);
});

test('one inspection in flight leaves worker routes usable and clears after failure', async t => {
    const f = await fixture(t);
    let reject;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    f.store.inspect = () => { entered(); return new Promise((_, fail) => { reject = fail; }); };
    const pending = f.post();
    await started;
    assert.deepEqual((await f.post()).body, { error: 'inspection_busy' });
    assert.equal((await f.post({}, workerToken, 'renew')).status, 200);
    reject(new Error('secret database connection details'));
    assert.deepEqual((await pending).body, { error: 'inbox_unavailable' });
    f.store.inspect = async () => snapshot();
    assert.equal((await f.post()).status, 200);
    assert.equal((await f.post()).status, 200);
});

for (const failAt of [null, 'BEGIN', 'SET LOCAL', 'WITH jobs', 'COMMIT']) {
    test(`inspection transaction cleans up after ${failAt ?? 'success'}`, async () => {
        const calls = [];
        let released;
        const client = { query: async (sql, params) => {
            calls.push(sql);
            if (failAt && sql.startsWith(failAt)) throw new Error('query failed');
            if (sql.startsWith('WITH')) { assert.deepEqual(params, [config.target, 10]); return { rows: [{ snapshot: snapshot() }] }; }
        }, release: broken => { released = broken; } };
        const promise = inspectQueue({ connect: async () => client }, config);
        if (failAt) { await assert.rejects(promise, /query failed/); assert.equal(calls.at(-1), 'ROLLBACK'); }
        else { validateInspection(await promise, config.target); assert.equal(calls.at(-1), 'COMMIT'); }
        assert.equal(calls[0], 'BEGIN READ ONLY');
        if (failAt !== 'BEGIN') assert.equal(calls[1], "SET LOCAL statement_timeout = '2s'");
        assert.equal(released, false);
    });
}

test('failed rollback destroys the connection; failed acquisition does not release a nonexistent client', async () => {
    let released;
    await assert.rejects(inspectQueue({ connect: async () => ({ query: async () => { throw new Error('failure'); },
        release: broken => { released = broken; } }) }, config), /failure/);
    assert.equal(released, true);
    await assert.rejects(inspectQueue({ connect: async () => { throw new Error('connect failure'); } }, config), /connect failure/);
});

test('inspection response validator rejects inconsistent and unexpected remote data', () => {
    validateInspection(snapshot(), config.target);
    for (const alter of [s => { s.secret = 'private'; }, s => { s.target = 'other'; },
        s => { s.capacity.availableJobs = 99; }, s => { s.counts.queued = 1; },
        s => { s.queued.ready = 1; }, s => { s.observedAt = 'remote error'; },
        s => { s.head = {}; }, s => { s.queued.oldestCreatedAt = 'private'; }]) {
        const value = snapshot(); alter(value); assert.throws(() => validateInspection(value, config.target), /Invalid inspection/);
    }
});

test('bounded token file permits newline and rejects malformed, oversized and missing inputs', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'oya-inspection-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'token');
    for (const value of [workerToken, workerToken + '\n', 'a'.repeat(128) + '\r\n']) {
        await writeFile(path, value, { mode: 0o600 });
        assert.equal(await readWorkerToken(path), value.trim());
    }
    for (const value of ['', 'short', 'a'.repeat(129), 'a'.repeat(1024), workerToken + '\nother']) {
        await writeFile(path, value);
        await assert.rejects(readWorkerToken(path));
    }
    await assert.rejects(readWorkerToken(join(dir, 'missing')));
    await assert.rejects(readWorkerToken(dir));
});

test('real CLI inspects without signing material and fails safely before retrying successfully', async t => {
    const f = await fixture(t);
    const dir = await mkdtemp(join(tmpdir(), 'oya-inspection-cli-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const tokenFile = join(dir, 'token');
    await writeFile(tokenFile, workerToken + '\n', { mode: 0o600 });
    const cli = new URL('../src/inbox/client.mjs', import.meta.url).pathname;
    const run = (url = f.url, target = config.target, path = tokenFile) => execute(process.execPath,
        [cli, 'inspect', url, target, path], { timeout: 15000,
            env: { PATH: process.env.PATH, HOME: dir, TMPDIR: tmpdir() } });
    const good = await run();
    assert.equal(good.stderr, '');
    validateInspection(JSON.parse(good.stdout), config.target);
    f.store.inspect = async () => { throw new Error(workerToken); };
    await assert.rejects(run(), error => {
        assert.equal(error.code, 1); assert.equal(error.stdout, '');
        assert.match(error.stderr, /HTTP 503/); assert.ok(!error.stderr.includes(workerToken)); return true;
    });
    for (const args of [[f.url, 'other'], [f.url, config.target, join(dir, 'missing')],
        ['http://example.org'], [f.url + '/unexpected']]) {
        await assert.rejects(run(...args), error => error.code === 1 && error.stdout === '' && !error.stderr.includes(workerToken));
    }
    f.store.inspect = async () => snapshot();
    validateInspection(JSON.parse((await run()).stdout), config.target);
});

test('CLI refuses redirects, oversized bodies and arbitrary remote output', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'oya-inspection-remote-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const tokenFile = join(dir, 'token');
    await writeFile(tokenFile, workerToken, { mode: 0o600 });
    let mode = 'redirect';
    const requests = [];
    const url = await listen(t, createServer((request, response) => {
        requests.push(request.url);
        request.resume();
        if (mode === 'redirect') { response.writeHead(302, { location: '/leak' }); response.end(); }
        else if (mode === 'large') response.end('x'.repeat(131073));
        else response.end(JSON.stringify({ secret: workerToken }));
    }));
    for (mode of ['redirect', 'large', 'arbitrary']) {
        await assert.rejects(execute(process.execPath, [new URL('../src/inbox/client.mjs', import.meta.url).pathname,
            'inspect', url, config.target, tokenFile], { timeout: 15000 }), error => {
            assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert.ok(!error.stderr.includes(workerToken)); return true;
        });
    }
    assert.deepEqual(requests, Array(3).fill('/v1/worker/inspect'));
});
