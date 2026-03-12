import assert from 'node:assert/strict';
import { executeToolCalls } from '../src/lib/tools.js';

function parseOutput(result) {
    return JSON.parse(result.output);
}

function buildConfig() {
    return {
        proposeEnabled: true,
        disputeEnabled: true,
        polymarketClobEnabled: false,
        allowProposeOnSimulationFail: false,
        proposeGasLimit: 2_000_000n,
        bondSpender: 'og',
        commitmentSafe: '0x2222222222222222222222222222222222222222',
        ogModule: '0x3333333333333333333333333333333333333333',
        proposalHashResolveTimeoutMs: 100,
        proposalHashResolvePollIntervalMs: 10,
    };
}

async function run() {
    const account = { address: '0x1111111111111111111111111111111111111111' };

    // Pre-submit transient failure should be classified as retryable.
    const transientOutputs = await executeToolCalls({
        toolCalls: [
            {
                callId: 'propose-transient',
                name: 'post_bond_and_propose',
                arguments: {
                    transactions: [
                        {
                            to: '0x4444444444444444444444444444444444444444',
                            value: '0',
                            data: '0x',
                            operation: 0,
                        },
                    ],
                },
            },
        ],
        publicClient: {
            async getBalance() {
                throw new Error('network error while querying balance');
            },
        },
        walletClient: {},
        account,
        config: buildConfig(),
        ogContext: null,
    });
    assert.equal(transientOutputs.length, 1);
    const transientOut = parseOutput(transientOutputs[0]);
    assert.equal(transientOut.status, 'error');
    assert.equal(transientOut.retryable, true);
    assert.equal(transientOut.sideEffectsLikelyCommitted, false);

    const transientDisputeOutputs = await executeToolCalls({
        toolCalls: [
            {
                callId: 'dispute-transient',
                name: 'dispute_assertion',
                arguments: {
                    assertionId: `0x${'7'.repeat(64)}`,
                    explanation: 'transient test',
                },
            },
        ],
        publicClient: {
            async getBalance() {
                throw new Error('network error while querying balance');
            },
        },
        walletClient: {},
        account,
        config: buildConfig(),
        ogContext: {
            optimisticOracle: '0x6666666666666666666666666666666666666666',
        },
    });
    assert.equal(transientDisputeOutputs.length, 1);
    const transientDisputeOut = parseOutput(transientDisputeOutputs[0]);
    assert.equal(transientDisputeOut.status, 'error');
    assert.equal(transientDisputeOut.retryable, true);
    assert.equal(transientDisputeOut.sideEffectsLikelyCommitted, false);

    // Errors after a tx hash should be marked non-retryable for message replay safety.
    const timeoutError = new Error('timed out while waiting for transaction');
    timeoutError.name = 'WaitForTransactionReceiptTimeoutError';
    const sideEffectOutputs = await executeToolCalls({
        toolCalls: [
            {
                callId: 'propose-post-side-effect',
                name: 'post_bond_and_propose',
                arguments: {
                    transactions: [
                        {
                            to: '0x4444444444444444444444444444444444444444',
                            value: '0',
                            data: '0x',
                            operation: 0,
                        },
                    ],
                },
            },
        ],
        publicClient: {
            async getBalance() {
                return 1n;
            },
            async readContract({ functionName }) {
                if (functionName === 'collateral') {
                    return '0x5555555555555555555555555555555555555555';
                }
                if (functionName === 'bondAmount') {
                    return 1n;
                }
                if (functionName === 'optimisticOracleV3') {
                    return '0x6666666666666666666666666666666666666666';
                }
                if (functionName === 'getMinimumBond') {
                    return 0n;
                }
                if (functionName === 'balanceOf') {
                    return 1n;
                }
                if (functionName === 'allowance') {
                    return 0n;
                }
                throw new Error(`unexpected readContract function: ${functionName}`);
            },
            async waitForTransactionReceipt() {
                throw timeoutError;
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
        config: buildConfig(),
        ogContext: null,
    });
    assert.equal(sideEffectOutputs.length, 1);
    const sideEffectOut = parseOutput(sideEffectOutputs[0]);
    assert.equal(sideEffectOut.status, 'pending');
    assert.equal(sideEffectOut.retryable, false);
    assert.equal(sideEffectOut.sideEffectsLikelyCommitted, true);

    console.log('[test] tool output retryability classification OK');
}

run().catch((error) => {
    console.error('[test] tool output retryability classification failed:', error?.message ?? error);
    process.exit(1);
});
