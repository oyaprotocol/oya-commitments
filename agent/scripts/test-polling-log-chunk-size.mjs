import assert from 'node:assert/strict';
import { pollCommitmentChanges, pollProposalChanges } from '../src/lib/polling.js';

const SAFE = '0x1234000000000000000000000000000000000000';
const TOKEN = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const OG_MODULE = '0x2222222222222222222222222222222222222222';

async function testCommitmentPollingChunkSize() {
    const logCalls = [];
    const publicClient = {
        async getBlockNumber() {
            return 105n;
        },
        async getLogs({ address, event, fromBlock, toBlock }) {
            logCalls.push({
                address,
                eventName: event.name,
                fromBlock,
                toBlock,
            });
            return [];
        },
        async readContract() {
            return 0n;
        },
        async getBalance() {
            return 0n;
        },
    };

    await pollCommitmentChanges({
        publicClient,
        trackedAssets: new Set([TOKEN]),
        commitmentSafe: SAFE,
        watchNativeBalance: false,
        lastCheckedBlock: 100n,
        lastNativeBalance: 0n,
        lastAssetBalances: new Map(),
        logChunkSize: 2n,
    });

    assert.deepEqual(
        logCalls.map((call) => [call.eventName, call.fromBlock, call.toBlock]),
        [
            ['Transfer', 101n, 102n],
            ['Transfer', 103n, 104n],
            ['Transfer', 105n, 105n],
        ]
    );
}

async function testProposalPollingChunkSize() {
    const logCalls = [];
    const publicClient = {
        async getBlockNumber() {
            return 105n;
        },
        async getLogs({ address, event, fromBlock, toBlock }) {
            logCalls.push({
                address,
                eventName: event.name,
                fromBlock,
                toBlock,
            });
            return [];
        },
    };

    const result = await pollProposalChanges({
        publicClient,
        ogModule: OG_MODULE,
        lastProposalCheckedBlock: 100n,
        proposalsByHash: new Map(),
        startBlock: undefined,
        logChunkSize: 2n,
    });

    assert.equal(result.lastProposalCheckedBlock, 105n);
    assert.deepEqual(
        logCalls.map((call) => [call.eventName, call.fromBlock, call.toBlock]),
        [
            ['TransactionsProposed', 101n, 102n],
            ['ProposalExecuted', 101n, 102n],
            ['ProposalDeleted', 101n, 102n],
            ['TransactionsProposed', 103n, 104n],
            ['ProposalExecuted', 103n, 104n],
            ['ProposalDeleted', 103n, 104n],
            ['TransactionsProposed', 105n, 105n],
            ['ProposalExecuted', 105n, 105n],
            ['ProposalDeleted', 105n, 105n],
        ]
    );
}

async function run() {
    await testCommitmentPollingChunkSize();
    await testProposalPollingChunkSize();
    console.log('[test] polling log chunk size OK');
}

run().catch((error) => {
    console.error('[test] polling log chunk size failed:', error?.message ?? error);
    process.exit(1);
});
