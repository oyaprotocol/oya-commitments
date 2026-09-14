import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Transaction, Wallet } from 'ethers';
import { hasBytecode } from '../src/bytecode.mjs';
import { parseConfig } from '../src/config.mjs';
import { createLocalSigner } from '../src/signer.mjs';
import { fixture, signedMessage } from './runtime-fixture.mjs';

const agent = Wallet.createRandom();
const configInput = {
    chainId: 31337, ledgerContract: '0x1111111111111111111111111111111111111111',
    allowedSigners: [agent.address], rpcUrl: 'http://127.0.0.1:8545', ipfsUrl: 'http://127.0.0.1:5001',
};

test('config fails closed on missing allowlist, chain, and invalid endpoints', () => {
    for (const change of [
        { allowedSigners: [] }, { allowedSigners: undefined }, { chainId: undefined }, { chainId: 1.5 },
        { ledgerContract: '0x' }, { rpcUrl: 'file:///tmp/rpc' }, { port: 65536 },
        { stateDir: './state' }, { operationTimeoutMs: 0 }, { operationTimeoutMs: 2_147_483_648 },
        { maxFeePerGasWei: '-1' }, { typo: true },
    ]) assert.throws(() => parseConfig({ ...configInput, ...change }));
    const config = parseConfig(configInput, { env: {} });
    assert.equal(Object.hasOwn(config, 'stateDir'), false);
    assert.equal(config.operationTimeoutMs, 180_000);
    assert.equal(config.host, '127.0.0.1');
});

test('signer preserves EIP-1559 fields and does not disclose invalid secret values', async () => {
    const wallet = Wallet.createRandom();
    const signer = createLocalSigner(wallet.privateKey);
    const input = {
        to: configInput.ledgerContract, data: '0x1234', value: 0n, type: 2, chainId: 31337,
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

test('bytecode distinguishes absence from valid bytes and rejects malformed RPC data', () => {
    assert.equal(hasBytecode('0x'), false);
    for (const code of ['0x00', '0x6000', '0xaAbB']) assert.equal(hasBytecode(code), true);
    for (const code of [null, undefined, 0, {}, '', '0x0', '0x600', '0xgg', '0x00\n', 'provider-secret-marker']) {
        assert.throws(() => hasBytecode(code), { message: 'Invalid bytecode.' });
    }
});

test('startup still rejects the wrong chain and absent or malformed Ledger bytecode', async (t) => {
    const setup = await fixture(t);
    setup.state.chainId = '0x1';
    await assert.rejects(setup.start(), /chain ID/);
    setup.state.chainId = '0x7a69';
    for (const code of ['0x', '0x600']) {
        setup.state.code = code;
        await assert.rejects(setup.start(), /bytecode/);
    }
    assert.equal(setup.state.uploads, 0);
    assert.equal(setup.state.signs, 0);
});

test('HTTP rejects unauthenticated and oversized requests before publication', async (t) => {
    const setup = await fixture(t, { maxBodyBytes: 1024, maxTextBytes: 100, bodyTimeoutMs: 100 });
    await setup.start();
    const { url, post, message } = setup;
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
    assert.equal(setup.state.uploads, 0);
    assert.equal(setup.state.signs, 0);
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
    assert.equal(setup.state.uploads, 0);
    assert.equal(setup.state.signs, 0);
    const response = await post(message);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).publication.status, 'logged');
    assert.equal(setup.state.uploads, 1);
    assert.equal(setup.state.signs, 1);
});
