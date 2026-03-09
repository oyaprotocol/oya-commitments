import assert from 'node:assert/strict';
import { executeToolCalls, hasCommittedToolSideEffects } from '../src/lib/tools.js';

function buildBaseConfig() {
    return {
        proposeEnabled: true,
        disputeEnabled: false,
        polymarketClobEnabled: false,
        commitmentSafe: '0x2222222222222222222222222222222222222222',
        ogModule: '0x3333333333333333333333333333333333333333',
    };
}

function buildToolCall() {
    return {
        callId: 'deposit',
        name: 'make_deposit',
        arguments: {
            asset: '0x4444444444444444444444444444444444444444',
            amountWei: '1',
        },
    };
}

async function expectFailure(promise) {
    try {
        await promise;
        throw new Error('Expected tool execution to fail.');
    } catch (error) {
        return error;
    }
}

async function run() {
    const account = { address: '0x1111111111111111111111111111111111111111' };

    // Pre-submit failure: wallet submit throws before tx hash is returned.
    const preSubmitError = await expectFailure(
        executeToolCalls({
            toolCalls: [buildToolCall()],
            publicClient: {
                async waitForTransactionReceipt() {},
            },
            walletClient: {
                async writeContract() {
                    throw new Error('wallet RPC unavailable');
                },
                async sendTransaction() {
                    throw new Error('wallet RPC unavailable');
                },
            },
            account,
            config: buildBaseConfig(),
            ogContext: null,
        })
    );
    assert.equal(hasCommittedToolSideEffects(preSubmitError), false);

    // Post-submit failure path: tx hash exists, then receipt-error normalization throws.
    // This synthetic shape forces an exception after side effects are likely committed.
    const toxicReceiptError = {};
    Object.defineProperty(toxicReceiptError, 'shortMessage', {
        get() {
            throw new Error('shortMessage getter exploded');
        },
    });
    Object.defineProperty(toxicReceiptError, 'message', {
        get() {
            throw new Error('message getter exploded');
        },
    });

    const postSubmitError = await expectFailure(
        executeToolCalls({
            toolCalls: [buildToolCall()],
            publicClient: {
                async waitForTransactionReceipt() {
                    throw toxicReceiptError;
                },
            },
            walletClient: {
                async writeContract() {
                    return `0x${'a'.repeat(64)}`;
                },
                async sendTransaction() {
                    return `0x${'b'.repeat(64)}`;
                },
            },
            account,
            config: buildBaseConfig(),
            ogContext: null,
        })
    );
    assert.equal(hasCommittedToolSideEffects(postSubmitError), true);

    console.log('[test] tool execution error retryability OK');
}

run().catch((error) => {
    console.error('[test] tool execution error retryability failed:', error?.message ?? error);
    process.exit(1);
});
