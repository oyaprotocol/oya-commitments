import assert from 'node:assert/strict';
import { zeroAddress } from 'viem';
import { postBondAndDispute, postBondAndPropose } from '../src/lib/tx.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x5555555555555555555555555555555555555555';
const OG_MODULE = '0x3333333333333333333333333333333333333333';
const OPTIMISTIC_ORACLE = '0x6666666666666666666666666666666666666666';

function nextHash(prefix, index) {
    return `0x${prefix.repeat(63)}${index.toString(16)}`;
}

async function testProposalAllowanceReset() {
    const allowanceBySpender = new Map([[OG_MODULE, 5n]]);
    const approvalCalls = [];
    let proposalCalls = 0;
    let txIndex = 0;

    const publicClient = {
        async getBalance() {
            return 1n;
        },
        async readContract({ functionName, args }) {
            if (functionName === 'collateral') {
                return TOKEN;
            }
            if (functionName === 'bondAmount') {
                return 10n;
            }
            if (functionName === 'optimisticOracleV3') {
                return OPTIMISTIC_ORACLE;
            }
            if (functionName === 'getMinimumBond') {
                return 0n;
            }
            if (functionName === 'balanceOf') {
                return 100n;
            }
            if (functionName === 'allowance') {
                return allowanceBySpender.get(args[1]) ?? 0n;
            }
            throw new Error(`Unexpected readContract function: ${functionName}`);
        },
        async waitForTransactionReceipt() {
            return { status: 'success' };
        },
        async simulateContract() {
            return {};
        },
        async getTransactionReceipt() {
            return { logs: [] };
        },
    };

    const walletClient = {
        async writeContract({ functionName, args }) {
            txIndex += 1;
            if (functionName === 'approve') {
                approvalCalls.push([args[0], BigInt(args[1])]);
                allowanceBySpender.set(args[0], BigInt(args[1]));
                return nextHash('a', txIndex);
            }
            if (functionName === 'proposeTransactions') {
                proposalCalls += 1;
                return nextHash('b', txIndex);
            }
            throw new Error(`Unexpected writeContract function: ${functionName}`);
        },
        async sendTransaction() {
            throw new Error('sendTransaction should not be used in this test');
        },
    };

    await postBondAndPropose({
        publicClient,
        walletClient,
        account: { address: ACCOUNT },
        config: {
            proposeEnabled: true,
            allowProposeOnSimulationFail: false,
            bondSpender: 'og',
            proposeGasLimit: 2_000_000n,
            proposalHashResolveTimeoutMs: 0,
            proposalHashResolvePollIntervalMs: 1,
        },
        ogModule: OG_MODULE,
        transactions: [
            {
                to: ACCOUNT,
                value: 0n,
                data: '0x',
                operation: 0,
            },
        ],
    });

    assert.deepEqual(approvalCalls, [
        [OG_MODULE, 0n],
        [OG_MODULE, 10n],
    ]);
    assert.equal(proposalCalls, 1);
}

async function testDisputeAllowanceReset() {
    const allowanceBySpender = new Map([[OPTIMISTIC_ORACLE, 3n]]);
    const approvalCalls = [];
    let disputeCalls = 0;
    let txIndex = 0;

    const publicClient = {
        async getBalance() {
            return 1n;
        },
        async getBlock() {
            return { timestamp: 1_000n };
        },
        async readContract({ functionName, args }) {
            if (functionName === 'getAssertion') {
                return {
                    settled: false,
                    currency: TOKEN,
                    expirationTime: 10_000n,
                    bond: 7n,
                    disputer: zeroAddress,
                };
            }
            if (functionName === 'balanceOf') {
                return 100n;
            }
            if (functionName === 'allowance') {
                return allowanceBySpender.get(args[1]) ?? 0n;
            }
            throw new Error(`Unexpected readContract function: ${functionName}`);
        },
        async waitForTransactionReceipt() {
            return { status: 'success' };
        },
        async simulateContract() {
            return {};
        },
    };

    const walletClient = {
        async writeContract({ functionName, args }) {
            txIndex += 1;
            if (functionName === 'approve') {
                approvalCalls.push([args[0], BigInt(args[1])]);
                allowanceBySpender.set(args[0], BigInt(args[1]));
                return nextHash('c', txIndex);
            }
            if (functionName === 'disputeAssertion') {
                disputeCalls += 1;
                return nextHash('d', txIndex);
            }
            throw new Error(`Unexpected writeContract function: ${functionName}`);
        },
    };

    await postBondAndDispute({
        publicClient,
        walletClient,
        account: { address: ACCOUNT },
        config: {
            disputeEnabled: true,
        },
        ogContext: {
            optimisticOracle: OPTIMISTIC_ORACLE,
        },
        assertionId: `0x${'7'.repeat(64)}`,
        explanation: 'zero-first allowance regression',
    });

    assert.deepEqual(approvalCalls, [
        [OPTIMISTIC_ORACLE, 0n],
        [OPTIMISTIC_ORACLE, 7n],
    ]);
    assert.equal(disputeCalls, 1);
}

async function run() {
    await testProposalAllowanceReset();
    await testDisputeAllowanceReset();
    console.log('[test] zero-first ERC20 allowance handling OK');
}

run().catch((error) => {
    console.error('[test] zero-first ERC20 allowance handling failed:', error?.message ?? error);
    process.exit(1);
});
