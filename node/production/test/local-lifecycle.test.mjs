import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';
import { loadLocalSettings } from '../scripts/local-config.mjs';
import { startNode } from '../src/main.mjs';

const production = fileURLToPath(new URL('../', import.meta.url));
const script = join(production, 'scripts/local-node.mjs');
const execute = promisify(execFile);

async function listen(t, handler, port = 0) {
    const server = createServer(handler);
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    return server;
}

async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'Timed out waiting for the local node');
        await delay(10);
    }
}

async function fixture(t) {
    const cwd = await mkdtemp(join(tmpdir(), 'oya-local-lifecycle-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const wallet = Wallet.createRandom();
    const agent = Wallet.createRandom();
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    t.after(released.resolve);
    const calls = [];
    const state = { chain: '0x7a69' };
    const upstream = await listen(t, async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        calls.push(request.url);
        response.setHeader('content-type', 'application/json');
        if (request.url === '/rpc') {
            if (request.headers.authorization !== 'Bearer rpc-secret-marker') {
                response.writeHead(401).end('provider-secret-marker');
                return;
            }
            const { id, method } = JSON.parse(body);
            const result = { eth_chainId: state.chain, eth_getCode: '0x6000', eth_getBalance: '0x1' }[method];
            response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
        } else if (request.url === '/ipfs/api/v0/version') {
            if (request.headers.authorization !== 'Bearer ipfs-secret-marker') {
                response.writeHead(401).end('provider-secret-marker');
                return;
            }
            await state.onCheck?.();
            response.end(JSON.stringify({ Version: 'fixture' }));
        } else if (request.url.startsWith('/ipfs/api/v0/add')) {
            entered.resolve();
            await released.promise;
            // Finish the held operation with a definite upload failure, without a transaction.
            response.writeHead(403).end('provider-secret-marker');
        } else response.writeHead(404).end('{}');
    });
    const reservation = await listen(t, (_request, response) => response.end());
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const base = `http://127.0.0.1:${upstream.address().port}`;
    const config = { host: '127.0.0.1', port, chainId: 31337,
        loggerContract: '0x1111111111111111111111111111111111111111', allowedSigners: [agent.address],
        rpcUrl: `${base}/rpc`, ipfsUrl: `${base}/ipfs`, operationTimeoutMs: 10_000 };
    const configPath = join(cwd, 'config.json');
    const envPath = join(cwd, 'node.env');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(envPath, `OYA_NODE_PRIVATE_KEY=${wallet.privateKey}\n`
        + 'OYA_RPC_AUTHORIZATION="Bearer rpc-secret-marker"\nOYA_IPFS_AUTHORIZATION="Bearer ipfs-secret-marker"\n'
        + `OYA_AGENT_PRIVATE_KEY=${agent.privateKey}\nLOGGER_DEPLOYER_PK=deployer-secret-marker\n`, { mode: 0o600 });
    return { cwd, wallet, agent, config, configPath, envPath, upstream, calls, state,
        entered: entered.promise, release: released.resolve, url: `http://127.0.0.1:${port}`,
        args: ['--config', 'config.json', '--env-file', 'node.env'],
    };
}

function launch(t, f, direct = false) {
    const args = direct ? [join(production, 'src/main.mjs'), f.configPath] : [script, 'run', ...f.args];
    const child = spawn(process.execPath, ['--', ...args], {
        cwd: f.cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, INIT_CWD: f.cwd,
            OYA_NODE_PRIVATE_KEY: direct ? f.wallet.privateKey : Wallet.createRandom().privateKey,
            OYA_RPC_AUTHORIZATION: direct ? 'Bearer rpc-secret-marker' : 'wrong-secret-marker',
            OYA_IPFS_AUTHORIZATION: direct ? 'Bearer ipfs-secret-marker' : 'wrong-secret-marker' },
    });
    let output = '';
    let closed = false;
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    t.after(async () => {
        if (!closed) {
            try {
                if (process.platform === 'win32') child.kill('SIGKILL');
                else process.kill(-child.pid, 'SIGKILL'); // Only this test's process group.
            } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        await exited;
    });
    return { child, exited, output: () => output, closed: () => closed,
        ready: () => until(() => output.includes('"event":"listening"')) };
}

test('run and npm status use selected settings, then stop without changing files or services', { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const before = await Promise.all([f.configPath, f.envPath].map((path) => readFile(path, 'utf8')));
    const running = launch(t, f);
    await running.ready();
    assert.ok(running.output().includes(f.wallet.address));
    assert.ok(running.output().includes(f.url));
    const calls = f.calls.length;
    const { stdout } = await execute('npm', ['--prefix', production, 'run', 'local', '--', 'status', ...f.args],
        { cwd: f.cwd, timeout: 5000 });
    assert.match(stdout, /OK ready/);
    assert.equal(f.calls.length, calls, 'status must not contact Ethereum or IPFS');
    running.child.kill('SIGTERM');
    assert.deepEqual(await running.exited, { code: 0, signal: null });
    await assert.rejects(fetch(`${f.url}/healthz`));
    assert.equal(f.upstream.listening, true);
    await assert.rejects(execute(process.execPath, ['--', script, 'status', ...f.args], {
        cwd: f.cwd, env: { ...process.env, INIT_CWD: f.cwd }, timeout: 5000,
    }), (error) => { assert.equal(error.code, 1); assert.match(error.stdout, /unreachable/); return true; });
    assert.deepEqual(await Promise.all([f.configPath, f.envPath].map((path) => readFile(path, 'utf8'))), before);
    assert.equal(running.output().includes('secret-marker'), false);
    assert.equal(running.output().includes(f.wallet.privateKey), false);
    assert.equal(running.output().includes(f.agent.privateKey), false);
});

test('both launch paths drain admitted requests on SIGINT and SIGTERM', { timeout: 30_000 }, async (t) => {
    for (const direct of [false, true]) for (const signal of ['SIGINT', 'SIGTERM']) {
        await t.test(`${direct ? 'direct' : 'local'} ${signal}`, async (t) => {
            const f = await fixture(t);
            const running = launch(t, f, direct);
            await running.ready();
            const text = 'Local lifecycle test';
            const pending = fetch(`${f.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text, signer: f.agent.address, signature: await f.agent.signMessage(text) }) });
            await f.entered;
            const { stdout } = await execute(process.execPath, ['--', script, 'status', ...f.args], {
                cwd: f.cwd, env: { ...process.env, INIT_CWD: f.cwd }, timeout: 5000,
            });
            assert.match(stdout, /OK busy/);
            running.child.kill(signal);
            await until(() => running.output().includes('Stopping node;'));
            await delay(100);
            assert.equal(running.closed(), false, 'node must wait for the admitted request to drain');
            f.release();
            const response = await pending;
            await response.text();
            assert.equal(response.status, 502);
            assert.deepEqual(await running.exited, { code: 0, signal: null });
            assert.match(running.output(), /"event":"message_result"/);
            assert.equal(running.output().includes('secret-marker'), false);
            await assert.rejects(fetch(`${f.url}/healthz`));
            assert.equal(f.upstream.listening, true);
        });
    }
});

test('readiness and occupied-port failures leave no extra node running', { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    f.state.chain = '0x1';
    const failed = launch(t, f);
    assert.deepEqual(await failed.exited, { code: 1, signal: null });
    assert.match(failed.output(), /FAIL Ethereum chain/);
    assert.equal(failed.output().includes('Starting node'), false);
    f.state.chain = '0x7a69';
    const occupied = await listen(t, (_request, response) => response.end('existing service'), f.config.port);
    const duplicate = launch(t, f);
    assert.deepEqual(await duplicate.exited, { code: 1, signal: null });
    assert.match(duplicate.output(), /Node startup failed/);
    assert.equal(duplicate.output().includes('"event":"listening"'), false);
    assert.equal(await (await fetch(f.url)).text(), 'existing service');
    assert.equal(occupied.listening, true);
});

test('run uses its loaded settings when files change during readiness', { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    f.state.onCheck = async () => {
        await writeFile(f.configPath, JSON.stringify({ ...f.config, chainId: 1 }));
        await writeFile(f.envPath, `OYA_NODE_PRIVATE_KEY=${Wallet.createRandom().privateKey}\n`);
    };
    const running = launch(t, f);
    await running.ready();
    const health = await (await fetch(`${f.url}/healthz`)).json();
    assert.equal(health.chainId, f.config.chainId);
    assert.equal(health.nodeAddress, f.wallet.address);
    running.child.kill('SIGTERM');
    assert.deepEqual(await running.exited, { code: 0, signal: null });
});

test('signal handlers survive disconnected work and are removed after full shutdown', { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const { config, signer } = await loadLocalSettings(f.configPath, f.envPath, { env: {} });
    const listeners = () => ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
    const before = listeners();
    const options = { handleSignals: true, log: () => {} };
    const runtime = await startNode(config, signer, options);
    t.after(async () => { f.release(); await runtime.close(); });
    const active = before.map((count) => count + 1);
    assert.deepEqual(listeners(), active);
    await assert.rejects(startNode(config, signer, options), { code: 'EADDRINUSE' });
    assert.deepEqual(listeners(), active, 'failed startup must not install signal handlers');

    const controller = new AbortController();
    const text = 'Disconnected request during shutdown';
    const pending = fetch(`${f.url}/v1/messages`, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, signer: f.agent.address, signature: await f.agent.signMessage(text) }) });
    await f.entered;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const closed = once(runtime.server, 'close');
    const draining = runtime.close();
    await closed;
    assert.deepEqual(listeners(), active, 'closing the listener must not remove handlers while work is active');
    f.release();
    await draining;
    assert.deepEqual(listeners(), before);
});
