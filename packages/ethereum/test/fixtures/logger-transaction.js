import { readFileSync } from 'node:fs';
import { createHttpConfig } from '@oyaprotocol/ethereum';

export const fixtures = JSON.parse(readFileSync(new URL('./logger-abi.json', import.meta.url), 'utf8'));
export const sample = fixtures.cases.find(({ name }) => name === 'message');
export const { loggerContract, node } = fixtures;
export const transactionHash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
// Opaque mock signer output; these tests exercise orchestration, not transaction signing.
export const rawTransaction = '0x02abcd';

export function createLog(overrides = {}) {
    return {
        address: loggerContract, topics: [...fixtures.topics, sample.cidKeccak256Hash], data: sample.data,
        transactionHash, blockHash, blockNumber: '0x10', transactionIndex: '0x0', logIndex: '0x0',
        removed: false, ...overrides,
    };
}

export function createReceipt(overrides = {}) {
    return {
        transactionHash, blockHash, blockNumber: '0x10', transactionIndex: '0x0',
        from: node, to: loggerContract, contractAddress: null,
        cumulativeGasUsed: '0x8000', gasUsed: '0x8000', logsBloom: `0x${'00'.repeat(256)}`,
        logs: [createLog()], status: '0x1', ...overrides,
    };
}

export function response(result) {
    return {
        ok: true, status: 200, statusText: 'OK',
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    };
}

export function createOptions(overrides = {}) {
    return {
        config: createHttpConfig({
            url: 'https://rpc.example', headers: {}, timeoutMs: 1_000, maxRetries: 0, retryDelayMs: 0,
        }),
        loggerContract, nodeAddress: node, timeoutMs: 1_000, pollIntervalMs: 1,
        transactionPreparer: () => ({ rawTransaction, transactionHash }),
        fetch: async (_url, request) => response(
            JSON.parse(request.body).method === 'eth_sendRawTransaction' ? transactionHash : createReceipt()
        ),
        ...overrides,
    };
}
