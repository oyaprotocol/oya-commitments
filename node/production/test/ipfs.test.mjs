import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Wallet } from 'ethers';
import { parseConfig } from '../src/config.mjs';
import { startNode } from '../src/main.mjs';
import { loadLocalSettings } from '../scripts/local-config.mjs';
import { checkLocalNode } from '../scripts/local-check.mjs';
import { statusLocalNode } from '../scripts/local-status.mjs';
import { deployLedger } from '../scripts/local-deploy.mjs';
import { cid, gate, signedMessage } from './runtime-fixture.mjs';

const input = { mode: 'ipfs', allowedSigners: [Wallet.createRandom().address], ipfsUrl: 'http://ipfs.example' };

async function fixture(t, overrides = {}) {
    const agent = Wallet.createRandom();
    const parsed = parseConfig({ ...input, allowedSigners: [agent.address], ...overrides }, { env: {} });
    const config = { ...parsed, port: 0, ipfs: { ...parsed.ipfs, maxRetries: 0 } };
    const uploads = [], logs = [];
    const state = {};
    const runtime = await startNode(config, undefined, { log: record => logs.push(record), fetch: async (url, options) => {
        assert.ok(url.startsWith(`${config.ipfs.url}/api/v0/add?`), 'only IPFS requests are allowed');
        uploads.push(await options.body.get('file').text());
        if (state.upload) return state.upload(options);
        return Response.json({ Hash: cid });
    } });
    t.after(async () => { state.cleanup?.(); await runtime.close(); });
    const url = `http://127.0.0.1:${runtime.server.address().port}`;
    const message = await signedMessage(agent);
    return { config, agent, uploads, logs, state, runtime, message, url,
        post: (body = message, options = {}) => fetch(`${url}/v1/messages`, { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options }),
        health: async () => (await fetch(`${url}/healthz`)).json(),
    };
}

test('IPFS configuration requires authorization and rejects ambiguous Ethereum settings and unknown modes', () => {
    const config = parseConfig(input, { env: { OYA_NODE_PRIVATE_KEY: 'invalid-unused-key', OYA_RPC_AUTHORIZATION: 'unused' } });
    assert.equal(config.mode, 'ipfs');
    for (const field of ['chainId', 'ledgerContract', 'rpcUrl', 'receiptTimeoutMs', 'pollIntervalMs', 'gasLimit', 'maxFeePerGasWei']) {
        assert.throws(() => parseConfig({ ...input, [field]: null }), /IPFS mode/);
    }
    for (const mode of [null, '', false, 'IPFS', 'unknown']) assert.throws(() => parseConfig({ ...input, mode }), /mode/);
    for (const change of [{ allowedSigners: [] }, { allowedSigners: undefined }, { ipfsUrl: 'file:///ipfs' }]) {
        assert.throws(() => parseConfig({ ...input, ...change }));
    }
    for (const field of ['rpc', 'chainId', 'ledgerContract', 'limits', 'receiptTimeoutMs']) assert.equal(Object.hasOwn(config, field), false);
});

test('IPFS node starts without a signer or RPC and publishes the exact signed envelope independently on repeats', async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await f.health(), { mode: 'ipfs', status: 'ready', busy: false });
    assert.equal(f.uploads.length, 0);
    for (let count = 0; count < 2; count++) {
        const response = await f.post();
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'published', signer: f.agent.address,
            publication: { status: 'published', cid, uri: `ipfs://${cid}` } });
    }
    assert.deepEqual(f.uploads, [JSON.stringify(f.message), JSON.stringify(f.message)]);
    assert.ok(f.logs.every(record => record.status === 'published' && !('loggingOutcome' in record)));
});

test('IPFS authorization and body limits reject before upload and valid requests share a rate limit', async (t) => {
    const f = await fixture(t, { maxMessageRequestsPerMinute: 1, maxBodyBytes: 1024, maxTextBytes: 100 });
    assert.equal((await f.post({ ...f.message, text: 'tampered' })).status, 401);
    assert.equal((await f.post(await signedMessage(Wallet.createRandom()))).status, 403);
    assert.equal((await f.post({ text: 'x'.repeat(2000) })).status, 413);
    assert.equal(f.uploads.length, 0);
    assert.equal((await f.post()).status, 200);
    const limited = await f.post();
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { code: 'rate_limited', started: false });
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(f.uploads.length, 1);
});

test('IPFS provider failures, internal errors, and timeouts are sanitized and release admission', async (t) => {
    for (const kind of ['provider', 'internal', 'timeout']) {
        await t.test(kind, async (t) => {
            const f = await fixture(t, { operationTimeoutMs: 50 });
            f.state.upload = async () => {
                if (kind === 'provider') return new Response('provider-secret-marker', { status: 403 });
                if (kind === 'internal') throw new ReferenceError('provider-secret-marker');
                return new Promise(() => {});
            };
            const response = await f.post();
            assert.equal(response.status, { provider: 502, internal: 500, timeout: 504 }[kind]);
            assert.deepEqual(await response.json(), { code: { provider: 'publication_failed', internal: 'internal_error', timeout: 'operation_timeout' }[kind], started: true });
            assert.equal(JSON.stringify(f.logs).includes('provider-secret-marker'), false);
            assert.equal((await f.health()).status, 'ready');
            delete f.state.upload;
            assert.equal((await f.post()).status, 200);
        });
    }
});

test('IPFS node serializes work and drains an upload after client disconnect', async (t) => {
    const f = await fixture(t);
    const held = gate();
    f.state.upload = async () => { await held.wait(); return Response.json({ Hash: cid }); };
    f.state.cleanup = held.release;
    const controller = new AbortController();
    const pending = f.post(f.message, { signal: controller.signal });
    await held.entered;
    assert.equal((await f.health()).status, 'busy');
    const busy = await f.post();
    assert.equal(busy.status, 503);
    assert.deepEqual(await busy.json(), { code: 'node_busy', started: false });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    let drained = false;
    const closing = f.runtime.close().then(() => { drained = true; });
    await delay(20);
    assert.equal(drained, false);
    held.release();
    await closing;
    assert.equal(f.uploads.length, 1);
    assert.equal(f.logs[0].status, 'published');
});

test('IPFS local settings, readiness, and status need no key or chain; deployment refuses without side effects', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'oya-ipfs-local-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const configPath = join(directory, 'node.json'), envPath = join(directory, 'node.env');
    await writeFile(configPath, JSON.stringify(input), { mode: 0o600 });
    await writeFile(envPath, '', { mode: 0o600 });
    const settings = await loadLocalSettings(configPath, envPath, { env: { OYA_NODE_PRIVATE_KEY: 'unused-invalid-key' } });
    assert.ok(settings);
    assert.equal(settings.signer, undefined);
    const calls = [];
    assert.equal(await checkLocalNode(settings, { log: () => {}, fetch: async (url) => {
        calls.push(url);
        return Response.json({ Version: 'fixture' });
    } }), 0);
    assert.deepEqual(calls, ['http://ipfs.example/api/v0/version']);
    const statuses = [
        [{ mode: 'ipfs', status: 'ready', busy: false }, 200, 0],
        [{ mode: 'ipfs', status: 'busy', busy: true }, 200, 0],
        [{ mode: 'ipfs', status: 'shutting_down', busy: true }, 503, 1],
        [{ mode: 'ledger', status: 'ready', busy: false }, 200, 1],
        [{ mode: 'ipfs', status: 'ready', busy: false, nodeAddress: input.allowedSigners[0] }, 200, 1],
        [{ mode: 'ipfs', status: 'transaction_outcome_unknown', busy: false }, 503, 1],
    ];
    for (const [body, status, expected] of statuses) {
        assert.equal(await statusLocalNode(settings, { log: () => {}, fetch: async () => Response.json(body, { status }) }), expected);
    }
    const unused = () => assert.fail('IPFS mode must never deploy or contact Ethereum');
    assert.equal(await deployLedger(configPath, { ...settings, env: {} }, {
        broadcast: true, log: () => {}, execute: unused, fetch: unused,
    }), 1);
});
