import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, verifyMessage } from 'ethers';
import { PeerSendError, sendToPeer, retryPeerJob, peerJobStatus } from '../src/peers/send.mjs';
import { createInboxServer } from '../src/inbox/http.mjs';
import { jobText, signJob, validateJob } from '../src/inbox/protocol.mjs';

const cli = fileURLToPath(new URL('../src/peers/client.mjs', import.meta.url));
const recipient = Wallet.createRandom();
const other = Wallet.createRandom();
const sender = Wallet.createRandom();
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const json = value => new Response(JSON.stringify(value), { status: 202 });
const queued = async (_url, options) => json({ requestId: JSON.parse(options.body).requestId, status: 'queued' });
const localError = code => error => error instanceof PeerSendError && error.code === code && error.message === code;

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'oya-peer-send-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const options = { registryFile: join(directory, 'registry.json'), nodeAddress: recipient.address,
        keyFile: join(directory, 'key'), textFile: join(directory, 'text'), outputFile: join(directory, 'saved.json') };
    const record = { nodeAddress: recipient.address, url: 'https://peer.example/v1/jobs', target: 'test' };
    await writeFile(options.registryFile, JSON.stringify([record]));
    await writeFile(options.keyFile, sender.privateKey + '\n', { mode: 0o600 });
    await writeFile(options.textFile, ' original\r\ntext\t\n');
    return { directory, options, record, save: value => writeFile(options.outputFile, JSON.stringify(value)) };
}

async function listen(t, server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}

function run(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', code => resolve({ code, stdout, stderr }));
    });
}
const sendArgs = options => ['send', options.registryFile, options.nodeAddress, options.keyFile, options.textFile, options.outputFile];

function safeOutput(value, f) {
    const output = typeof value === 'string' ? value : JSON.stringify(value);
    for (const forbidden of [sender.privateKey, 'original', 'private-upstream-marker', f.options.keyFile]) {
        assert.ok(!output.includes(forbidden), 'private material must not appear in output');
    }
}

test('importable send saves exact ordinary signatures and destination before one HTTP request', async t => {
    const f = await fixture(t);
    let calls = 0;
    const before = Date.now();
    const defaultJob = await signJob(sender, 'test', 'protocol default lifetime');
    const result = await sendToPeer(f.options, { transport: async (url, options) => {
        calls++;
        assert.equal(url, 'https://peer.example/v1/jobs');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        assert.deepEqual(options.headers, { 'content-type': 'application/json' });
        const saved = await readJson(f.options.outputFile);
        assert.equal((await stat(f.options.outputFile)).mode & 0o777, 0o600);
        assert.deepEqual(saved.destination, { nodeAddress: recipient.address.toLowerCase(), origin: 'https://peer.example', target: 'test' });
        assert.deepEqual(JSON.parse(options.body), saved.job);
        assert.equal(saved.job.message.text, await readFile(f.options.textFile, 'utf8'));
        assert.equal(verifyMessage(saved.job.message.text, saved.job.message.signature), sender.address);
        await validateJob(saved.job, { target: 'test', allowedSigners: [sender.address] });
        assert.ok(saved.job.expiresAt >= defaultJob.expiresAt &&
            saved.job.expiresAt <= defaultJob.expiresAt + Date.now() - before);
        return queued(url, options);
    } });
    assert.equal(calls, 1);
    assert.equal(result.outcome, 'admitted');
    assert.equal(result.admission, 'reported');
    assert.equal(result.execution, 'queued');
    safeOutput(result, f);
});

test('selection rejects missing, ambiguous, malformed and oversized registry input without effects', async t => {
    const f = await fixture(t);
    let calls = 0;
    const transport = () => { calls++; throw new Error(); };
    for (const records of [[], {}, null, [null], [f.record, { ...f.record, nodeAddress: recipient.address.toLowerCase() }],
        [{ ...f.record, nodeAddress: other.address }], [{ ...f.record, nodeAddress: '0x' + '0'.repeat(40) }],
        [{ ...f.record, nodeAddress: 'not-an-address' }], [{ ...f.record, target: '' }], Array(1001).fill(f.record)]) {
        await writeFile(f.options.registryFile, JSON.stringify(records));
        await assert.rejects(sendToPeer(f.options, { transport }), localError('invalid_input'));
    }
    for (const raw of ['invalid-json', ' '.repeat(1048577), Buffer.from([0xff])]) {
        await writeFile(f.options.registryFile, raw);
        await assert.rejects(sendToPeer(f.options, { transport }), localError('invalid_input'));
    }
    await writeFile(f.options.registryFile, JSON.stringify([f.record]));
    for (const nodeAddress of ['', recipient.address + ' ', '0x' + '0'.repeat(40), recipient.address.slice(2)]) {
        await assert.rejects(sendToPeer({ ...f.options, nodeAddress }, { transport }), localError('invalid_input'));
    }
    await rm(f.options.registryFile);
    await assert.rejects(sendToPeer(f.options, { transport }), localError('invalid_input'));
    await assert.rejects(stat(f.options.outputFile), { code: 'ENOENT' });
    assert.equal(calls, 0);
});

test('selected routing rejects URL credentials, normalization tricks, paths and invalid targets', async t => {
    const f = await fixture(t);
    let calls = 0;
    const transport = () => { calls++; throw new Error(); };
    for (const url of ['https://peer.example', 'https://peer.example/v1/jobs/', 'https://peer.example/v1/status',
        'https://user:secret@peer.example/v1/jobs', 'https://@peer.example/v1/jobs', 'https://peer.example/v1/jobs?secret=x',
        'https://peer.example/v1/jobs#fragment', 'https://peer.example/v1/jobs?', 'https://peer.example/v1/jobs#',
        'http://peer.example/v1/jobs', 'file:///v1/jobs', '//peer.example/v1/jobs',
        'https://peer.example/a/../v1/jobs', 'https://peer.example/%76%31/jobs',
        ' https://peer.example/v1/jobs', 'https://peer.example\n/v1/jobs', 'https://peer.example\\v1/jobs']) {
        await writeFile(f.options.registryFile, JSON.stringify([{ ...f.record, url }]));
        await assert.rejects(sendToPeer(f.options, { transport }), localError('invalid_input'));
    }
    for (const target of ['', 'UPPER', '../test', 'with space', 'a'.repeat(65), null]) {
        await writeFile(f.options.registryFile, JSON.stringify([{ ...f.record, target }]));
        await assert.rejects(sendToPeer(f.options, { transport }), localError('invalid_input'));
    }
    assert.equal(calls, 0);
    await assert.rejects(stat(f.options.outputFile), { code: 'ENOENT' });
});

test('bounded text/key validation preserves the maximum payload and rejects invalid input before saving', async t => {
    const f = await fixture(t);
    let calls = 0;
    const transport = async (url, options) => { calls++; return queued(url, options); };
    for (const text of ['', 'bad\0text', 'café', Buffer.from([0xff]), 'a'.repeat(8193)]) {
        await writeFile(f.options.textFile, text);
        await assert.rejects(sendToPeer(f.options, { transport }), localError('invalid_input'));
    }
    await writeFile(f.options.textFile, 'valid');
    for (const key of ['', 'bad-key', '0x' + '0'.repeat(64), 'a'.repeat(257), Buffer.from([0xff])]) {
        await writeFile(f.options.keyFile, key);
        await assert.rejects(sendToPeer(f.options, { transport }), localError('invalid_input'));
    }
    await assert.rejects(sendToPeer({ ...f.options, textFile: f.directory }, { transport }), localError('invalid_input'));
    await assert.rejects(stat(f.options.outputFile), { code: 'ENOENT' });
    assert.equal(calls, 0);
    await writeFile(f.options.keyFile, sender.privateKey);
    const text = 'a'.repeat(8189) + '\r\n\t';
    await writeFile(f.options.textFile, text);
    await sendToPeer(f.options, { transport });
    assert.equal((await readJson(f.options.outputFile)).job.message.text, text);
    assert.equal(calls, 1);
});

test('existing output, symlink, missing parent and sync failure send nothing and retain evidence', async t => {
    const f = await fixture(t);
    let calls = 0;
    const transport = async () => { calls++; throw new Error(); };
    await writeFile(f.options.outputFile, 'previous-evidence');
    await assert.rejects(sendToPeer(f.options, { transport }), localError('save_failed'));
    assert.equal(await readFile(f.options.outputFile, 'utf8'), 'previous-evidence');
    await rm(f.options.outputFile);
    await symlink(f.options.textFile, f.options.outputFile);
    await assert.rejects(sendToPeer(f.options, { transport }), localError('save_failed'));
    await rm(f.options.outputFile);
    await assert.rejects(sendToPeer({ ...f.options, outputFile: join(f.directory, 'missing', 'job') }, { transport }), localError('save_failed'));
    const probe = await open(f.options.textFile);
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const sync = prototype.sync;
    let syncs = 0;
    t.mock.method(prototype, 'sync', async function() {
        syncs++;
        if ((await this.stat()).isDirectory()) throw new Error('private-upstream-marker');
        return sync.call(this);
    });
    await assert.rejects(sendToPeer(f.options, { transport }), localError('save_failed'));
    assert.equal(syncs, 2, 'sync file, then parent directory, before HTTP');
    assert.equal((await readJson(f.options.outputFile)).version, 1);
    assert.equal(calls, 0);
});

test('restart recovery pins original destination and exact bytes without key, text or registry', async t => {
    const f = await fixture(t);
    const sent = [];
    await sendToPeer(f.options, { transport: async (url, options) => {
        sent.push([url, options.body]); throw new Error('private-upstream-marker');
    } });
    const original = await readFile(f.options.outputFile, 'utf8');
    await writeFile(f.options.registryFile, JSON.stringify([{ ...f.record, url: 'https://replacement.example/v1/jobs' }]));
    await rm(f.options.keyFile); await rm(f.options.textFile);
    const retry = await retryPeerJob(f.options.outputFile, { transport: async (url, options) => {
        sent.push([url, options.body]); return queued(url, options);
    } });
    assert.equal(retry.outcome, 'admitted');
    assert.deepEqual(sent[0], sent[1]);
    await rm(f.options.registryFile);
    const status = await peerJobStatus(f.options.outputFile, { transport: async (url, options) => {
        assert.equal(url, 'https://peer.example/v1/status');
        assert.equal(options.body, sent[0][1]); return queued(url, options);
    } });
    assert.equal(status.outcome, 'status');
    assert.equal(await readFile(f.options.outputFile, 'utf8'), original);
});

test('saved-file validation rejects corruption, signatures, mismatched target and oversized input before HTTP', async t => {
    const f = await fixture(t);
    await sendToPeer(f.options, { transport: queued });
    const saved = await readJson(f.options.outputFile);
    let calls = 0;
    const transport = () => { calls++; throw new Error(); };
    const altered = [null, {}, saved.job, { ...saved, version: 2 }, { ...saved, extra: true },
        { ...saved, destination: { ...saved.destination, origin: 'https://user:secret@peer.example' } },
        { ...saved, destination: { ...saved.destination, origin: 'https://peer.example/' } },
        { ...saved, destination: { ...saved.destination, target: 'other' } },
        { ...saved, job: { ...saved.job, requestSignature: saved.job.message.signature } },
        { ...saved, job: { ...saved.job, message: { ...saved.job.message, text: 'tampered' } } },
        { ...saved, job: { ...saved.job, expiresAt: saved.job.expiresAt + 1 } },
        { ...saved, job: { ...saved.job, requestId: crypto.randomUUID() } }];
    for (const value of altered) {
        await f.save(value);
        for (const action of [retryPeerJob, peerJobStatus]) {
            await assert.rejects(action(f.options.outputFile, { transport }), localError('invalid_saved_job'));
        }
    }
    for (const raw of ['not-json', ' '.repeat(65537), Buffer.from([0xff])]) {
        await writeFile(f.options.outputFile, raw);
        await assert.rejects(retryPeerJob(f.options.outputFile, { transport }), localError('invalid_saved_job'));
    }
    await rm(f.options.outputFile);
    await assert.rejects(peerJobStatus(f.options.outputFile, { transport }), localError('invalid_saved_job'));
    assert.equal(calls, 0);
});

test('expired jobs remain status-queryable but retries never renew the deadline', async t => {
    const f = await fixture(t);
    await sendToPeer(f.options, { transport: queued });
    const saved = await readJson(f.options.outputFile);
    saved.job = await signJob(sender, 'test', 'expired', { expiresAt: Date.now() - 1 });
    await f.save(saved);
    let calls = 0;
    const transport = async (_url, options) => {
        calls++; assert.deepEqual(JSON.parse(options.body), saved.job);
        return json({ requestId: saved.job.requestId, status: 'expired' });
    };
    await assert.rejects(retryPeerJob(f.options.outputFile, { transport }), localError('job_expired'));
    const result = await peerJobStatus(f.options.outputFile, { transport });
    assert.equal(result.execution, 'expired');
    assert.equal(calls, 1);
    assert.deepEqual(await readJson(f.options.outputFile), saved);
});

test('remote failure paths are sanitized, bounded, preserve saved jobs and never retry', async t => {
    const f = await fixture(t);
    const failures = [
        async () => { throw new Error('private-upstream-marker'); },
        async () => new Response('private-upstream-marker'),
        async () => new Response('x'.repeat(131073)),
        async () => new Response(Buffer.from([0xff])),
        async () => json({ requestId: crypto.randomUUID(), status: 'queued' }),
        async () => json({ status: 'queued' }),
        async (_url, options) => json({ requestId: JSON.parse(options.body).requestId, status: 'private-upstream-marker' }),
        async () => ({ ok: true, body: (async function* () { yield Buffer.from('{'); throw new Error('private-upstream-marker'); })() }),
    ];
    for (const failure of failures) {
        let calls = 0;
        const result = await sendToPeer(f.options, { transport: async (...args) => { calls++; return failure(...args); } });
        assert.equal(result.outcome, 'delivery_unknown');
        assert.equal(result.admission, 'unknown');
        assert.equal(result.execution, 'unknown');
        assert.equal(calls, 1);
        safeOutput(result, f);
        assert.equal((await readJson(f.options.outputFile)).job.requestId, result.requestId);
        await rm(f.options.outputFile);
    }
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
        const result = await sendToPeer(f.options, { transport: async () => new Response('private-upstream-marker', { status }) });
        assert.equal(result.outcome, 'http_error');
        assert.equal(result.httpStatus, status);
        assert.equal(result.admission, 'unknown');
        safeOutput(result, f);
        await rm(f.options.outputFile);
    }
});

test('short filesystem reads stay bounded and close every handle on rejection', async t => {
    const f = await fixture(t);
    await writeFile(f.options.textFile, 'x'.repeat(65536));
    const textInode = (await stat(f.options.textFile)).ino;
    const probe = await open(f.options.textFile);
    const prototype = Object.getPrototypeOf(probe);
    const read = prototype.read;
    await probe.close();
    const handles = new Set();
    let bytes = 0;
    t.mock.method(prototype, 'read', async function(buffer, offset, length, position) {
        handles.add(this);
        const isText = (await this.stat()).ino === textInode;
        if (isText) assert.equal(buffer.length, 8193);
        const result = await read.call(this, buffer, offset, Math.min(length, 127), position);
        if (isText) bytes += result.bytesRead;
        return result;
    });
    await assert.rejects(sendToPeer(f.options, { transport: () => assert.fail('No HTTP') }), localError('invalid_input'));
    assert.equal(bytes, 8193);
    for (const handle of handles) assert.equal(handle.fd, -1);
    await assert.rejects(stat(f.options.outputFile), { code: 'ENOENT' });
});

test('partial write and file sync failure retain output but cannot submit', async t => {
    const f = await fixture(t);
    const probe = await open(f.options.textFile);
    const prototype = Object.getPrototypeOf(probe);
    const write = prototype.writeFile;
    await probe.close();
    const partial = t.mock.method(prototype, 'writeFile', async function() {
        await write.call(this, '{"version":');
        throw new Error('private-upstream-marker');
    });
    await assert.rejects(sendToPeer(f.options, { transport: () => assert.fail('No HTTP') }), localError('save_failed'));
    assert.equal(await readFile(f.options.outputFile, 'utf8'), '{"version":');
    partial.mock.restore();
    await rm(f.options.outputFile);
    t.mock.method(prototype, 'sync', async () => { throw new Error('private-upstream-marker'); });
    await assert.rejects(sendToPeer(f.options, { transport: () => assert.fail('No HTTP') }), localError('save_failed'));
    assert.equal((await readJson(f.options.outputFile)).version, 1);
});

test('valid outer signature cannot conceal a forged inner message or out-of-range expiry', async t => {
    const f = await fixture(t);
    await sendToPeer(f.options, { transport: queued });
    const saved = await readJson(f.options.outputFile);
    saved.job.message.signature = await other.signMessage(saved.job.message.text);
    saved.job.requestSignature = await sender.signMessage(jobText(saved.job));
    await f.save(saved);
    for (const action of [retryPeerJob, peerJobStatus]) {
        await assert.rejects(action(f.options.outputFile, { transport: () => assert.fail('No HTTP') }), localError('invalid_saved_job'));
    }
    saved.job = await signJob(sender, 'test', 'future', { expiresAt: Date.now() + 8 * 86400_000 });
    await f.save(saved);
    await assert.rejects(retryPeerJob(f.options.outputFile, { transport: () => assert.fail('No HTTP') }), localError('invalid_saved_job'));
});

test('existing deadline bounds both stalled headers and bodies without retry', async t => {
    const f = await fixture(t);
    const timeout = AbortSignal.timeout;
    t.mock.method(AbortSignal, 'timeout', ms => {
        assert.equal(ms, 10000, 'retain existing ten-second production deadline');
        return timeout(100);
    });
    let hits = 0;
    let body = false;
    const origin = await listen(t, createServer((req, res) => {
        hits++; req.resume();
        if (body) { res.writeHead(202, { 'content-type': 'application/json' }); res.write('{'); }
    }));
    await writeFile(f.options.registryFile, JSON.stringify([{ ...f.record, url: `${origin}/v1/jobs` }]));
    const first = await sendToPeer(f.options);
    assert.equal(first.outcome, 'delivery_unknown');
    body = true;
    const second = await peerJobStatus(f.options.outputFile);
    assert.equal(second.outcome, 'status_unknown');
    assert.equal(hits, 2);
    safeOutput(first, f); safeOutput(second, f);
});

test('reported execution is allowlisted and never exposes arbitrary response details', async t => {
    const f = await fixture(t);
    for (const status of ['queued', 'processing', 'published', 'logged', 'failed', 'expired']) {
        const result = await sendToPeer(f.options, { transport: async (_url, options) => json({
            requestId: JSON.parse(options.body).requestId, status, result: { secret: 'private-upstream-marker' }, error: sender.privateKey
        }) });
        assert.equal(result.execution, status);
        assert.equal(result.admission, 'reported');
        safeOutput(result, f);
        await rm(f.options.outputFile);
    }
});

test('real CLI reaches ordinary inbox admission and resumes exact request after process restart', async t => {
    const f = await fixture(t);
    const jobs = new Map();
    const observed = [];
    const store = {
        enqueue: async job => {
            const saved = await readJson(f.options.outputFile);
            assert.deepEqual(saved.job, job, 'saved before server sees the request');
            observed.push(job);
            jobs.set(job.requestId, job);
            return { requestId: job.requestId, status: 'queued' };
        },
        status: async job => {
            assert.deepEqual(jobs.get(job.requestId), job);
            return { requestId: job.requestId, status: 'processing' };
        },
    };
    const config = { target: 'test', allowedSigners: [sender.address] };
    const origin = await listen(t, createInboxServer({ config, workerToken: 'fixture', store }));
    await writeFile(f.options.registryFile, JSON.stringify([{ ...f.record, url: `${origin}/v1/jobs` }]));
    const first = await run(sendArgs(f.options));
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stderr, '');
    assert.equal(JSON.parse(first.stdout).execution, 'queued');
    safeOutput(first.stdout, f);
    const saved = await readJson(f.options.outputFile);
    await rm(f.options.keyFile); await rm(f.options.textFile); await rm(f.options.registryFile);
    const status = await run(['status', f.options.outputFile]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).execution, 'processing');
    const retry = await run(['retry', f.options.outputFile]);
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(JSON.parse(retry.stdout).requestId, saved.job.requestId);
    assert.deepEqual(observed, [saved.job, saved.job]);
    assert.equal(jobs.size, 1);
    config.allowedSigners = [other.address];
    const revoked = await run(['status', f.options.outputFile]);
    assert.equal(revoked.code, 1);
    assert.equal(JSON.parse(revoked.stdout).httpStatus, 403);
});

test('real lost acknowledgement retains job and status recovers without replacement', async t => {
    const f = await fixture(t);
    let admitted;
    let posts = 0;
    const origin = await listen(t, createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const job = JSON.parse(Buffer.concat(chunks));
        await validateJob(job, { target: 'test', allowedSigners: [sender.address] });
        if (req.url === '/v1/jobs') { posts++; admitted = job; req.socket.destroy(); }
        else { assert.deepEqual(job, admitted); res.end(JSON.stringify({ requestId: job.requestId, status: 'queued' })); }
    }));
    await writeFile(f.options.registryFile, JSON.stringify([{ ...f.record, url: `${origin}/v1/jobs` }]));
    const first = await run(sendArgs(f.options));
    assert.equal(first.code, 1);
    assert.equal(JSON.parse(first.stdout).outcome, 'delivery_unknown');
    const recovered = await run(['status', f.options.outputFile]);
    assert.equal(recovered.code, 0);
    assert.equal(JSON.parse(recovered.stdout).requestId, admitted.requestId);
    assert.equal(posts, 1);
});

test('actual redirects are not followed and CLI usage/local failures have safe exit codes', async t => {
    const f = await fixture(t);
    let hits = 0;
    const origin = await listen(t, createServer((_req, res) => {
        hits++; res.writeHead(307, { location: '/unexpected' }); res.end();
    }));
    await writeFile(f.options.registryFile, JSON.stringify([{ ...f.record, url: `${origin}/v1/jobs` }]));
    const result = await run(sendArgs(f.options));
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).outcome, 'delivery_unknown');
    assert.equal(hits, 1);
    const help = await run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /REGISTRY_FILE NODE_ADDRESS KEY_FILE TEXT_FILE OUTPUT_FILE/);
    for (const args of [[], ['send'], ['status'], ['retry', f.options.outputFile, 'https://replacement.example'], ['status', 'missing']]) {
        const invalid = await run(args);
        assert.equal(invalid.code, 2);
        assert.equal(invalid.stderr, '');
        assert.equal(JSON.parse(invalid.stdout).outcome, 'local_error');
        safeOutput(invalid.stdout, f);
    }
    assert.equal(hits, 1);
});
