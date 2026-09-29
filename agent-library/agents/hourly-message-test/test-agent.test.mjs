import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Wallet, verifyMessage } from 'ethers';
import { initialize, intervalMs, runAgent } from './agent.mjs';

const publication = { status: 'logged', cid: 'bafkfixture', transactionHash: `0x${'ab'.repeat(32)}` };
const success = () => Response.json({ status: 'logged', publication });

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'oya-hourly-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const keyPath = join(directory, 'key');
    const configPath = join(directory, 'node.json');
    const existing = Wallet.createRandom().address;
    const config = { chainId: 11155111, allowedSigners: [existing], rpcUrl: 'https://rpc.invalid/private-fixture' };
    await writeFile(configPath, JSON.stringify(config));
    return { keyPath, configPath, config, existing };
}

test('initialization persists a private key and enrolls it once without replacing existing settings', async (t) => {
    const f = await fixture(t);
    const before = await stat(f.configPath);
    const address = await initialize(f.keyPath, f.configPath);
    const key = await readFile(f.keyPath, 'utf8');
    assert.equal(new Wallet(key.trim()).address, address);
    assert.equal((await stat(f.keyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(f.configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(f.configPath)).ino, before.ino);
    assert.equal(await initialize(f.keyPath, f.configPath), address);
    assert.equal(await readFile(f.keyPath, 'utf8'), key);
    assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), {
        ...f.config, allowedSigners: [f.existing, address],
    });
    await chmod(f.keyPath, 0o644);
    await initialize(f.keyPath, f.configPath);
    assert.equal((await stat(f.keyPath)).mode & 0o777, 0o600);
});

test('unsupported chains and invalid saved keys fail without replacing secrets or settings', async (t) => {
    const f = await fixture(t);
    const original = JSON.stringify({ ...f.config, chainId: 1 });
    await writeFile(f.configPath, original);
    await assert.rejects(initialize(f.keyPath, f.configPath));
    await assert.rejects(readFile(f.keyPath), { code: 'ENOENT' });
    assert.equal(await readFile(f.configPath, 'utf8'), original);
    await writeFile(f.configPath, JSON.stringify(f.config));
    await writeFile(f.keyPath, 'invalid-fixture-key');
    await assert.rejects(initialize(f.keyPath, f.configPath));
    assert.equal(await readFile(f.keyPath, 'utf8'), 'invalid-fixture-key');
    assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), f.config);
});

test('sends immediately, signs each message, and spaces starts one hour apart without overlapping', async () => {
    const wallet = Wallet.createRandom();
    const stopped = new AbortController();
    const starts = [], waits = [], texts = [], logs = [];
    let time = 0;
    const code = await runAgent(wallet, { signal: stopped.signal, now: () => time,
        log: line => logs.push(line), fetch: async (url, options) => {
            starts.push(time);
            assert.equal(url, 'http://node:8787/v1/messages');
            const body = JSON.parse(options.body);
            assert.equal(verifyMessage(body.text, body.signature), wallet.address);
            assert.equal(body.signer, wallet.address);
            texts.push(body.text);
            time += 500;
            return success();
        }, wait: async ms => {
            waits.push(ms);
            time += ms;
            if (starts.length === 2) stopped.abort();
        },
    });
    assert.equal(code, 0);
    assert.deepEqual(starts, [0, 3_600_000]);
    assert.equal(intervalMs, 3_600_000);
    assert.deepEqual(waits, [3_599_500, 3_599_500]);
    assert.notEqual(texts[0], texts[1]);
    assert.equal(logs.length, 2);
    assert.ok(logs.every(line => JSON.parse(line).event === 'test_message_logged'));
    assert.equal(logs.join('').includes(wallet.privateKey), false);
});

test('unconfirmed and malformed responses stop without retries or raw error output', async (t) => {
    for (const reason of ['network', 'rejected', 'invalid-json', 'missing-publication', 'missing-cid', 'invalid-hash']) {
        await t.test(reason, async () => {
            let requests = 0;
            const logs = [];
            const code = await runAgent(Wallet.createRandom(), { signal: new AbortController().signal,
                log: line => logs.push(line), wait: () => assert.fail('must not schedule another request'),
                fetch: async () => {
                    requests++;
                    if (reason === 'network') throw new Error('private-fixture');
                    if (reason === 'rejected') return Response.json({ error: 'private-fixture' }, { status: 503 });
                    if (reason === 'invalid-json') return new Response('private-fixture');
                    if (reason === 'missing-publication') return Response.json({ status: 'logged' });
                    if (reason === 'missing-cid') return Response.json({ status: 'logged', publication: { ...publication, cid: undefined } });
                    return Response.json({ status: 'logged', publication: { ...publication, transactionHash: 'private-fixture' } });
                },
            });
            assert.equal(code, 1);
            assert.equal(requests, 1);
            assert.equal(JSON.parse(logs[0]).event, 'test_agent_stopped');
            assert.equal(logs.join('').includes('private-fixture'), false);
        });
    }
});

test('request timeout stops a stalled HTTP response', async (t) => {
    const server = createServer((_req, res) => res.writeHead(200).flushHeaders());
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const code = await runAgent(Wallet.createRandom(), { signal: new AbortController().signal,
        timeoutMs: 50, log: () => {}, wait: () => assert.fail('must stop on timeout'),
        fetch: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}`, options),
    });
    assert.equal(code, 1);
});

test('shutdown drains an active request and interrupts the hourly wait', async () => {
    const stopped = new AbortController();
    let finish, markStarted, requestSignal;
    const started = new Promise(resolve => { markStarted = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    const result = runAgent(Wallet.createRandom(), { signal: stopped.signal, log: () => {},
        fetch: (_url, options) => { requestSignal = options.signal; markStarted(); return pending; },
    });
    await started;
    stopped.abort();
    assert.equal(requestSignal.aborted, false);
    finish(success());
    assert.equal(await result, 0);

    const idle = new AbortController();
    assert.equal(await runAgent(Wallet.createRandom(), { signal: idle.signal,
        fetch: async () => success(), log: () => setTimeout(() => idle.abort(), 5),
    }), 0);
});
