import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { publicNodeSettings } from '../src/public-settings.mjs';
import { parseConfig } from '../src/config.mjs';
import { workerFreshness } from '../src/health.mjs';
import { createWorkerHealthServer } from '../src/inbox/worker.mjs';
import { createNodeServer } from '../src/server.mjs';

const cli = fileURLToPath(new URL('../scripts/operator-node.mjs', import.meta.url));
const guard = fileURLToPath(new URL('./operator-guard.mjs', import.meta.url));
const nodeAddress = '0x2222222222222222222222222222222222222222';
const ledgerContract = '0x1111111111111111111111111111111111111111';
const sentinel = 'private-output-sentinel';
const ledger = { mode: 'ledger', chainId: 31337, ledgerContract, nodeAddress };
const nodeConfig = { mode: 'ledger', chainId: 31337, ledgerContract, rpcUrl: 'http://127.0.0.1:1',
    ipfsUrl: 'http://127.0.0.1:1', allowedSigners: [nodeAddress], operationTimeoutMs: 1000 };
const direct = { ...ledger, status: 'ready', busy: false };
const worker = () => ({ ...ledger, role: 'worker', target: 'test', status: 'idle', lastPollAt: new Date().toISOString() });

async function runCli(script, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [...(options.preload ? ['--import', options.preload] : []), '--', script, ...args], {
            cwd: options.cwd, env: { PATH: '/nonexistent', ...options.env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI exceeded test deadline')); }, 10000);
        child.stdout.on('data', bytes => { stdout += bytes; });
        child.stderr.on('data', bytes => { stderr += bytes; });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
}

async function listen(t, server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}/healthz`;
}

async function fixture(t, role = 'direct', mode = 'ledger') {
    const directory = await mkdtemp(join(tmpdir(), 'operator-status-'));
    await chmod(directory, 0o700);
    t.after(() => rm(directory, { recursive: true, force: true }));
    let body = role === 'worker' ? worker() : direct;
    let status = 200, handler, requests = 0;
    const server = createServer((request, response) => {
        requests++;
        assert.equal(request.url, '/healthz');
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.authorization, undefined);
        if (handler) return handler(request, response);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
    });
    const url = await listen(t, server);
    const profile = { version: 1, role, nodeConfig: 'node.json', healthUrl: url,
        ...(role === 'worker' ? { workerConfig: 'worker.json' } : {}), ...(mode === 'ledger' ? { nodeAddress } : {}) };
    const config = mode === 'ledger' ? nodeConfig : { mode: 'ipfs', operationTimeoutMs: 1000,
        allowedSigners: [nodeAddress], ipfsUrl: 'http://127.0.0.1:1' };
    const file = join(directory, 'operator.json');
    const save = async (value = profile) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
    await save();
    await writeFile(join(directory, 'node.json'), JSON.stringify(config));
    await writeFile(join(directory, 'worker.json'), JSON.stringify({ target: 'test', url: 'https://inbox.invalid',
        peers: { registryFile: 'never-read.json' } }));
    const run = (args = ['status', '--profile', file, '--json'], options = {}) => runCli(cli, args, {
        cwd: directory, preload: guard, env: { OYA_NODE_PRIVATE_KEY: sentinel, OYA_RPC_AUTHORIZATION: sentinel,
            TEST_OPERATOR_FILES: JSON.stringify([file, join(directory, 'node.json'), join(directory, 'worker.json')]), ...options.env }, ...options,
    });
    return { directory, file, profile, config, save, run, server, url, get requests() { return requests; },
        response(value, code = 200) { body = value; status = code; handler = null; },
        handler(value) { handler = value; } };
}

function checked(result, code, status) {
    assert.equal(result.stderr, '');
    assert.equal(result.code, code, result.stdout);
    assert.ok(!result.stdout.includes(sentinel));
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, status);
    assert.deepEqual(Object.keys(body).sort(), ['version', 'role', 'mode', 'target', 'chainId', 'ledgerContract', 'nodeAddress',
        'reachable', 'verified', 'healthy', 'status', 'message'].sort());
    return body;
}

test('actual CLI is key-free, resolves profile-relative configs, supports env selection and human output', async t => {
    const f = await fixture(t);
    const body = checked(await f.run(undefined, { cwd: tmpdir() }), 0, 'ready');
    assert.equal(body.nodeAddress, nodeAddress);
    assert.equal(body.verified, true);
    assert.equal(body.reachable, true);
    const env = { OYA_OPERATOR_PROFILE: f.file, TEST_OPERATOR_FILES: JSON.stringify([f.file, join(f.directory, 'node.json')]) };
    checked(await f.run(['status', '--json'], { env }), 0, 'ready');
    const human = await f.run(['status', '--profile', f.file]);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /OK direct ledger: ready/);
    assert.ok(!human.stdout.includes(f.directory));
});

test('profile gas policy matches standalone bytes without worker, health or credential access', async t => {
    const standalone = fileURLToPath(new URL('../scripts/gas-policy.mjs', import.meta.url));
    for (const role of ['direct', 'worker']) for (const mode of ['ledger', 'ipfs']) {
        const f = await fixture(t, role, mode);
        const file = join(f.directory, 'node.json');
        if (mode === 'ledger') await writeFile(file, JSON.stringify({ gasLimit: 200001, maxFeePerGasWei: '9007199254740993' }));
        await rm(join(f.directory, 'worker.json'));
        const env = { TEST_OPERATOR_FILES: JSON.stringify([f.file, file]), TEST_OPERATOR_OFFLINE: '1', OYA_OPERATOR_PROFILE: f.file };
        for (const flags of [[], ['--json']]) {
            const expected = await runCli(standalone, ['--config', file, ...flags]);
            assert.equal(expected.code, 0, expected.stderr);
            const args = flags.length ? ['--profile', f.file, 'gas-policy', ...flags] : ['gas-policy'];
            const actual = await f.run(args, { cwd: tmpdir(), env: { ...env,
                OYA_OPERATOR_PROFILE: flags.length ? 'ignore-this-profile' : f.file } });
            assert.deepEqual(actual, expected);
        }
        assert.equal(f.requests, 0);
    }
});

test('profile gas policy rejects invalid profiles and bounded inputs without disclosing them', async t => {
    const f = await fixture(t, 'worker');
    const file = join(f.directory, 'node.json');
    const args = ['gas-policy', '--profile', f.file, '--json'];
    const rejected = async () => {
        const failure = await f.run(args);
        checked(failure, 2, 'configuration');
        assert.ok(!failure.stdout.includes(f.directory));
    };
    await chmod(f.file, 0o644);
    await rejected();
    await chmod(f.file, 0o600);
    for (const change of [{ workerConfig: undefined }, { nodeAddress: undefined }, { healthUrl: sentinel }, { secret: sentinel }]) {
        await f.save({ ...f.profile, ...change });
        await rejected();
    }
    await f.save();
    for (const bytes of [sentinel, Buffer.from([0xff]), '{}'.padEnd(65537), '{"gasLimit":0}', '{"maxFeePerGasWei":null}']) {
        await writeFile(file, bytes);
        await rejected();
    }
    await rm(file);
    await rejected();
    await symlink(join(f.directory, 'worker.json'), file);
    await rejected();
    assert.equal(f.requests, 0);
});

test('symlinked command directory executes checks rather than silently succeeding', async t => {
    const f = await fixture(t);
    const linked = join(f.directory, 'commands');
    await symlink(fileURLToPath(new URL('../scripts/', import.meta.url)), linked);
    const command = join(linked, 'operator-node.mjs');
    checked(await runCli(command, ['status', '--json']), 2, 'arguments');
    const args = ['status', '--profile', f.file, '--json'];
    checked(await runCli(command, args), 0, 'ready');
    await new Promise(resolve => f.server.close(resolve));
    checked(await runCli(command, args), 1, 'unreachable');
});

test('direct health states and every identity dimension are checked through real HTTP', async t => {
    const f = await fixture(t);
    const cases = [
        [{ ...direct, status: 'busy', busy: true }, 200, 0, 'busy'],
        ...['starting', 'shutting_down', 'stopped', 'transaction_outcome_unknown', 'batch_blocked'].map(status => [{ ...direct, status }, 503, 1, status]),
        ...[{ mode: 'ipfs' }, { role: 'worker' }, { role: null }, { target: 'other' }, { chainId: 1 },
            { ledgerContract: nodeAddress }, { nodeAddress: ledgerContract }, { nodeAddress: null }].map(change => [{ ...direct, ...change }, 200, 1, 'identity_mismatch']),
        [{ ...direct, status: sentinel }, 200, 1, 'malformed'],
        [{ ...direct, busy: true }, 200, 1, 'malformed'],
        [direct, 503, 1, 'malformed'], [null, 200, 1, 'malformed'], [[], 200, 1, 'malformed'],
        [{ ...direct, note: sentinel }, 200, 0, 'ready'],
    ];
    for (const [body, http, code, state] of cases) {
        f.response(body, http);
        checked(await f.run(), code, state);
    }
});

test('legacy direct Ledger health retains mode fallback without weakening other identities', async t => {
    const f = await fixture(t);
    for (const status of ['ready', 'busy']) {
        f.response({ ...direct, mode: undefined, status, busy: status === 'busy' });
        assert.equal(checked(await f.run(), 0, status).verified, true);
    }
    for (const change of [{ mode: null }, { mode: 'ipfs' }, { nodeAddress: undefined }, { chainId: 1 }]) {
        f.response({ ...direct, mode: undefined, ...change });
        checked(await f.run(), 1, 'identity_mismatch');
    }
    const ipfs = await fixture(t, 'direct', 'ipfs');
    ipfs.response({ status: 'ready', busy: false });
    checked(await ipfs.run(), 1, 'identity_mismatch');
    const w = await fixture(t, 'worker');
    w.response({ ...worker(), mode: undefined });
    checked(await w.run(), 1, 'identity_mismatch');
});

test('HTTPS localhost preserves certificate identity and still requires trust and hostname matching', async t => {
    const f = await fixture(t);
    const keyFile = join(f.directory, 'test-key.pem');
    const certFile = join(f.directory, 'test-cert.pem');
    const configFile = join(f.directory, 'test-cert.cnf');
    await writeFile(configFile, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-config', configFile, '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
    const server = createHttpsServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, (req, res) => {
        assert.equal(req.headers.host, `localhost:${server.address().port}`);
        assert.equal(req.socket.servername, 'localhost');
        res.end(JSON.stringify(direct));
    });
    const url = (await listen(t, server)).replace('http://127.0.0.1', 'https://localhost');
    await f.save({ ...f.profile, healthUrl: url });
    const args = ['status', '--profile', f.file, '--json'];
    const env = { NODE_EXTRA_CA_CERTS: certFile };
    checked(await runCli(cli, args, { env }), 0, 'ready');
    checked(await runCli(cli, args), 1, 'unreachable');
    await f.save({ ...f.profile, healthUrl: url.replace('localhost', '127.0.0.1') });
    checked(await runCli(cli, args, { env }), 1, 'unreachable');
});

test('worker healthy states, failure states, freshness and legacy upgrade guidance', async t => {
    const f = await fixture(t, 'worker');
    for (const state of ['idle', 'processing', 'starting', 'retrying', 'inbox_unavailable', 'shutting_down', 'stopped']) {
        const healthy = ['idle', 'processing'].includes(state);
        f.response({ ...worker(), status: state }, healthy ? 200 : 503);
        checked(await f.run(), healthy ? 0 : 1, state);
    }
    for (const [change, code] of [
        [{ lastPollAt: new Date(Date.now() - 62000).toISOString() }, 'stale'],
        [{ lastPollAt: new Date(Date.now() + 60000).toISOString() }, 'future'],
        [{ lastPollAt: sentinel }, 'malformed'], [{ lastPollAt: undefined }, 'malformed'],
        [{ target: 'wrong' }, 'identity_mismatch'], [{ role: 'direct' }, 'identity_mismatch'],
        [{ chainId: 1 }, 'identity_mismatch'], [{ mode: 'ipfs' }, 'identity_mismatch'],
        [{ nodeAddress: undefined }, 'legacy_unverified'],
    ]) {
        f.response({ ...worker(), ...change });
        const observed = checked(await f.run(), 1, code);
        if (code === 'legacy_unverified') {
            assert.equal(observed.reachable, true);
            assert.equal(observed.verified, false);
            assert.match(observed.message, /Upgrade the worker image/);
        }
    }
});

test('IPFS direct and worker health omit Ethereum identity', async t => {
    for (const role of ['direct', 'worker']) {
        const f = await fixture(t, role, 'ipfs');
        const body = role === 'direct' ? { mode: 'ipfs', status: 'ready', busy: false }
            : { role: 'worker', mode: 'ipfs', target: 'test', status: 'idle', lastPollAt: new Date().toISOString() };
        f.response(body);
        checked(await f.run(), 0, body.status);
        f.response({ ...body, nodeAddress });
        checked(await f.run(), 1, 'identity_mismatch');
    }
});

test('strict private profile and invalid CLI fail before any request without printing inputs', async t => {
    const f = await fixture(t);
    for (const change of [{ version: 2 }, { version: '1' }, { role: 'inbox' }, { nodeAddress: '0x0' },
        { nodeAddress: '0x' + '0'.repeat(40) }, { nodeAddress: undefined }, { nodeConfig: '' },
        { workerConfig: 'worker.json' }, ...['credentialsFile', 'stateDirectory', 'privateKey', 'imageFile', '__proto__'].map(key => ({ [key]: sentinel })),
        ...['https://remote.invalid/healthz', 'http://127.0.0.1.evil.invalid/healthz', 'file:///healthz',
            'http://127.0.0.1/healthz?token=secret', 'http://user:secret@127.0.0.1/healthz', 'http://127.0.0.1/not-health',
            'http://0.0.0.0/healthz', 'http://[::ffff:127.0.0.1]/healthz'].map(healthUrl => ({ healthUrl }))]) {
        await f.save({ ...f.profile, ...change });
        checked(await f.run(), 2, 'configuration');
    }
    await f.save();
    for (const args of [[], ['send'], ['status', '--unknown', sentinel], ['status', '--profile'],
        ['status', 'status'], ['status', '--profile', f.file, '--profile', f.file]]) {
        checked(await f.run([...args, '--json']), 2, 'arguments');
    }
    await chmod(f.file, 0o644);
    checked(await f.run(), 2, 'configuration');
    await chmod(f.file, 0o600);
    await chmod(f.directory, 0o755);
    checked(await f.run(), 2, 'configuration');
    await chmod(f.directory, 0o700);
    await rm(f.file);
    await symlink(join(f.directory, 'node.json'), f.file);
    checked(await f.run(), 2, 'configuration');
    await rm(f.file);
    await writeFile(f.file, ' '.repeat(16385), { mode: 0o600 });
    checked(await f.run(), 2, 'configuration');
    assert.equal(f.requests, 0);
});

test('bad public configs, missing worker references and linked inputs fail before HTTP', async t => {
    const f = await fixture(t, 'worker');
    const nodeFile = join(f.directory, 'node.json');
    for (const input of [null, [], { ...nodeConfig, mode: 'other' }, { ...nodeConfig, chainId: 0 },
        { ...nodeConfig, operationTimeoutMs: -1 }, { ...nodeConfig, ledgerContract: sentinel },
        { ...nodeConfig, privateKey: sentinel }]) {
        await writeFile(nodeFile, JSON.stringify(input));
        checked(await f.run(), 2, 'configuration');
    }
    await writeFile(nodeFile, ' '.repeat(65537));
    checked(await f.run(), 2, 'configuration');
    await writeFile(nodeFile, JSON.stringify(nodeConfig));
    for (const input of [null, [], {}, { target: sentinel.toUpperCase() }, { target: 'test', workerToken: sentinel }]) {
        await writeFile(join(f.directory, 'worker.json'), JSON.stringify(input));
        checked(await f.run(), 2, 'configuration');
    }
    await f.save({ ...f.profile, workerConfig: undefined });
    checked(await f.run(), 2, 'configuration');
    await f.save();
    await rm(nodeFile);
    await symlink(join(f.directory, 'worker.json'), nodeFile);
    checked(await f.run(), 2, 'configuration');
    assert.equal(f.requests, 0);
});

test('body bounds, malformed response, redirects, disconnect and unreachable preserve privacy', async t => {
    const f = await fixture(t);
    let redirected = 0;
    const destination = createServer((_req, res) => { redirected++; res.end('{}'); });
    const location = await listen(t, destination);
    for (const [handler, status] of [
        [(_req, res) => { res.writeHead(302, { location }); res.end(sentinel); }, 'redirect'],
        [(_req, res) => { res.writeHead(500); res.end(sentinel); }, 'http_error'],
        [(_req, res) => res.end(sentinel), 'invalid_response'],
        [(_req, res) => res.end(Buffer.from([0xff])), 'invalid_response'],
        [(_req, res) => { res.writeHead(200, { 'content-length': 65537 }); res.end(); }, 'oversized'],
        [(_req, res) => { res.writeHead(200); res.write(' '.repeat(65000)); res.end(' '.repeat(1000)); }, 'oversized'],
        [(_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(sentinel); }, 'invalid_response'],
        [(_req, res) => { res.writeHead(200, { 'content-length': 200 }); res.flushHeaders(); res.destroy(); }, 'invalid_response'],
    ]) {
        f.handler(handler);
        checked(await f.run(), 1, status);
    }
    assert.equal(redirected, 0);
    await new Promise(resolve => f.server.close(resolve));
    const observed = checked(await f.run(), 1, 'unreachable');
    assert.equal(observed.reachable, false);
    assert.match(observed.message, /does not prove/);
});

test('five-second deadline covers both stalled headers and a streaming/stalled body', { timeout: 20000 }, async t => {
    const f = await fixture(t);
    for (const headers of [false, true]) {
        f.handler((_req, res) => { if (headers) { res.writeHead(200); res.write('{'); } });
        const start = performance.now();
        const observed = checked(await f.run(), 1, 'timeout');
        assert.equal(observed.reachable, headers);
        assert.ok(performance.now() - start >= 4900);
        assert.ok(performance.now() - start < 8000);
    }
});

test('shared public settings match runtime defaults and worker time boundaries exactly', () => {
    for (const input of [nodeConfig, { allowedSigners: [nodeAddress], ipfsUrl: 'http://127.0.0.1:1' },
        { mode: 'ipfs', allowedSigners: [nodeAddress], ipfsUrl: 'http://127.0.0.1:1' }]) {
        const projection = publicNodeSettings(input);
        const config = parseConfig(input, { env: {} });
        for (const [key, value] of Object.entries(projection)) assert.equal(config[key], value);
    }
    const now = Date.now();
    const at = delta => new Date(now + delta).toISOString();
    for (const [delta, expected] of [[5000, 'fresh'], [5001, 'future'], [-60999, 'fresh'], [-61000, 'stale']]) {
        assert.equal(workerFreshness(at(delta), 1000, now), expected);
    }
});

test('production worker health endpoint exposes loaded public identity and controlled states', async t => {
    for (const mode of ['ledger', 'ipfs']) {
        const f = await fixture(t, 'worker', mode);
        const state = { status: 'starting', completed: 0 };
        const config = parseConfig(f.config, { env: {} });
        // A signer-shaped public object suffices: this endpoint never invokes signing.
        const signer = mode === 'ledger' ? { address: nodeAddress, signTransaction() { throw new Error('Must not sign'); } } : undefined;
        const controller = new AbortController();
        const server = createWorkerHealthServer({ config, signer, target: 'test', state, signal: controller.signal });
        const url = await listen(t, server);
        await f.save({ ...f.profile, healthUrl: url });
        for (const status of ['starting', 'idle', 'processing', 'retrying', 'inbox_unavailable', 'shutting_down', 'stopped']) {
            Object.assign(state, { status, lastPollAt: new Date().toISOString() });
            const healthy = ['idle', 'processing'].includes(status);
            checked(await f.run(), healthy ? 0 : 1, status);
        }
        state.status = 'idle';
        state.lastPollAt = new Date(Date.now() + 60000).toISOString();
        checked(await f.run(), 1, 'future');
        state.lastPollAt = new Date(Date.now() - 62000).toISOString();
        checked(await f.run(), 1, 'stale');
        assert.equal((await fetch(url.replace('/healthz', '/other'))).status, 404);
        state.lastPollAt = new Date().toISOString();
        controller.abort();
        checked(await f.run(), 1, 'shutting_down');
    }
});

test('production direct endpoint is compatible with the host command', async t => {
    const f = await fixture(t);
    const node = createNodeServer({ config: parseConfig(nodeConfig, { env: {} }), nodeAddress,
        fetch: () => { throw new Error('No upstream calls'); } });
    const url = await listen(t, node.server);
    await f.save({ ...f.profile, healthUrl: url });
    checked(await f.run(), 0, 'ready');
});
