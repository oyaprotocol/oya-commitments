import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Interface, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { parseConfig } from '../src/config.mjs';
import { createLocalSigner } from '../src/signer.mjs';
import { messageId, openStore } from '../src/store.mjs';
import { createPublisher } from '../src/publication.mjs';

const fixtures = JSON.parse(await readFile(new URL('../../../packages/ethereum/test/fixtures/logger-abi.json', import.meta.url), 'utf8'));
const cid = fixtures.cases.find((entry) => entry.name === 'message').cid;
const loggerContract = '0x1111111111111111111111111111111111111111';

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'oya-publisher-test-'));
    const wallet = Wallet.createRandom();
    const agent = Wallet.createRandom();
    const localSigner = createLocalSigner(wallet.privateKey);
    const config = parseConfig({
        chainId: 31337, loggerContract, allowedSigners: [agent.address],
        rpcUrl: 'http://rpc.example', ipfsUrl: 'http://ipfs.example', stateDir: directory,
        receiptTimeoutMs: 50, pollIntervalMs: 1,
    });
    const identity = { chainId: 31337, loggerContract, nodeAddress: wallet.address };
    let store = await openStore(directory, identity);
    t.after(async () => { await store?.close(); });
    const message = { text: 'publish test', signer: agent.address, signature: await agent.signMessage('publish test') };
    const state = { signs: 0, uploads: 0, sends: 0, submitted: null, failSend: false, failReceipt: false, missingEvent: false };
    let releaseUpload;
    let enteredUpload;
    let holdUpload = null;
    const signer = {
        address: wallet.address,
        async signTransaction(transaction, signal) {
            state.signs++;
            const durable = JSON.parse(await readFile(join(directory, `${messageId(message)}.json`), 'utf8'));
            assert.equal(durable.cid, cid, 'CID must be durable before signing');
            return localSigner.signTransaction(transaction, signal);
        },
    };
    const eventAbi = new Interface(['event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)']);
    const transport = async (url, request) => {
        if (url.startsWith(config.ipfs.url)) {
            state.uploads++;
            enteredUpload?.();
            if (holdUpload) await holdUpload;
            return new Response(JSON.stringify({ Hash: cid }));
        }
        const { id, method, params } = JSON.parse(request.body);
        let result;
        switch (method) {
            case 'eth_chainId': result = '0x7a69'; break;
            case 'eth_getTransactionCount': result = '0x0'; break;
            case 'eth_getBlockByNumber': result = { baseFeePerGas: '0x1', gasLimit: '0x1c9c380' }; break;
            case 'eth_maxPriorityFeePerGas': result = '0x1'; break;
            case 'eth_estimateGas': result = '0x8000'; break;
            case 'eth_sendRawTransaction': {
                state.sends++;
                const durable = JSON.parse(await readFile(join(directory, `${messageId(message)}.json`), 'utf8'));
                assert.equal(durable.signed.rawTransaction, params[0], 'signed bytes must be durable before broadcasting');
                assert.equal(durable.signed.transactionHash, keccak256(params[0]));
                if (state.failSend) throw new Error('provider-secret-marker');
                state.submitted = params[0];
                result = keccak256(params[0]);
                break;
            }
            case 'eth_getTransactionReceipt': {
                if (state.failReceipt) throw new Error('provider-secret-marker');
                if (!state.submitted) { result = null; break; }
                const transactionHash = keccak256(state.submitted);
                const blockHash = `0x${'ab'.repeat(32)}`;
                const event = eventAbi.encodeEventLog(eventAbi.getEvent('Log'), [wallet.address, keccak256(toUtf8Bytes(cid)), cid]);
                result = {
                    transactionHash, blockHash, blockNumber: '0x1', transactionIndex: '0x0',
                    from: wallet.address, to: loggerContract, contractAddress: null,
                    cumulativeGasUsed: '0x8000', gasUsed: '0x8000', logsBloom: `0x${'00'.repeat(256)}`, status: '0x1',
                    logs: state.missingEvent ? [] : [{
                        ...event, address: loggerContract, transactionHash, blockHash, blockNumber: '0x1',
                        transactionIndex: '0x0', logIndex: '0x0', removed: false,
                    }],
                };
                break;
            }
            default: throw new Error(`Unexpected RPC method ${method}`);
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    const publisher = () => createPublisher({ config, signer, store, fetch: transport });
    return {
        publisher, state, message, store: () => store,
        async reopen() { await store.close(); store = null; store = await openStore(directory, identity); },
        holdUpload() {
            holdUpload = new Promise((resolve) => { releaseUpload = resolve; });
            return new Promise((resolve) => { enteredUpload = resolve; });
        },
        releaseUpload() { releaseUpload(); },
        async anotherMessage() {
            const text = 'another signed message';
            return { text, signer: agent.address, signature: await agent.signMessage(text) };
        },
    };
}

test('persists before side effects, serializes work, and deduplicates completed messages', async (t) => {
    const setup = await fixture(t);
    const publisher = setup.publisher();
    const entered = setup.holdUpload();
    const pending = publisher.publish(setup.message);
    await entered;
    const idle = publisher.waitForIdle();
    let drained = false;
    idle.then(() => { drained = true; });
    await assert.rejects(publisher.publish(await setup.anotherMessage()), { code: 'node_busy' });
    assert.equal(drained, false);
    setup.releaseUpload();
    const result = await pending;
    await idle;
    assert.equal(drained, true);
    assert.equal(result.status, 'logged');
    assert.equal(result.cid, cid);
    assert.deepEqual(await publisher.publish(setup.message), result);
    assert.equal(setup.state.uploads, 1);
    assert.equal(setup.state.signs, 1);
    assert.equal(setup.state.sends, 1);
});

test('uncertain submission blocks new work and resumes the same signed transaction after restart', async (t) => {
    const setup = await fixture(t);
    setup.state.failSend = true;
    setup.state.failReceipt = true;
    let publisher = setup.publisher();
    await assert.rejects(publisher.publish(setup.message), (error) => {
        assert.equal(error.code, 'publication_incomplete');
        assert.ok(error.record.signed.transactionHash);
        assert.equal(error.message.includes('provider-secret-marker'), false);
        return true;
    });
    await assert.rejects(publisher.publish(await setup.anotherMessage()), { code: 'recovery_required' });
    const signed = setup.store().records.get(messageId(setup.message)).signed;
    await setup.reopen();
    setup.state.failSend = false;
    setup.state.failReceipt = false;
    publisher = setup.publisher();
    const recovered = await publisher.recover();
    assert.equal(recovered.transactionHash, signed.transactionHash);
    assert.equal(setup.state.submitted, signed.rawTransaction);
    assert.equal(setup.state.signs, 1);
    assert.equal(setup.state.uploads, 1);
    assert.equal(publisher.status().pendingMessageId, null);
});

test('rejects a receipt without the expected event and later reconciles it without another broadcast', async (t) => {
    const setup = await fixture(t);
    setup.state.missingEvent = true;
    const publisher = setup.publisher();
    await assert.rejects(publisher.publish(setup.message), { code: 'publication_incomplete' });
    assert.equal(setup.store().records.get(messageId(setup.message)).result, undefined);
    setup.state.missingEvent = false;
    assert.equal((await publisher.recover()).status, 'logged');
    assert.equal(setup.state.sends, 1);
    assert.equal(setup.state.signs, 1);
});
