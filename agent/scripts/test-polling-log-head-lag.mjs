import assert from 'node:assert/strict';
import { pollCommitmentChanges, pollProposalChanges } from '../src/lib/polling.js';

const SAFE = '0x1234000000000000000000000000000000000000';
const ERC1155 = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const OG_MODULE = '0x9999999999999999999999999999999999999999';

function buildHeadLagError() {
    const error = new Error('block range extends beyond current head block');
    error.details = 'block range extends beyond current head block';
    error.shortMessage = 'Invalid parameters were provided to the RPC method.';
    return error;
}

async function testCommitmentPollingFallsBackToQueryableLogHead() {
    let readContractBlockNumbers = [];
    const publicClient = {
        async getBlockNumber() {
            return 105n;
        },
        async getLogs({ toBlock }) {
            if (BigInt(toBlock) > 104n) {
                throw buildHeadLagError();
            }
            return [];
        },
        async readContract({ blockNumber }) {
            readContractBlockNumbers.push(BigInt(blockNumber));
            return 0n;
        },
        async getBalance() {
            return 0n;
        },
    };

    const result = await pollCommitmentChanges({
        publicClient,
        trackedAssets: new Set(),
        trackedErc1155Assets: [{ token: ERC1155, tokenId: '42', symbol: 'TEST-42' }],
        commitmentSafe: SAFE,
        watchNativeBalance: false,
        lastCheckedBlock: 103n,
        lastNativeBalance: 0n,
        lastAssetBalances: new Map(),
    });

    assert.equal(result.lastCheckedBlock, 104n);
    assert.deepEqual(readContractBlockNumbers, [104n]);
}

async function testProposalPollingFallsBackToQueryableLogHead() {
    const proposalsByHash = new Map();
    const publicClient = {
        async getBlockNumber() {
            return 105n;
        },
        async getLogs({ toBlock }) {
            if (BigInt(toBlock) > 104n) {
                throw buildHeadLagError();
            }
            return [];
        },
    };

    const result = await pollProposalChanges({
        publicClient,
        ogModule: OG_MODULE,
        lastProposalCheckedBlock: 103n,
        proposalsByHash,
        startBlock: undefined,
        logChunkSize: 5_000n,
    });

    assert.equal(result.lastProposalCheckedBlock, 104n);
    assert.equal(result.newProposals.length, 0);
    assert.equal(result.executedProposals.length, 0);
    assert.equal(result.deletedProposals.length, 0);
}

async function run() {
    await testCommitmentPollingFallsBackToQueryableLogHead();
    await testProposalPollingFallsBackToQueryableLogHead();
    console.log('[test] polling log head lag handling OK');
}

run().catch((error) => {
    console.error('[test] polling log head lag handling failed:', error?.message ?? error);
    process.exit(1);
});
