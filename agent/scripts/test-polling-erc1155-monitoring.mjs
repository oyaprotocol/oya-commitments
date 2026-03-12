import assert from 'node:assert/strict';
import { pollCommitmentChanges } from '../src/lib/polling.js';

const ERC20 = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const ERC1155 = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const SAFE = '0x1234000000000000000000000000000000000000';
const OPERATOR = '0x1111111111111111111111111111111111111111';
const SENDER = '0x2222222222222222222222222222222222222222';

function createSnapshotClient() {
    let block = 200n;
    return {
        async getBlockNumber() {
            block += 1n;
            return block;
        },
        async readContract({ address, args }) {
            const normalizedAddress = String(address).toLowerCase();
            if (normalizedAddress === ERC20) {
                if (block === 201n || block === 202n) {
                    return 5n;
                }
                if (block === 203n) {
                    return 0n;
                }
                return 0n;
            }

            if (normalizedAddress === ERC1155) {
                const tokenId = BigInt(args?.[1] ?? 0).toString();
                if (tokenId === '42') {
                    if (block === 201n || block === 202n) {
                        return 3n;
                    }
                    if (block === 203n) {
                        return 7n;
                    }
                }
                return 0n;
            }

            return 0n;
        },
        async getLogs() {
            return [];
        },
        async getBalance() {
            return 0n;
        },
    };
}

async function testErc1155BalanceSnapshots() {
    const publicClient = createSnapshotClient();
    const trackedErc1155Assets = [{ token: ERC1155, tokenId: '42', symbol: 'TEST-42' }];

    const first = await pollCommitmentChanges({
        publicClient,
        trackedAssets: new Set([ERC20]),
        trackedErc1155Assets,
        commitmentSafe: SAFE,
        watchNativeBalance: false,
        lastCheckedBlock: undefined,
        lastNativeBalance: undefined,
        lastAssetBalances: undefined,
    });
    assert.equal(first.deposits.length, 0);
    assert.equal(first.balanceSnapshots.length, 2);

    const firstErc20Snapshot = first.balanceSnapshots.find(
        (signal) => signal.kind === 'erc20BalanceSnapshot'
    );
    assert.ok(firstErc20Snapshot);
    assert.equal(firstErc20Snapshot.asset.toLowerCase(), ERC20);
    assert.equal(BigInt(firstErc20Snapshot.amount), 5n);

    const firstErc1155Snapshot = first.balanceSnapshots.find(
        (signal) => signal.kind === 'erc1155BalanceSnapshot'
    );
    assert.ok(firstErc1155Snapshot);
    assert.equal(firstErc1155Snapshot.token.toLowerCase(), ERC1155);
    assert.equal(firstErc1155Snapshot.tokenId, '42');
    assert.equal(firstErc1155Snapshot.symbol, 'TEST-42');
    assert.equal(BigInt(firstErc1155Snapshot.amount), 3n);

    const second = await pollCommitmentChanges({
        publicClient,
        trackedAssets: new Set([ERC20]),
        trackedErc1155Assets,
        commitmentSafe: SAFE,
        watchNativeBalance: false,
        lastCheckedBlock: first.lastCheckedBlock,
        lastNativeBalance: first.lastNativeBalance,
        lastAssetBalances: first.lastAssetBalances,
    });
    assert.equal(second.deposits.length, 0);
    assert.equal(second.balanceSnapshots.length, 0);

    const third = await pollCommitmentChanges({
        publicClient,
        trackedAssets: new Set([ERC20]),
        trackedErc1155Assets,
        commitmentSafe: SAFE,
        watchNativeBalance: false,
        lastCheckedBlock: second.lastCheckedBlock,
        lastNativeBalance: second.lastNativeBalance,
        lastAssetBalances: second.lastAssetBalances,
    });
    assert.equal(third.deposits.length, 0);
    assert.equal(third.balanceSnapshots.length, 2);

    const zeroedErc20Snapshot = third.balanceSnapshots.find(
        (signal) => signal.kind === 'erc20BalanceSnapshot'
    );
    assert.ok(zeroedErc20Snapshot);
    assert.equal(BigInt(zeroedErc20Snapshot.amount), 0n);

    const changedErc1155Snapshot = third.balanceSnapshots.find(
        (signal) => signal.kind === 'erc1155BalanceSnapshot'
    );
    assert.ok(changedErc1155Snapshot);
    assert.equal(changedErc1155Snapshot.tokenId, '42');
    assert.equal(BigInt(changedErc1155Snapshot.amount), 7n);
}

async function testErc1155Deposits() {
    const singleTxHash = `0x${'a'.repeat(64)}`;
    const batchTxHash = `0x${'b'.repeat(64)}`;
    const publicClient = {
        async getBlockNumber() {
            return 105n;
        },
        async readContract() {
            return 0n;
        },
        async getLogs({ event }) {
            if (event.name === 'Transfer') {
                return [];
            }
            if (event.name === 'TransferSingle') {
                return [
                    {
                        args: {
                            operator: OPERATOR,
                            from: SENDER,
                            to: SAFE,
                            id: 42n,
                            value: 3n,
                        },
                        blockNumber: 103n,
                        transactionHash: singleTxHash,
                        logIndex: 1,
                    },
                ];
            }
            if (event.name === 'TransferBatch') {
                return [
                    {
                        args: {
                            operator: OPERATOR,
                            from: SENDER,
                            to: SAFE,
                            ids: [7n, 99n],
                            values: [2n, 1n],
                        },
                        blockNumber: 104n,
                        transactionHash: batchTxHash,
                        logIndex: 2,
                    },
                ];
            }
            return [];
        },
        async getBalance() {
            return 0n;
        },
    };

    const result = await pollCommitmentChanges({
        publicClient,
        trackedAssets: new Set(),
        trackedErc1155Assets: [
            { token: ERC1155, tokenId: '42', symbol: 'TEST-42' },
            { token: ERC1155, tokenId: '7', symbol: 'TEST-7' },
        ],
        commitmentSafe: SAFE,
        watchNativeBalance: false,
        lastCheckedBlock: 100n,
        lastNativeBalance: 0n,
        lastAssetBalances: new Map(),
    });

    assert.equal(result.balanceSnapshots.length, 0);
    assert.equal(result.deposits.length, 2);

    const singleDeposit = result.deposits.find((signal) => signal.tokenId === '42');
    assert.ok(singleDeposit);
    assert.equal(singleDeposit.kind, 'erc1155Deposit');
    assert.equal(singleDeposit.token.toLowerCase(), ERC1155);
    assert.equal(singleDeposit.symbol, 'TEST-42');
    assert.equal(BigInt(singleDeposit.amount), 3n);
    assert.equal(singleDeposit.transactionHash, singleTxHash);

    const batchDeposit = result.deposits.find((signal) => signal.tokenId === '7');
    assert.ok(batchDeposit);
    assert.equal(batchDeposit.kind, 'erc1155Deposit');
    assert.equal(batchDeposit.symbol, 'TEST-7');
    assert.equal(BigInt(batchDeposit.amount), 2n);
    assert.equal(batchDeposit.transactionHash, batchTxHash);

    assert.equal(result.deposits.some((signal) => signal.tokenId === '99'), false);
}

async function run() {
    await testErc1155BalanceSnapshots();
    await testErc1155Deposits();
    console.log('[test] polling ERC1155 monitoring OK');
}

run().catch((error) => {
    console.error('[test] polling ERC1155 monitoring failed:', error?.message ?? error);
    process.exit(1);
});
