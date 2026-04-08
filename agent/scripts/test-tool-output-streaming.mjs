import assert from 'node:assert/strict';
import { executeToolCalls } from '../src/lib/tools.js';

function parseOutput(result) {
    return JSON.parse(result.output);
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function buildConfig() {
    return {
        proposeEnabled: true,
        disputeEnabled: false,
        polymarketClobEnabled: false,
        allowProposeOnSimulationFail: false,
        bondSpender: 'og',
        commitmentSafe: '0x2222222222222222222222222222222222222222',
        ogModule: '0x3333333333333333333333333333333333333333',
        proposalHashResolveTimeoutMs: 1_000,
        proposalHashResolvePollIntervalMs: 10,
    };
}

async function testDepositCallbackFiresBeforeReceiptWaitCompletes() {
    const account = { address: '0x1111111111111111111111111111111111111111' };
    const receiptGate = createDeferred();
    const callbackSeen = createDeferred();
    const txHash = `0x${'a'.repeat(64)}`;
    let callbackPayload = null;

    const execution = executeToolCalls({
        toolCalls: [
            {
                callId: 'deposit',
                name: 'make_deposit',
                arguments: {
                    asset: '0x4444444444444444444444444444444444444444',
                    amountWei: '1',
                },
            },
        ],
        publicClient: {
            async waitForTransactionReceipt() {
                await receiptGate.promise;
                return { status: 'success' };
            },
        },
        walletClient: {
            async writeContract() {
                return txHash;
            },
        },
        account,
        config: buildConfig(),
        ogContext: null,
        onToolOutput: async (output) => {
            callbackPayload = parseOutput(output);
            callbackSeen.resolve();
        },
    });

    await callbackSeen.promise;
    assert.equal(callbackPayload.status, 'submitted');
    assert.equal(callbackPayload.transactionHash, txHash);
    assert.equal(callbackPayload.pendingConfirmation, true);

    receiptGate.resolve();
    const results = await execution;
    assert.equal(results.length, 1);
    const finalPayload = parseOutput(results[0]);
    assert.equal(finalPayload.status, 'confirmed');
    assert.equal(finalPayload.transactionHash, txHash);
}

async function testProposalCallbackFiresBeforeProposalHashResolutionCompletes() {
    const account = { address: '0x1111111111111111111111111111111111111111' };
    const receiptGate = createDeferred();
    const callbackSeen = createDeferred();
    const proposalTxHash = `0x${'b'.repeat(64)}`;
    let callbackPayload = null;

    const execution = executeToolCalls({
        toolCalls: [
            {
                callId: 'propose',
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
                    explanation: 'streaming test',
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
                    return 0n;
                }
                if (functionName === 'optimisticOracleV3') {
                    return '0x6666666666666666666666666666666666666666';
                }
                if (functionName === 'getMinimumBond') {
                    return 0n;
                }
                throw new Error(`unexpected readContract function: ${functionName}`);
            },
            async simulateContract() {
                return {};
            },
            async getTransactionReceipt() {
                await receiptGate.promise;
                return { logs: [] };
            },
        },
        walletClient: {
            async writeContract() {
                return proposalTxHash;
            },
        },
        account,
        config: buildConfig(),
        ogContext: null,
        onToolOutput: async (output) => {
            callbackPayload = parseOutput(output);
            callbackSeen.resolve();
        },
    });

    await callbackSeen.promise;
    assert.equal(callbackPayload.status, 'submitted');
    assert.equal(callbackPayload.transactionHash, proposalTxHash);
    assert.equal(callbackPayload.pendingProposalHashResolution, true);

    receiptGate.resolve();
    const results = await execution;
    assert.equal(results.length, 1);
    const finalPayload = parseOutput(results[0]);
    assert.equal(finalPayload.status, 'submitted');
    assert.equal(finalPayload.transactionHash, proposalTxHash);
}

async function run() {
    await testDepositCallbackFiresBeforeReceiptWaitCompletes();
    await testProposalCallbackFiresBeforeProposalHashResolutionCompletes();
    console.log('[test] tool output streaming OK');
}

run().catch((error) => {
    console.error('[test] tool output streaming failed:', error?.message ?? error);
    process.exit(1);
});
