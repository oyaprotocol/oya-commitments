import assert from 'node:assert/strict';
import { executeReadyProposals } from '../src/lib/polling.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OG_MODULE = '0x2222222222222222222222222222222222222222';
const TARGET = '0x3333333333333333333333333333333333333333';
const PROPOSAL_HASH = `0x${'4'.repeat(64)}`;
const ASSERTION_ID = `0x${'5'.repeat(64)}`;
const TX_HASHES = [
    `0x${'a'.repeat(64)}`,
    `0x${'b'.repeat(64)}`,
];

function createPendingReceiptError() {
    const error = new Error('Transaction receipt not found.');
    error.name = 'TransactionReceiptNotFoundError';
    return error;
}

async function run() {
    const originalNow = Date.now;
    let nowMs = 1_000_000;
    let receiptMode = 'pending';
    const receiptChecks = [];
    const submittedTxHashes = [];

    const proposal = {
        proposalHash: PROPOSAL_HASH,
        assertionId: ASSERTION_ID,
        proposer: ACCOUNT,
        challengeWindowEnds: 1n,
        transactions: [
            {
                to: TARGET,
                operation: 0,
                value: 0n,
                data: '0x',
            },
        ],
        lastAttemptMs: 0,
        executionTxHash: null,
        executionSubmittedMs: null,
        disputeAttemptMs: 0,
        rules: '',
        explanation: '',
    };
    const proposalsByHash = new Map([[PROPOSAL_HASH, proposal]]);

    const publicClient = {
        async getBlockNumber() {
            return 100n;
        },
        async getBlock() {
            return { timestamp: BigInt(Math.floor(nowMs / 1000)) };
        },
        async readContract({ functionName }) {
            assert.equal(functionName, 'assertionIds');
            return ASSERTION_ID;
        },
        async simulateContract() {
            return {};
        },
        async getTransactionReceipt({ hash }) {
            receiptChecks.push(hash);
            if (receiptMode === 'pending') {
                throw createPendingReceiptError();
            }
            if (receiptMode === 'success') {
                return { status: 1n };
            }
            throw new Error(`Unsupported receipt mode: ${receiptMode}`);
        },
    };
    const walletClient = {
        async writeContract() {
            const hash = TX_HASHES[submittedTxHashes.length];
            submittedTxHashes.push(hash);
            return hash;
        },
    };

    Date.now = () => nowMs;
    try {
        await executeReadyProposals({
            publicClient,
            walletClient,
            account: { address: ACCOUNT },
            ogModule: OG_MODULE,
            proposalsByHash,
            executeRetryMs: 60_000,
            executePendingTxTimeoutMs: 300_000,
        });
        assert.deepEqual(submittedTxHashes, [TX_HASHES[0]]);
        assert.equal(proposal.executionTxHash, TX_HASHES[0]);
        assert.equal(proposal.executionSubmittedMs, nowMs);

        nowMs += 120_000;
        await executeReadyProposals({
            publicClient,
            walletClient,
            account: { address: ACCOUNT },
            ogModule: OG_MODULE,
            proposalsByHash,
            executeRetryMs: 60_000,
            executePendingTxTimeoutMs: 300_000,
        });
        assert.deepEqual(submittedTxHashes, [TX_HASHES[0]]);
        assert.equal(receiptChecks.at(-1), TX_HASHES[0]);
        assert.equal(proposal.executionTxHash, TX_HASHES[0]);

        nowMs += 200_001;
        await executeReadyProposals({
            publicClient,
            walletClient,
            account: { address: ACCOUNT },
            ogModule: OG_MODULE,
            proposalsByHash,
            executeRetryMs: 60_000,
            executePendingTxTimeoutMs: 300_000,
        });
        assert.deepEqual(submittedTxHashes, [TX_HASHES[0], TX_HASHES[1]]);
        assert.equal(proposal.executionTxHash, TX_HASHES[1]);
        assert.equal(proposal.executionSubmittedMs, nowMs);

        receiptMode = 'success';
        nowMs += 120_000;
        await executeReadyProposals({
            publicClient,
            walletClient,
            account: { address: ACCOUNT },
            ogModule: OG_MODULE,
            proposalsByHash,
            executeRetryMs: 60_000,
            executePendingTxTimeoutMs: 300_000,
        });
        assert.deepEqual(submittedTxHashes, [TX_HASHES[0], TX_HASHES[1]]);
        assert.equal(receiptChecks.at(-1), TX_HASHES[1]);

        console.log('[test] proposal execution deduping OK');
    } finally {
        Date.now = originalNow;
    }
}

run().catch((error) => {
    console.error('[test] proposal execution deduping failed:', error?.message ?? error);
    process.exit(1);
});
