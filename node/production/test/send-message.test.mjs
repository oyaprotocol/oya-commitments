import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { Wallet, verifyMessage } from 'ethers';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/send-message.mjs', import.meta.url));

async function fixture(t, handler) {
    const directory = await mkdtemp(join(tmpdir(), 'oya-sender-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const textFile = join(directory, 'message.txt');
    await writeFile(textFile, 'exact message\n');
    const wallet = Wallet.createRandom();
    let requests = 0;
    const server = createServer(async (request, response) => {
        requests++;
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        handler(response, JSON.parse(Buffer.concat(chunks).toString()));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return {
        wallet, requests: () => requests,
        send(timeout) {
            const env = { ...process.env, OYA_AGENT_PRIVATE_KEY: wallet.privateKey };
            delete env.OYA_MESSAGE_TIMEOUT_MS;
            if (timeout !== undefined) env.OYA_MESSAGE_TIMEOUT_MS = timeout;
            return execute(process.execPath, [script, `http://127.0.0.1:${server.address().port}`, textFile],
                { env, timeout: 5000 });
        },
    };
}

for (const phase of ['headers', 'body']) {
    test(`sender bounds stalled ${phase} without retrying or leaking input`, async t => {
        const f = await fixture(t, response => {
            if (phase === 'body') {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.write('{"private-marker":');
            }
        });
        await assert.rejects(f.send('250'), error => {
            assert.equal(error.killed, false, 'sender must exit itself, not the test watchdog');
            assert.equal(error.code, 1);
            assert.equal(error.stdout, '');
            assert.match(error.stderr, /timed out/);
            assert.match(error.stderr, /may still complete/);
            assert.match(error.stderr, /before retrying/);
            assert.doesNotMatch(error.stderr, /private-marker|exact message|127\.0\.0\.1/);
            assert.equal(error.stderr.includes(f.wallet.privateKey), false);
            return true;
        });
        assert.equal(f.requests(), 1);
    });
}

test('sender preserves signed text and successful responses with the default deadline', async t => {
    let envelope;
    const result = { status: 'published', publication: { cid: 'test-cid' } };
    const f = await fixture(t, (response, body) => { envelope = body; response.end(JSON.stringify(result)); });
    const output = await f.send();
    assert.deepEqual(JSON.parse(output.stdout), result);
    assert.equal(output.stderr, '');
    assert.equal(envelope.text, 'exact message\n');
    assert.equal(verifyMessage(envelope.text, envelope.signature), f.wallet.address);
});

test('sender rejects invalid deadline settings before making requests', async t => {
    const f = await fixture(t, response => response.end('{}'));
    for (const timeout of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '2147483648']) {
        await assert.rejects(f.send(timeout), error => {
            assert.equal(error.code, 1);
            assert.equal(error.stdout, '');
            return true;
        });
    }
    assert.equal(f.requests(), 0);
});

test('sender retains non-200 response output and failure status', async t => {
    const f = await fixture(t, response => { response.writeHead(503); response.end('{"code":"node_busy"}'); });
    await assert.rejects(f.send(), error => {
        assert.equal(error.code, 1);
        assert.deepEqual(JSON.parse(error.stdout), { code: 'node_busy' });
        assert.equal(error.stderr, '');
        return true;
    });
});
