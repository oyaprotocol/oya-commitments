import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';
import { checkLocalNode } from '../scripts/local-check.mjs';
import { loadLocalSettings } from '../scripts/local-config.mjs';

const production = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);

async function fixture(t) {
    const cwd = await mkdtemp(join(tmpdir(), 'oya-local-check-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const wallet = Wallet.createRandom();
    const calls = [];
    const state = {
        eth_chainId: '0x7a69', eth_getCode: '0x6000', eth_getBalance: '0x1',
        ipfsStatus: 200, ipfsBody: { Version: 'test-version' },
    };
    const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        const rpc = request.url === '/rpc-secret-marker' ? JSON.parse(body) : null;
        const method = rpc?.method ?? 'ipfs-version';
        calls.push({ method, params: rpc?.params, path: request.url,
            verb: request.method, authorization: request.headers.authorization });
        response.writeHead(rpc ? 200 : state.ipfsStatus, { 'content-type': 'application/json' });
        if (state.hang === method) {
            response.write('{'); // Headers arrive, but the response body never finishes.
            return;
        }
        response.end(JSON.stringify(rpc
            ? { jsonrpc: '2.0', id: rpc.id, ...(state.rpcError
                ? { error: { code: -32602, message: 'provider-secret-marker' } }
                : { result: state[method] }) }
            : state.ipfsBody));
    });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = {
        chainId: 31337, loggerContract: '0x1111111111111111111111111111111111111111',
        allowedSigners: [Wallet.createRandom().address],
        rpcUrl: `${base}/rpc-secret-marker`, ipfsUrl: `${base}/ipfs-secret-marker/api/v0/`,
    };
    const configPath = join(cwd, 'config.json');
    const envPath = join(cwd, 'node.env');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(envPath, `OYA_NODE_PRIVATE_KEY="${wallet.privateKey}"\n`
        + 'OYA_RPC_AUTHORIZATION="Bearer rpc-secret-marker"\n'
        + 'OYA_IPFS_AUTHORIZATION="Bearer ipfs-secret-marker"\n', { mode: 0o600 });
    const output = [];
    return { cwd, wallet, calls, state, config, configPath, envPath, output,
        check: async (options = {}) => {
            const log = (line) => output.push(line);
            const settings = await loadLocalSettings(configPath, envPath, { env: options.env ?? {}, log });
            return settings ? checkLocalNode(settings, { log, timeoutMs: 1000, ...options }) : 1;
        },
    };
}

function assertRedacted(output, wallet) {
    assert.equal(output.includes('secret-marker'), false);
    assert.equal(output.includes(wallet.privateKey), false);
}

test('npm check uses caller-relative files and their credentials, with only read-only requests', async (t) => {
    const f = await fixture(t);
    const before = await Promise.all([f.configPath, f.envPath].map((path) => readFile(path, 'utf8')));
    const inherited = Wallet.createRandom();
    const args = ['--prefix', production, 'run', 'local', '--', 'check',
        '--config', 'config.json', '--env-file', 'node.env'];
    const options = { cwd: f.cwd, timeout: 5000, env: { ...process.env,
        OYA_NODE_PRIVATE_KEY: inherited.privateKey, OYA_RPC_AUTHORIZATION: 'inherited-secret-marker',
        OYA_IPFS_AUTHORIZATION: 'inherited-secret-marker',
    } };
    const { stdout, stderr } = await execute('npm', args, options);
    assert.equal(stderr, '');
    assert.ok(stdout.includes(f.wallet.address));
    assert.equal(stdout.includes(inherited.address), false);
    assert.match(stdout, /Read-only checks passed/);
    assertRedacted(stdout, f.wallet);
    assertRedacted(stdout, inherited);
    assert.deepEqual(f.calls, [
        { method: 'eth_chainId', params: [], path: '/rpc-secret-marker', verb: 'POST',
            authorization: 'Bearer rpc-secret-marker' },
        { method: 'eth_getCode', params: [f.config.loggerContract, 'latest'], path: '/rpc-secret-marker',
            verb: 'POST', authorization: 'Bearer rpc-secret-marker' },
        { method: 'eth_getBalance', params: [f.wallet.address, 'latest'], path: '/rpc-secret-marker',
            verb: 'POST', authorization: 'Bearer rpc-secret-marker' },
        { method: 'ipfs-version', params: undefined, path: '/ipfs-secret-marker/api/v0/version',
            verb: 'POST', authorization: 'Bearer ipfs-secret-marker' },
    ]);
    assert.deepEqual(await Promise.all([f.configPath, f.envPath].map((path) => readFile(path, 'utf8'))), before);

    f.state.eth_chainId = '0x1';
    f.calls.length = 0;
    await assert.rejects(execute('npm', args, options), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /FAIL Ethereum chain/);
        assertRedacted(`${error.stdout}${error.stderr}`, f.wallet);
        return true;
    });
    assert.equal(f.calls.length, 1);
});

test('check inherits omitted values but explicit empty file values override them', async (t) => {
    const f = await fixture(t);
    const env = Object.freeze({ OYA_NODE_PRIVATE_KEY: f.wallet.privateKey,
        OYA_RPC_AUTHORIZATION: 'inherited-secret-marker' });
    await writeFile(f.envPath, '');
    assert.equal(await f.check({ env }), 0);
    assert.equal(f.calls[0].authorization, env.OYA_RPC_AUTHORIZATION);
    assert.equal(f.calls.at(-1).authorization, undefined);
    assertRedacted(f.output.join('\n'), f.wallet);
    await writeFile(f.envPath, 'OYA_NODE_PRIVATE_KEY=\n');
    f.calls.length = 0;
    assert.equal(await f.check({ env }), 1);
    assert.match(f.output.at(-1), /FAIL Node signing key/);
    assert.equal(f.calls.length, 0);
});

test('unreadable settings, invalid JSON, and non-loopback binding fail before requests', async (t) => {
    const f = await fixture(t);
    assert.equal(await loadLocalSettings(f.configPath, join(f.cwd, 'missing-secret-marker.env'), {
        env: {}, log: (line) => f.output.push(line),
    }), null);
    assert.match(f.output.at(-1), /FAIL Environment file/);
    await writeFile(f.configPath, 'invalid-secret-marker');
    assert.equal(await f.check(), 1);
    assert.match(f.output.at(-1), /FAIL Configuration/);
    await writeFile(f.configPath, JSON.stringify({ ...f.config, host: '0.0.0.0' }));
    assert.equal(await f.check(), 1);
    assert.match(f.output.at(-1), /FAIL Local binding/);
    assert.equal(f.calls.length, 0);
    assertRedacted(f.output.join('\n'), f.wallet);
});

test('check reports the failed prerequisite without exposing provider data', async (t) => {
    const cases = [
        ['chain mismatch', { eth_chainId: '0x1' }, 'Ethereum chain', 1],
        ['missing Logger', { eth_getCode: '0x' }, 'Logger bytecode', 2],
        ['unfunded node', { eth_getBalance: '0x0' }, 'Node gas balance', 3],
        ['invalid balance', { eth_getBalance: 'provider-secret-marker' }, 'Node gas balance', 3],
        ['oversized balance', { eth_getBalance: `0x1${'0'.repeat(64)}` }, 'Node gas balance', 3],
        ['RPC error', { rpcError: true }, 'Ethereum chain', 1],
        ['IPFS denied', { ipfsStatus: 401, ipfsBody: { Message: 'provider-secret-marker' } }, 'IPFS API', 4],
        ['invalid IPFS response', { ipfsBody: { Message: 'provider-secret-marker' } }, 'IPFS API', 4],
    ];
    for (const [name, state, failed, count] of cases) {
        await t.test(name, async (t) => {
            const f = await fixture(t);
            Object.assign(f.state, state);
            assert.equal(await f.check(), 1);
            assert.ok(f.output.at(-1).startsWith(`FAIL ${failed}.`));
            assert.equal(f.calls.length, count);
            assertRedacted(f.output.join('\n'), f.wallet);
        });
    }
});

test('check bounds stalled RPC and IPFS response bodies', { timeout: 5000 }, async (t) => {
    for (const [hang, failed] of [['eth_chainId', 'Ethereum chain'], ['ipfs-version', 'IPFS API']]) {
        const f = await fixture(t);
        f.state.hang = hang;
        assert.equal(await f.check({ timeoutMs: 100 }), 1);
        assert.ok(f.output.at(-1).startsWith(`FAIL ${failed}.`));
        assert.equal(f.calls.at(-1).method, hang);
        assertRedacted(f.output.join('\n'), f.wallet);
    }
});

test('unreachable RPC reports a bounded sanitized failure', async (t) => {
    const f = await fixture(t);
    assert.equal(await f.check({ timeoutMs: 50, fetch: async () => {
        throw new Error('https://provider.invalid/unreachable-secret-marker');
    } }), 1);
    assert.match(f.output.at(-1), /FAIL Ethereum chain/);
    assertRedacted(f.output.join('\n'), f.wallet);
});
