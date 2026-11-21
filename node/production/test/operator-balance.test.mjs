import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const address = '0x' + 'ab'.repeat(20);
const marker = 'synthetic-private-marker';
const script = fileURLToPath(new URL('../scripts/operator-node.mjs', import.meta.url));
const guard = fileURLToPath(new URL('./operator-guard.mjs', import.meta.url));
const block = '0x123456789abcdef01';
const max = '0x' + 'f'.repeat(64);

async function fixture(t) {
    const dir = await mkdtemp(join(tmpdir(), 'operator-balance-'));
    await chmod(dir, 0o700);
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'profile.json'), configFile = join(dir, 'node.json');
    const requests = [];
    let respond = (request, response) => response.end(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: ['0x1', block, max][request.id - 1] }));
    let health;
    const server = createServer(async (req, res) => {
        if (req.url === '/healthz') {
            assert.equal(req.headers.authorization, undefined);
            res.writeHead(health?.status === 'stopped' ? 503 : 200).end(JSON.stringify(health));
            return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        requests.push({ body, path: req.url, method: req.method, auth: req.headers.authorization });
        respond(body, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const url = `http://127.0.0.1:${server.address().port}/${marker}`;
    const profile = { version: 1, role: 'worker', workerConfig: 'unopened.json', nodeConfig: 'node.json',
        healthUrl: 'http://127.0.0.1:1/healthz', nodeAddress: address, balanceRpc: { url, authorization: `Bearer ${marker}` } };
    const config = { chainId: 1, ledgerContract: address, rpcUrl: url };
    async function run(code, { human = false, offline = false, command = 'balance' } = {}) {
        await writeFile(file, JSON.stringify(profile), { mode: 0o600 });
        await writeFile(configFile, JSON.stringify(config));
        const args = ['--import', guard, script, command, ...(human ? ['--profile', file] : ['--json'])];
        const env = { PATH: '', OYA_OPERATOR_PROFILE: file, TEST_OPERATOR_FILES: JSON.stringify([file, configFile, join(dir, 'worker.json')]),
            ...(offline ? { TEST_OPERATOR_OFFLINE: '1' } : {}) };
        return new Promise((resolve, reject) => execFile(process.execPath, args, { cwd: dir, env, timeout: 9000 }, (err, out, stderr) => {
            try {
                assert.equal(stderr, '');
                assert.ok(!out.includes(marker));
                assert.equal(err?.code ?? 0, code, out);
                resolve(human ? out : JSON.parse(out));
            } catch (error) { reject(error); }
        }));
    }
    return { config, profile, run, requests, url, reply(fn) { respond = fn; },
        async setupHealth(role) {
            profile.role = role;
            profile.healthUrl = new URL('/healthz', url).href;
            health = { role, mode: 'ledger', chainId: 1, ledgerContract: address, nodeAddress: address, private: marker };
            if (role === 'direct') {
                delete profile.workerConfig;
                Object.assign(health, { status: 'ready', busy: false });
            } else {
                profile.workerConfig = 'worker.json';
                await writeFile(join(dir, 'worker.json'), JSON.stringify({ target: 'fixture' }));
                Object.assign(health, { status: 'idle', target: 'fixture', lastPollAt: new Date().toISOString() });
            }
            return health;
        } };
}

test('worker snapshot authenticates only to the bound endpoint and pins the exact block', async t => {
    const f = await fixture(t);
    const result = await f.run(0);
    assert.deepEqual(result, { version: 1, role: 'worker', mode: 'ledger', chainId: 1, nodeAddress: address,
        observedAt: new Date(result.observedAt).toISOString(), balanceWei: BigInt(max).toString(),
        blockNumber: BigInt(block).toString(), status: 'observed' });
    assert.deepEqual(f.requests.map(r => r.body), [
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
        { jsonrpc: '2.0', id: 3, method: 'eth_getBalance', params: [address, block] },
    ]);
    assert.ok(f.requests.every(r => r.method === 'POST' && r.path === `/${marker}` && r.auth === `Bearer ${marker}`));
});

test('direct snapshot reports zero as observed with no implicit authorization', async t => {
    const f = await fixture(t);
    Object.assign(f.profile, { role: 'direct' });
    delete f.profile.workerConfig;
    delete f.profile.balanceRpc;
    f.reply(({ id }, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result: id === 1 ? '0x1' : '0x0' })));
    assert.equal((await f.run(0)).balanceWei, '0');
    assert.match(await f.run(0, { human: true }), /0 wei at block 0/);
    assert.ok(f.requests.every(r => r.auth === undefined));
});

test('IPFS returns not applicable offline without a worker config', async t => {
    const f = await fixture(t);
    Object.keys(f.config).forEach(k => delete f.config[k]);
    f.config.mode = 'ipfs';
    delete f.profile.balanceRpc;
    delete f.profile.nodeAddress;
    const result = await f.run(0, { offline: true });
    assert.equal(result.status, 'not_applicable');
    assert.equal(result.balanceWei, null);
});

test('invalid transport, absent endpoint, changed path or invalid credential fails before RPC', async t => {
    const f = await fixture(t);
    for (const url of [undefined, f.url + '/changed', 'http://remote.invalid/', 'https://user@host.invalid/', 'file:///abc']) {
        f.config.rpcUrl = url;
        if (url !== f.url + '/changed') delete f.profile.balanceRpc;
        else f.profile.balanceRpc = { url: f.url, authorization: marker };
        assert.equal((await f.run(2, { offline: true })).status, 'configuration');
    }
    f.config.rpcUrl = f.url;
    f.profile.balanceRpc = { url: f.url, authorization: marker + '\r\n' };
    assert.equal((await f.run(2)).status, 'configuration');
    assert.equal(f.requests.length, 0);
});

test('wrong chain stops before querying a block or balance', async t => {
    const f = await fixture(t);
    f.reply(({ id }, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x2' })));
    const result = await f.run(1);
    assert.equal(result.status, 'wrong_chain');
    assert.equal(result.balanceWei, null);
    assert.equal(f.requests.length, 1);
});

test('invalid RPC envelopes, noncanonical quantities and overflow never become a balance', async t => {
    const f = await fixture(t);
    for (const invalid of [{ id: 4 }, { jsonrpc: '1.0' }, { error: marker }, { result: '0x01' },
        { result: '0x' }, { result: 0 }, { result: max + '0' }]) {
        f.reply(({ id }, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1', ...(id === 3 && invalid) })));
        const result = await f.run(1);
        assert.equal(result.status, 'unavailable');
        assert.equal(result.balanceWei, null);
    }
});

test('redirects, oversized chunked bodies, provider errors and invalid UTF-8 fail privately', async t => {
    const f = await fixture(t);
    for (const reply of [res => res.writeHead(307, { location: f.url }).end(),
        res => { res.write(' '.repeat(65536)); res.end('{}'); }, res => res.writeHead(403).end(marker),
        res => res.end(Buffer.from([255]))]) {
        f.reply((_body, res) => reply(res));
        const before = f.requests.length;
        assert.equal((await f.run(1)).status, 'unavailable');
        assert.equal(f.requests.length, before + 1);
    }
});

test('one deadline bounds the complete observation, including an unfinished body', async t => {
    const f = await fixture(t);
    f.reply(({ id }, res) => {
        if (id === 1) setTimeout(() => res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' })), 2500);
        else res.write('{');
    });
    const start = performance.now();
    assert.equal((await f.run(1)).status, 'timeout');
    assert.ok(performance.now() - start < 7200);
    assert.equal(f.requests.length, 2);
});

for (const role of ['direct', 'worker']) test(`monitor-once keeps independent ${role} observations`, async t => {
    const f = await fixture(t);
    const health = await f.setupHealth(role);
    const run = (code, human = false) => f.run(code, { command: 'monitor-once', human });
    const ok = await run(0);
    assert.equal(ok.health.state, 'healthy');
    assert.equal(ok.balance.balanceWei, BigInt(max).toString());
    assert.equal(ok.balance.state, 'observed');
    health.status = 'stopped';
    assert.equal((await run(1)).health.state, 'degraded');
    health.role = 'wrong';
    const mismatch = await run(1);
    assert.equal(mismatch.health.state, 'unknown');
    assert.equal(mismatch.balance.state, 'observed');
    health.role = role;
    health.status = role === 'worker' ? 'idle' : 'ready';
    f.reply((_req, res) => res.writeHead(503).end(marker));
    const outage = await run(1);
    assert.equal(outage.health.state, 'healthy');
    assert.equal(outage.balance.state, 'unknown');
    assert.match(await run(1, true), /Balance \(unknown\).*unavailable/);
    f.profile.balanceRpc.authorization = '\n' + marker;
    const invalid = await run(2);
    assert.equal(invalid.health.state, 'healthy');
    assert.equal(invalid.balance.status, 'configuration');
});

test('missing, invalid and unreadable worker references do not suppress the balance', async t => {
    const f = await fixture(t);
    for (const reference of [undefined, 123, marker]) {
        f.profile.workerConfig = reference;
        const report = await f.run(2, { command: 'monitor-once' });
        assert.equal(report.health.status, 'configuration');
        assert.equal(report.health.state, 'unknown');
        assert.equal(report.balance.balanceWei, BigInt(max).toString());
    }
});
