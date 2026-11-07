import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { main } from '../src/inbox/client.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Wallet } from 'ethers';
import { InboxError, validateJob } from '../src/inbox/protocol.mjs';
import { createInboxClient } from '../src/inbox/http.mjs';

const client = fileURLToPath(new URL('../src/inbox/client.mjs', import.meta.url));

for (const [status, body] of [
    [401, '{"error":"private upstream detail"}'], [502, '<html>private upstream detail</html>'],
    [503, ''], [304, null],
]) {
    test(`inbox client preserves HTTP ${status} without exposing the response body`, async () => {
        const api = createInboxClient('https://inbox.invalid', undefined, async () => new Response(body, { status }));
        await assert.rejects(api('/v1/status', {}), error => {
            assert.ok(error instanceof InboxError);
            assert.equal(error.status, status);
            assert.equal(error.code, 'inbox_request_failed');
            assert.equal(error.message, 'inbox_request_failed');
            return true;
        });
    });
}

test('inbox client retains successful JSON parsing and response limits', async () => {
    const api = (body, status = 200) => createInboxClient('https://inbox.invalid', undefined,
        async () => new Response(body, { status }))('/v1/status', {});
    assert.deepEqual(await api('{"status":"queued"}'), { status: 'queued' });
    await assert.rejects(api('<html>not JSON</html>'), SyntaxError);
    await assert.rejects(api(null, 204), SyntaxError);
    assert.equal((await api('"' + 'x'.repeat(131070) + '"')).length, 131070);
    for (const status of [200, 503]) {
        await assert.rejects(api('x'.repeat(131073), status), { message: 'Inbox response exceeds limit.' });
    }
});

test('inbox client rejects malformed UTF-8 without rewriting successful responses', async () => {
    const api = (bytes, status = 200) => createInboxClient('https://inbox.invalid', undefined,
        async () => new Response(bytes, { status }))('/v1/status', {});
    for (const invalid of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
        const bytes = Buffer.concat([Buffer.from('{"status":"published","cid":"'), Buffer.from(invalid), Buffer.from('"}')]);
        await assert.rejects(api(bytes), TypeError);
        await assert.rejects(api(bytes, 503), error => error instanceof InboxError && error.status === 503);
    }
    // Preserve JSON's existing rejection of a leading BOM rather than stripping it.
    await assert.rejects(api(Buffer.from('\ufeff{"work":null}')), SyntaxError);
    const expected = { value: 'café 😀 \ufffd' };
    const bytes = Buffer.from(JSON.stringify(expected));
    const streaming = createInboxClient('https://inbox.invalid', undefined, async () => ({
        ok: true,
        body: (async function* () { for (const byte of bytes) yield Uint8Array.of(byte); })(),
    }));
    assert.deepEqual(await streaming('/v1/status', {}), expected);
});

test('inbox client retains transport and incomplete-body failures', async () => {
    const failure = new Error('fixture connection failure');
    const transport = createInboxClient('https://inbox.invalid', undefined, async () => { throw failure; });
    await assert.rejects(transport('/v1/status', {}), error => error === failure);
    const streaming = createInboxClient('https://inbox.invalid', undefined, async () => ({
        ok: false, status: 503,
        body: (async function* () { yield Buffer.from('partial'); throw failure; })(),
    }));
    await assert.rejects(streaming('/v1/status', {}), error => error === failure);
});

test('inbox prepare bounds message reads even with short filesystem reads', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oya-inbox-bounded-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const key = join(directory, 'key');
    const textFile = join(directory, 'message');
    const jobFile = join(directory, 'job.json');
    const wallet = Wallet.createRandom();
    await writeFile(key, wallet.privateKey, { mode: 0o600 });
    await writeFile(textFile, 'a'.repeat(65536));
    const probe = await open(textFile, 'r');
    const prototype = Object.getPrototypeOf(probe);
    const read = prototype.read;
    await probe.close();
    let total = 0;
    const handles = new Set();
    t.mock.method(prototype, 'read', async function(buffer, offset, length, position) {
        assert.ok(buffer.length <= 8193, 'message buffer must be bounded');
        const result = await read.call(this, buffer, offset, Math.min(length, 127), position);
        total += result.bytesRead;
        handles.add(this);
        return result;
    });
    await assert.rejects(main(['prepare', key, 'test', textFile, jobFile]), { message: 'Message too large.' });
    assert.equal(total, 8193, 'read only the limit plus one overflow byte');
    await assert.rejects(stat(jobFile), { code: 'ENOENT' });
    for (const handle of handles) assert.equal(handle.fd, -1, 'close rejected input');
    total = 0;
    handles.clear();
    const text = 'a'.repeat(8189) + '\r\n\t';
    await writeFile(textFile, text);
    t.mock.method(console, 'log', () => {});
    await main(['prepare', key, 'test', textFile, jobFile]);
    assert.equal(total, 8192);
    const job = JSON.parse(await readFile(jobFile, 'utf8'));
    assert.equal(job.message.text, text);
    await validateJob(job, { target: 'test', allowedSigners: [wallet.address] });
    for (const handle of handles) assert.equal(handle.fd, -1, 'close accepted input');
});

test('inbox prepare rejects unsupported text before creating a signed job', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oya-inbox-client-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const wallet = Wallet.createRandom();
    const key = join(directory, 'key');
    const textFile = join(directory, 'message');
    const jobFile = join(directory, 'job.json');
    await writeFile(key, wallet.privateKey + '\n', { mode: 0o600 });
    for (const [name, text] of [
        ['empty', ''], ['non-ASCII', 'café'], ['invalid UTF-8', Buffer.from([0xff])],
        ['NUL', 'before\0after'],
        ['oversized', 'a'.repeat(8193)],
    ]) {
        await t.test(name, async () => {
            await writeFile(textFile, text);
            const result = spawnSync(process.execPath, [client, 'prepare', key, 'test', textFile, jobFile], { encoding: 'utf8' });
            assert.equal(result.status, 1);
            assert.equal(result.stdout, '');
            await assert.rejects(stat(jobFile), { code: 'ENOENT' });
        });
        // Keep subtests independent even if the unfixed client wrote a job.
        await rm(jobFile, { force: true });
    }
    await t.test('valid ASCII at the byte limit preserves exact text and signatures', async () => {
        const text = 'a'.repeat(8189) + '\r\n\t';
        await writeFile(textFile, text);
        const result = spawnSync(process.execPath, [client, 'prepare', key, 'test', textFile, jobFile], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const job = JSON.parse(await readFile(jobFile, 'utf8'));
        assert.equal(job.message.text, text);
        await validateJob(job, { target: 'test', allowedSigners: [wallet.address] });
        assert.equal((await stat(jobFile)).mode & 0o777, 0o600);
    });
});
