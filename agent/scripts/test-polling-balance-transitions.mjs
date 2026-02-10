import assert from 'node:assert/strict';
import { pollCommitmentChanges } from '../src/lib/polling.js';

const TOKEN = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const SAFE = '0x1234000000000000000000000000000000000000';

function createClient({ balances }) {
    let block = 100n;
    return {
        getBlockNumber: async () => {
            block += 1n;
            return block;
        },
        readContract: async () => balances.get(block) ?? 0n,
        getLogs: async () => [],
        getBalance: async () => 0n,
    };
}

async function run() {
    const balances = new Map([
        [101n, 30000n],
        [102n, 30000n],
        [103n, 25000n],
    ]);
    const publicClient = createClient({ balances });
    const trackedAssets = new Set([TOKEN]);

    const first = await pollCommitmentChanges({
        publicClient,
        trackedAssets,
        commitmentSafe: SAFE,
        watchNativeBalance: false,
        lastCheckedBlock: undefined,
        lastNativeBalance: undefined,
        lastAssetBalances: undefined,
    });
    const firstSnapshots = first.balanceSnapshots.filter((s) => s.kind === 'erc20BalanceSnapshot');
    assert.equal(first.deposits.length, 0);
    assert.equal(firstSnapshots.length, 1);
    assert.equal(BigInt(firstSnapshots[0].amount), 30000n);

    const second = await pollCommitmentChanges({
        publicClient,
        trackedAssets,
        commitmentSafe: SAFE,
        watchNativeBalance: false,
        lastCheckedBlock: first.lastCheckedBlock,
        lastNativeBalance: first.lastNativeBalance,
        lastAssetBalances: first.lastAssetBalances,
    });
    const secondSnapshots = second.balanceSnapshots.filter((s) => s.kind === 'erc20BalanceSnapshot');
    assert.equal(second.deposits.length, 0);
    assert.equal(secondSnapshots.length, 0);

    const third = await pollCommitmentChanges({
        publicClient,
        trackedAssets,
        commitmentSafe: SAFE,
        watchNativeBalance: false,
        lastCheckedBlock: second.lastCheckedBlock,
        lastNativeBalance: second.lastNativeBalance,
        lastAssetBalances: second.lastAssetBalances,
    });
    const thirdSnapshots = third.balanceSnapshots.filter((s) => s.kind === 'erc20BalanceSnapshot');
    assert.equal(third.deposits.length, 0);
    assert.equal(thirdSnapshots.length, 1);
    assert.equal(BigInt(thirdSnapshots[0].amount), 25000n);

    console.log('[test] polling balance transition gating OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
