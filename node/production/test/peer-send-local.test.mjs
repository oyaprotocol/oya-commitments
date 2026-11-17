import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { sendFromNode, PeerSendError } from '../src/peers/send.mjs';
import { bundledRegistry, nodeSendSettings } from '../src/peers/local.mjs';
import { createInboxServer } from '../src/inbox/http.mjs';
import { validateJob } from '../src/inbox/protocol.mjs';

const cli = fileURLToPath(new URL('../src/peers/client.mjs', import.meta.url));
const node = Wallet.createRandom(), recipient = Wallet.createRandom(), agent = Wallet.createRandom();
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const rejected = code => error => error instanceof PeerSendError && error.code === code && error.message === code;
const queued = async (_url, options) => new Response(JSON.stringify({ requestId: JSON.parse(options.body).requestId, status: 'queued' }), { status: 202 });

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'oya-node-send-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const config = join(directory, 'node.json'), secrets = join(directory, 'node.env');
    const text = join(directory, 'text'), registry = join(directory, 'registry.json');
    const record = { nodeAddress: recipient.address, url: 'https://peer.example/v1/jobs', target: 'test' };
    await writeFile(config, JSON.stringify({ peers: { registryFile: 'registry.json' } }));
    await writeFile(secrets, `OYA_NODE_PRIVATE_KEY=${node.privateKey}\nOYA_RPC_AUTHORIZATION=private-rpc-marker\n`, { mode: 0o600 });
    await writeFile(text, ' exact text\r\n');
    await writeFile(registry, JSON.stringify([record]));
    const env = { OYA_LOCAL_DIR: directory, OYA_NODE_PRIVATE_KEY: agent.privateKey, OYA_AGENT_PRIVATE_KEY: agent.privateKey };
    return { directory, config, secrets, text, registry, record, env, outbox: join(directory, 'peer-outbox') };
}

function run(args, env = {}) {
    return new Promise((resolve, reject) => {
        // Deliberately do not inherit installation selectors or credentials from the test host.
        const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

function safe(value) {
    const output = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of [node.privateKey, agent.privateKey, 'private-rpc-marker', 'exact text', 'signature']) {
        assert.ok(!output.includes(secret));
    }
}

test('node defaults sign as installation node, sync recovery before HTTP, and never copy credentials', async t => {
    const f = await fixture(t);
    const probe = await open(f.text), proto = Object.getPrototypeOf(probe);
    await probe.close();
    const original = proto.sync, synced = [];
    t.mock.method(proto, 'sync', async function() {
        synced.push((await this.stat()).isDirectory() ? 'directory' : 'file');
        return original.call(this);
    });
    let calls = 0;
    const result = await sendFromNode(recipient.address, f.text, { env: f.env, transport: async (url, options) => {
        calls++;
        assert.deepEqual(synced, ['directory', 'file', 'directory']);
        const files = await readdir(f.outbox);
        assert.equal(files.length, 1);
        const saved = await json(join(f.outbox, files[0]));
        assert.equal(files[0], `${saved.job.requestId}.json`);
        assert.deepEqual(saved.job, JSON.parse(options.body));
        await validateJob(saved.job, { target: 'test', allowedSigners: [node.address] });
        assert.equal(saved.job.message.signer.toLowerCase(), node.address.toLowerCase());
        const raw = await readFile(join(f.outbox, files[0]), 'utf8');
        for (const secret of [node.privateKey, agent.privateKey, 'private-rpc-marker']) assert.ok(!raw.includes(secret));
        assert.equal((await stat(join(f.outbox, files[0]))).mode & 0o777, 0o600);
        assert.equal((await stat(f.outbox)).mode & 0o777, 0o700);
        return queued(url, options);
    } });
    assert.equal(calls, 1);
    assert.equal(result.savedFile, join(f.outbox, `${result.requestId}.json`));
    assert.equal(result.outcome, 'admitted');
    safe(result);
});

test('registry defaults are module-relative, configured snapshots are installation-relative and never fall back', async t => {
    const f = await fixture(t);
    await writeFile(f.config, '{}');
    assert.equal((await nodeSendSettings(f.env)).registryFile, bundledRegistry);
    assert.ok(Array.isArray(await json(bundledRegistry)));
    await writeFile(f.config, JSON.stringify({ peers: { registryFile: 'missing.json' } }));
    let calls = 0;
    await assert.rejects(sendFromNode(recipient.address, f.text, { env: f.env, transport: () => { calls++; } }), rejected('invalid_node_settings_or_input'));
    assert.equal(calls, 0);
    await assert.rejects(stat(f.outbox), { code: 'ENOENT' });
});

test('missing, ambiguous, malformed or oversized settings and keys fail without effects or ambient fallback', async t => {
    const f = await fixture(t);
    let calls = 0;
    const send = env => sendFromNode(recipient.address, f.text, { env, transport: () => { calls++; } });
    for (const env of [{}, { OYA_LOCAL_DIR: '' }, { OYA_LOCAL_DIR: '.' }, { OYA_LOCAL_DIR: f.directory + '/missing' }]) {
        await assert.rejects(send(env), rejected('invalid_node_settings_or_input'));
    }
    const original = await readFile(f.secrets);
    for (const text of ['', 'OYA_AGENT_PRIVATE_KEY=' + agent.privateKey, 'workerToken=private-token',
        `OYA_NODE_PRIVATE_KEY=${node.privateKey}\nOYA_NODE_PRIVATE_KEY=${agent.privateKey}`,
        `OYA_NODE_PRIVATE_KEY="${node.privateKey}"`, 'OYA_NODE_PRIVATE_KEY=bad',
        'OYA_NODE_PRIVATE_KEY=0x' + '0'.repeat(64), 'x'.repeat(16385), Buffer.from([0xff])]) {
        await writeFile(f.secrets, text);
        await assert.rejects(send(f.env), rejected('invalid_node_settings_or_input'));
    }
    await rm(f.secrets);
    await assert.rejects(send(f.env), rejected('invalid_node_settings_or_input'));
    await writeFile(f.secrets, original, { mode: 0o600 });
    for (const config of ['bad-json', 'null', '[]', '{"peers":null}', '{"peers":{"registryFile":""}}',
        '{"peers":{"registryFile":"registry.json","unexpected":true}}', ' '.repeat(1048577)]) {
        await writeFile(f.config, config);
        await assert.rejects(send(f.env), rejected('invalid_node_settings_or_input'));
    }
    assert.equal(calls, 0);
    await assert.rejects(stat(f.outbox), { code: 'ENOENT' });
    const result = await run(['send', recipient.address, f.text], f.env);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).code, 'invalid_node_settings_or_input');
    assert.equal(result.stderr, '');
    safe(result.stdout);
});

test('unsafe secret files and installation permissions fail closed', async t => {
    const f = await fixture(t);
    const send = () => sendFromNode(recipient.address, f.text, { env: f.env, transport: () => assert.fail('HTTP forbidden') });
    await chmod(f.secrets, 0o644);
    await assert.rejects(send(), rejected('invalid_node_settings_or_input'));
    await chmod(f.secrets, 0o600);
    await chmod(f.directory, 0o755);
    await assert.rejects(send(), rejected('invalid_node_settings_or_input'));
    await chmod(f.directory, 0o700);
    const alternate = join(f.directory, 'alternate');
    await link(f.secrets, alternate);
    await assert.rejects(send(), rejected('invalid_node_settings_or_input'));
    await rm(f.secrets);
    await symlink(alternate, f.secrets);
    await assert.rejects(send(), rejected('invalid_node_settings_or_input'));
    await rm(f.secrets);
    await mkdir(f.secrets);
    await assert.rejects(send(), rejected('invalid_node_settings_or_input'));
    const alias = join(f.directory, 'alias');
    await symlink(f.directory, alias);
    await assert.rejects(sendFromNode(recipient.address, f.text, { env: { OYA_LOCAL_DIR: alias + '/' } }), rejected('invalid_node_settings_or_input'));
});

test('unsafe or blocked managed outboxes never send and report recovery location', async t => {
    const f = await fixture(t);
    const send = () => sendFromNode(recipient.address, f.text, { env: f.env, transport: () => assert.fail('HTTP forbidden') });
    const check = error => {
        assert.ok(rejected('save_failed')(error));
        assert.equal(error.savedFile.startsWith(f.outbox + '/'), true);
        return true;
    };
    await writeFile(f.outbox, 'preserve');
    await assert.rejects(send(), check);
    assert.equal(await readFile(f.outbox, 'utf8'), 'preserve');
    await rm(f.outbox);
    await symlink(f.directory, f.outbox);
    await assert.rejects(send(), check);
    await rm(f.outbox);
    await mkdir(f.outbox, { mode: 0o755 });
    await chmod(f.outbox, 0o755);
    await assert.rejects(send(), check);
    assert.deepEqual(await readdir(f.outbox), []);
});

test('each managed sync boundary fails closed with retained evidence and no HTTP', async t => {
    for (const boundary of [1, 2, 3]) {
        const f = await fixture(t);
        const probe = await open(f.text), proto = Object.getPrototypeOf(probe);
        await probe.close();
        const original = proto.sync;
        let calls = 0;
        const mock = t.mock.method(proto, 'sync', async function() {
            if (++calls === boundary) throw new Error('private-rpc-marker');
            return original.call(this);
        });
        let failure;
        await assert.rejects(sendFromNode(recipient.address, f.text, { env: f.env, transport: () => assert.fail('HTTP forbidden') }), error => {
            failure = error;
            return rejected('save_failed')(error);
        });
        mock.mock.restore();
        assert.equal(calls, boundary);
        safe(failure.message);
        if (boundary === 1) assert.deepEqual(await readdir(f.outbox), []);
        else assert.equal((await json(failure.savedFile)).job.message.signer.toLowerCase(), node.address.toLowerCase());
    }
});

test('two-argument CLI handles lost acknowledgement and restart recovery without config, keys or automatic retry', async t => {
    const f = await fixture(t);
    const admitted = new Map(), received = [];
    let disconnect = true;
    const server = createInboxServer({ config: { target: 'test', allowedSigners: [node.address] }, workerToken: 'unused', store: {
        async enqueue(job) { admitted.set(job.requestId, { requestId: job.requestId, status: 'queued' }); return admitted.get(job.requestId); },
        async status(job) { return admitted.get(job.requestId); },
    } });
    // Capture requests ahead of the ordinary handler and lose the first response after admission.
    server.prependListener('request', (req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => received.push([req.url, body]));
        if (disconnect && req.url === '/v1/jobs') {
            disconnect = false;
            res.end = () => { res.destroy(); return res; };
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    await writeFile(f.registry, JSON.stringify([{ ...f.record, url: `http://127.0.0.1:${server.address().port}/v1/jobs` }]));
    const sent = await run(['send', recipient.address, f.text], f.env);
    assert.equal(sent.code, 1, sent.stdout + sent.stderr);
    const result = JSON.parse(sent.stdout);
    assert.equal(result.outcome, 'delivery_unknown');
    assert.equal(received.length, 1);
    assert.equal(admitted.size, 1);
    safe(sent.stdout);
    const original = await readFile(result.savedFile, 'utf8');
    await Promise.all([f.secrets, f.config, f.registry, f.text].map(path => rm(path)));
    const status = await run(['status', result.savedFile]);
    assert.equal(status.code, 0, status.stdout);
    const retry = await run(['retry', result.savedFile]);
    assert.equal(retry.code, 0, retry.stdout);
    assert.equal(received.length, 3);
    assert.equal(received[0][1], received[1][1]);
    assert.deepEqual(received[0], received[2]);
    assert.equal(await readFile(result.savedFile, 'utf8'), original);
    assert.deepEqual(await readdir(f.outbox), [`${result.requestId}.json`]);
});

test('concurrent deliberately new sends use distinct managed files without replacing evidence', async t => {
    const f = await fixture(t);
    const results = await Promise.all([1, 2].map(() => sendFromNode(recipient.address, f.text, { env: f.env, transport: queued })));
    assert.notEqual(results[0].savedFile, results[1].savedFile);
    assert.equal((await readdir(f.outbox)).length, 2);
    for (const result of results) assert.equal((await json(result.savedFile)).job.requestId, result.requestId);
});
