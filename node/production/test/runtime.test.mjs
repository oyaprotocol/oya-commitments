import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Transaction, Wallet } from 'ethers';
import { parseConfig } from '../src/config.mjs';
import { createLocalSigner } from '../src/signer.mjs';
import { messageId, openStore } from '../src/store.mjs';
import { createNodeServer } from '../src/server.mjs';

const agent = Wallet.createRandom();
const configInput = {
    chainId: 31337, loggerContract: '0x1111111111111111111111111111111111111111',
    allowedSigners: [agent.address], rpcUrl: 'http://127.0.0.1:8545', ipfsUrl: 'http://127.0.0.1:5001', stateDir: './state',
};
const signedMessage = async (wallet, text = 'Oya kernel signed message') => ({
    text, signer: wallet.address, signature: await wallet.signMessage(text),
});

test('config fails closed on missing allowlist, chain, and invalid endpoints', () => {
    for (const change of [
        { allowedSigners: [] }, { allowedSigners: undefined }, { chainId: undefined }, { chainId: 1.5 },
        { loggerContract: '0x' }, { rpcUrl: 'file:///tmp/rpc' }, { stateDir: '' }, { port: 65536 },
        { maxFeePerGasWei: '-1' }, { typo: true },
    ]) assert.throws(() => parseConfig({ ...configInput, ...change }));
    const config = parseConfig(configInput, { baseDir: '/tmp/oya-test', env: {} });
    assert.equal(config.stateDir, '/tmp/oya-test/state');
    assert.equal(config.host, '127.0.0.1');
});

test('signer preserves EIP-1559 fields and does not disclose invalid secret values', async () => {
    const wallet = Wallet.createRandom();
    const signer = createLocalSigner(wallet.privateKey);
    const input = {
        to: configInput.loggerContract, data: '0x1234', value: 0n, type: 2, chainId: 31337,
        nonce: 4, gasLimit: 45_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    };
    const signed = await signer.signTransaction(input);
    const decoded = Transaction.from(signed.rawTransaction);
    assert.equal(decoded.hash, signed.transactionHash);
    assert.equal(decoded.from, wallet.address);
    for (const [key, value] of Object.entries(input)) assert.equal(decoded[key], key === 'chainId' ? BigInt(value) : value);
    assert.deepEqual(decoded.accessList, []);
    assert.throws(() => createLocalSigner('secret-marker'), (error) => !error.message.includes('secret-marker'));
    const aborted = AbortSignal.abort();
    await assert.rejects(signer.signTransaction(input, aborted));
});

test('journal persists records, rejects a second process and a different deployment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oya-store-test-'));
    const identity = { chainId: 31337, loggerContract: configInput.loggerContract, nodeAddress: agent.address };
    const store = await openStore(directory, identity);
    const message = await signedMessage(agent);
    const id = messageId(message);
    assert.equal(id, messageId({ ...message, signer: message.signer.toLowerCase(), signature: 'alternate' }));
    const record = { id, message };
    await store.save(record);
    assert.deepEqual(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')), record);
    await assert.rejects(openStore(directory, identity), /locked/);
    await store.close();
    await assert.rejects(openStore(directory, { ...identity, chainId: 1 }), /different/);
    const reopened = await openStore(directory, identity);
    assert.deepEqual(reopened.records.get(id), record);
    await reopened.close();
});

test('HTTP rejects unauthenticated and oversized requests before publication', async (t) => {
    let accepted = 0;
    const config = parseConfig({ ...configInput, maxBodyBytes: 1024, maxTextBytes: 100, bodyTimeoutMs: 100 });
    const server = createNodeServer({ config, nodeAddress: agent.address, publisher: {
        status: () => ({ busy: false, pendingMessageId: null }),
        publish: async () => { accepted++; return { status: 'logged', cid: 'example' }; },
    } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const post = (body, options = {}) => fetch(`${url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options,
    });
    const message = await signedMessage(agent);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/v1/messages`)).status, 405);
    assert.equal((await fetch(`${url}/unknown`)).status, 404);
    assert.equal((await post(message, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await post(null)).status, 400);
    assert.equal((await post(message, { body: '{bad json' })).status, 400);
    assert.equal((await post({ ...message, text: 'tampered' })).status, 401);
    assert.equal((await post(await signedMessage(Wallet.createRandom()))).status, 403);
    assert.equal((await post({ ...message, text: 'x'.repeat(101) })).status, 413);
    assert.equal((await post({ text: 'x'.repeat(2000) })).status, 413);
    assert.equal(accepted, 0);
    const chunkedStatus = await new Promise((resolve, reject) => {
        const request = httpRequest(`${url}/v1/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        }, (response) => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
        request.write('x'.repeat(600));
        request.end('x'.repeat(600));
    });
    assert.equal(chunkedStatus, 413);
    const timeoutStatus = await new Promise((resolve, reject) => {
        const request = httpRequest(`${url}/v1/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '20' },
        }, (response) => { response.resume(); resolve(response.statusCode); request.destroy(); });
        request.on('error', reject);
        request.write('{');
    });
    assert.equal(timeoutStatus, 408);
    const disconnected = httpRequest(`${url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '20' },
    });
    disconnected.on('error', () => {});
    disconnected.write('{');
    await delay(20);
    disconnected.destroy();
    await delay(20);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal(accepted, 0);
    const response = await post(message);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).publication.status, 'logged');
    assert.equal(accepted, 1);
});
