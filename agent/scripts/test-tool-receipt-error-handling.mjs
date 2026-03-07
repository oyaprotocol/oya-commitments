import assert from 'node:assert/strict';
import { executeToolCalls } from '../src/lib/tools.js';

function parseOutput(result) {
    return JSON.parse(result.output);
}

async function run() {
    const account = { address: '0x1111111111111111111111111111111111111111' };
    const config = {
        proposeEnabled: true,
        disputeEnabled: false,
        polymarketClobEnabled: false,
        commitmentSafe: '0x2222222222222222222222222222222222222222',
        ogModule: '0x3333333333333333333333333333333333333333',
    };

    const receiptCheckError = new Error('transaction receipt RPC unavailable');
    const publicClient = {
        async waitForTransactionReceipt() {
            throw receiptCheckError;
        },
    };

    const walletClient = {
        async writeContract(args) {
            if (args.functionName === 'transfer') {
                return `0x${'a'.repeat(64)}`;
            }
            if (args.functionName === 'safeTransferFrom') {
                return `0x${'b'.repeat(64)}`;
            }
            throw new Error(`Unexpected functionName: ${args.functionName}`);
        },
        async sendTransaction() {
            return `0x${'c'.repeat(64)}`;
        },
    };

    // Regression: post-broadcast receipt-check failures must not throw/requeue.
    const results = await executeToolCalls({
        toolCalls: [
            {
                callId: 'deposit',
                name: 'make_deposit',
                arguments: {
                    asset: '0x4444444444444444444444444444444444444444',
                    amountWei: '1',
                },
            },
            {
                callId: 'erc1155',
                name: 'make_erc1155_deposit',
                arguments: {
                    token: '0x5555555555555555555555555555555555555555',
                    tokenId: '7',
                    amount: '3',
                },
            },
        ],
        publicClient,
        walletClient,
        account,
        config,
        ogContext: null,
    });

    assert.equal(results.length, 2);

    const depositOut = parseOutput(results[0]);
    assert.equal(depositOut.status, 'submitted');
    assert.equal(depositOut.pendingConfirmation, true);
    assert.match(depositOut.receiptCheckError, /receipt RPC unavailable/i);
    assert.ok(depositOut.transactionHash);

    const erc1155Out = parseOutput(results[1]);
    assert.equal(erc1155Out.status, 'submitted');
    assert.equal(erc1155Out.pendingConfirmation, true);
    assert.match(erc1155Out.receiptCheckError, /receipt RPC unavailable/i);
    assert.ok(erc1155Out.transactionHash);

    console.log('[test] tool receipt-error handling OK');
}

run().catch((error) => {
    console.error('[test] tool receipt-error handling failed:', error?.message ?? error);
    process.exit(1);
});
