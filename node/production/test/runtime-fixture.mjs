import { readFile } from 'node:fs/promises';
import { Interface, Transaction, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { parseConfig } from '../src/config.mjs';
import { createLocalSigner } from '../src/signer.mjs';
import { startNode } from '../src/main.mjs';

const fixtures = JSON.parse(await readFile(new URL('../../../packages/ethereum/test/fixtures/ledger-abi.json', import.meta.url), 'utf8'));
export const cid = fixtures.cases.find((entry) => entry.name === 'message').cid;
export const ledgerContract = '0x1111111111111111111111111111111111111111';
export const signedMessage = async (wallet, text = 'Oya kernel signed message') => ({
    text, signer: wallet.address, signature: await wallet.signMessage(text),
});

export function gate() {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    return { entered: entered.promise, release: released.resolve,
        async wait() { entered.resolve(); await released.promise; } };
}

// Use the real ingress, combined helper, preparer, signer, and receipt verifier.
// Only the IPFS and Ethereum transports are replaced.
export async function fixture(t, overrides = {}) {
    const wallet = Wallet.createRandom();
    const agent = Wallet.createRandom();
    const localSigner = createLocalSigner(wallet.privateKey);
    const parsed = parseConfig({
        chainId: 31337, ledgerContract, allowedSigners: [agent.address],
        rpcUrl: 'http://rpc.example', ipfsUrl: 'http://ipfs.example',
        receiptTimeoutMs: 1000, operationTimeoutMs: 3000, pollIntervalMs: 5, ...overrides,
    }, { env: {} });
    const config = { ...parsed, port: 0,
        rpc: { ...parsed.rpc, maxRetries: 0 }, ipfs: { ...parsed.ipfs, maxRetries: 0 } };
    const state = { signs: 0, uploads: 0, sends: 0, mined: 0, transactions: [], calls: [],
        ipfsFailure: false, preparationFailure: false, sendFailure: false, receiptMode: 'mined',
        code: '0x6000', chainId: '0x7a69' };
    const logs = [];
    const signer = { address: wallet.address, async signTransaction(transaction, signal) {
        state.signs++;
        return localSigner.signTransaction(transaction, signal);
    } };
    const eventAbi = new Interface(['event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)']);
    const transport = async (url, request) => {
        if (url.startsWith(config.ipfs.url)) {
            state.uploads++;
            await state.onUpload?.();
            if (state.ipfsFailure) return new Response('provider-secret-marker', { status: 503 });
            return new Response(JSON.stringify({ Hash: cid }));
        }
        const { id, method, params } = JSON.parse(request.body);
        state.calls.push(method);
        let result;
        switch (method) {
            case 'eth_chainId': result = state.chainId; break;
            case 'eth_getCode': result = state.code; break;
            case 'eth_getTransactionCount': result = `0x${state.mined.toString(16)}`; break;
            case 'eth_getBlockByNumber': result = { baseFeePerGas: '0x1', gasLimit: '0x1c9c380' }; break;
            case 'eth_maxPriorityFeePerGas': result = '0x1'; break;
            case 'eth_estimateGas':
                if (state.preparationFailure) return new Response(JSON.stringify({ jsonrpc: '2.0', id,
                    error: { code: -32000, message: 'provider-secret-marker' } }));
                result = '0x8000'; break;
            case 'eth_sendRawTransaction':
                state.sends++;
                state.transactions.push(Transaction.from(params[0]));
                if (state.sendFailure) throw new Error('provider-secret-marker');
                result = keccak256(params[0]); break;
            case 'eth_getTransactionReceipt': {
                await state.onReceipt?.();
                if (state.receiptMode === 'pending') { result = null; break; }
                if (state.receiptMode === 'malformed') { result = { transactionHash: params[0] }; break; }
                const transactionHash = params[0];
                const blockHash = `0x${'ab'.repeat(32)}`;
                const blockNumber = `0x${(++state.mined).toString(16)}`;
                const event = eventAbi.encodeEventLog(eventAbi.getEvent('Log'), [wallet.address, keccak256(toUtf8Bytes(cid)), cid]);
                result = {
                    transactionHash, blockHash, blockNumber, transactionIndex: '0x0',
                    from: wallet.address, to: ledgerContract, contractAddress: null,
                    cumulativeGasUsed: '0x8000', gasUsed: '0x8000', logsBloom: `0x${'00'.repeat(256)}`,
                    status: state.receiptMode === 'reverted' ? '0x0' : '0x1',
                    logs: state.receiptMode !== 'mined' ? [] : [{
                        ...event, address: ledgerContract, transactionHash, blockHash, blockNumber,
                        transactionIndex: '0x0', logIndex: '0x0', removed: false,
                    }],
                };
                break;
            }
            default: throw new Error(`Unexpected RPC method ${method}`);
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    const setup = { config, state, logs, wallet, agent, message: await signedMessage(agent),
        async start() {
            setup.runtime = await startNode(config, signer, { fetch: transport, log: (record) => logs.push(record) });
            t.after(() => setup.runtime.close());
            setup.url = `http://127.0.0.1:${setup.runtime.server.address().port}`;
        },
        post(body = setup.message, options = {}) {
            return fetch(`${setup.url}/v1/messages`, { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options });
        },
        health() { return fetch(`${setup.url}/healthz`); },
    };
    return setup;
}
