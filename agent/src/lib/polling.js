import { erc20Abi, getAddress, hexToString, isAddressEqual, zeroAddress } from 'viem';
import {
    optimisticGovernorAbi,
    proposalDeletedEvent,
    proposalExecutedEvent,
    transactionsProposedEvent,
    transferEvent,
} from './og.js';

async function primeBalances({ publicClient, commitmentSafe, watchNativeBalance, blockNumber }) {
    if (!watchNativeBalance) return undefined;

    return publicClient.getBalance({
        address: commitmentSafe,
        blockNumber,
    });
}

async function primeAssetBalanceSignals({ publicClient, trackedAssets, commitmentSafe, blockNumber }) {
    const balances = await Promise.all(
        Array.from(trackedAssets).map(async (asset) => {
            if (isAddressEqual(asset, zeroAddress)) {
                return { asset, balance: 0n };
            }
            const balance = await publicClient.readContract({
                address: asset,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [commitmentSafe],
                blockNumber,
            });
            return { asset, balance };
        })
    );

    const signals = balances
        .filter((item) => item.balance > 0n)
        .map((item) => ({
            kind: 'erc20BalanceSnapshot',
            asset: item.asset,
            from: 'snapshot',
            amount: item.balance,
            blockNumber,
            transactionHash: undefined,
            logIndex: undefined,
            id: `snapshot:${item.asset}:${blockNumber.toString()}`,
        }));

    const balanceMap = new Map(balances.map((item) => [item.asset, item.balance]));
    return { signals, balanceMap };
}

async function collectAssetBalanceChangeSignals({
    publicClient,
    trackedAssets,
    commitmentSafe,
    blockNumber,
    lastAssetBalances,
    emitBalanceSnapshotsEveryPoll = false,
}) {
    const nextAssetBalances = new Map(lastAssetBalances ?? []);
    const signals = [];

    for (const asset of trackedAssets) {
        if (isAddressEqual(asset, zeroAddress)) {
            continue;
        }
        const current = await publicClient.readContract({
            address: asset,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [commitmentSafe],
            blockNumber,
        });
        const previous = nextAssetBalances.get(asset);
        nextAssetBalances.set(asset, current);

        const hasChanged = previous !== undefined && current !== previous;
        const isFirstObservationNonZero = previous === undefined && current > 0n;
        const shouldEmit = emitBalanceSnapshotsEveryPoll
            ? current > 0n
            : hasChanged || isFirstObservationNonZero;
        if (shouldEmit) {
            signals.push({
                kind: 'erc20BalanceSnapshot',
                asset,
                from: 'snapshot',
                amount: current,
                blockNumber,
                transactionHash: undefined,
                logIndex: undefined,
                id: `snapshot:${asset}:${blockNumber.toString()}`,
            });
        }
    }

    return { signals, nextAssetBalances };
}

async function pollCommitmentChanges({
    publicClient,
    trackedAssets,
    commitmentSafe,
    watchNativeBalance,
    lastCheckedBlock,
    lastNativeBalance,
    lastAssetBalances,
    emitBalanceSnapshotsEveryPoll = false,
}) {
    const latestBlock = await publicClient.getBlockNumber();
    if (lastCheckedBlock === undefined) {
        const nextNativeBalance = await primeBalances({
            publicClient,
            commitmentSafe,
            watchNativeBalance,
            blockNumber: latestBlock,
        });
        const { signals: initialAssetSignals, balanceMap: initialAssetBalanceMap } =
            await primeAssetBalanceSignals({
            publicClient,
            trackedAssets,
            commitmentSafe,
            blockNumber: latestBlock,
            });
        if (initialAssetSignals.length > 0) {
            console.log(
                `[agent] Startup balance snapshot signals: ${initialAssetSignals
                    .map((s) => `${s.asset}:${s.amount.toString()}`)
                    .join(', ')}`
            );
        }
        return {
            deposits: [],
            balanceSnapshots: initialAssetSignals,
            lastCheckedBlock: latestBlock,
            lastNativeBalance: nextNativeBalance,
            lastAssetBalances:
                lastAssetBalances ?? initialAssetBalanceMap,
        };
    }

    if (latestBlock <= lastCheckedBlock) {
        return {
            deposits: [],
            balanceSnapshots: [],
            lastCheckedBlock,
            lastNativeBalance,
            lastAssetBalances,
        };
    }

    const fromBlock = lastCheckedBlock + 1n;
    const toBlock = latestBlock;
    const deposits = [];

    const maxRange = 10n;
    let currentFrom = fromBlock;
    while (currentFrom <= toBlock) {
        const currentTo =
            currentFrom + maxRange - 1n > toBlock ? toBlock : currentFrom + maxRange - 1n;

    for (const asset of trackedAssets) {
        if (isAddressEqual(asset, zeroAddress)) {
            continue;
        }
        const logs = await publicClient.getLogs({
            address: asset,
            event: transferEvent,
                args: { to: commitmentSafe },
                fromBlock: currentFrom,
                toBlock: currentTo,
            });

            for (const log of logs) {
                deposits.push({
                    kind: 'erc20Deposit',
                    asset,
                    from: log.args.from,
                    amount: log.args.value,
                    blockNumber: log.blockNumber,
                    transactionHash: log.transactionHash,
                    logIndex: log.logIndex,
                    id: log.transactionHash
                        ? `${log.transactionHash}:${log.logIndex ?? '0'}`
                        : `${log.blockNumber.toString()}:${log.logIndex ?? '0'}`,
                });
            }
        }

        currentFrom = currentTo + 1n;
    }

    let nextNativeBalance = lastNativeBalance;
    if (watchNativeBalance) {
        const nativeBalance = await publicClient.getBalance({
            address: commitmentSafe,
            blockNumber: toBlock,
        });

        if (lastNativeBalance !== undefined && nativeBalance > lastNativeBalance) {
            deposits.push({
                kind: 'nativeDeposit',
                asset: zeroAddress,
                from: 'unknown',
                amount: nativeBalance - lastNativeBalance,
                blockNumber: toBlock,
                transactionHash: undefined,
                logIndex: undefined,
                id: `native:${toBlock.toString()}:${(nativeBalance - lastNativeBalance).toString()}`,
            });
        }

        nextNativeBalance = nativeBalance;
    }

    const { signals: balanceSnapshots, nextAssetBalances } = await collectAssetBalanceChangeSignals({
        publicClient,
        trackedAssets,
        commitmentSafe,
        blockNumber: toBlock,
        lastAssetBalances,
        emitBalanceSnapshotsEveryPoll,
    });

    return {
        deposits,
        balanceSnapshots,
        lastCheckedBlock: toBlock,
        lastNativeBalance: nextNativeBalance,
        lastAssetBalances: nextAssetBalances,
    };
}

async function pollProposalChanges({ publicClient, ogModule, lastProposalCheckedBlock, proposalsByHash }) {
    const latestBlock = await publicClient.getBlockNumber();
    if (lastProposalCheckedBlock === undefined) {
        return {
            newProposals: [],
            executedProposals: [],
            deletedProposals: [],
            lastProposalCheckedBlock: latestBlock,
        };
    }

    if (latestBlock <= lastProposalCheckedBlock) {
        return {
            newProposals: [],
            executedProposals: [],
            deletedProposals: [],
            lastProposalCheckedBlock,
        };
    }

    const fromBlock = lastProposalCheckedBlock + 1n;
    const toBlock = latestBlock;

    const maxRange = 10n;
    const proposedLogs = [];
    const executedLogs = [];
    const deletedLogs = [];
    let currentFrom = fromBlock;
    while (currentFrom <= toBlock) {
        const currentTo =
            currentFrom + maxRange - 1n > toBlock ? toBlock : currentFrom + maxRange - 1n;

        const [chunkProposed, chunkExecuted, chunkDeleted] = await Promise.all([
            publicClient.getLogs({
                address: ogModule,
                event: transactionsProposedEvent,
                fromBlock: currentFrom,
                toBlock: currentTo,
            }),
            publicClient.getLogs({
                address: ogModule,
                event: proposalExecutedEvent,
                fromBlock: currentFrom,
                toBlock: currentTo,
            }),
            publicClient.getLogs({
                address: ogModule,
                event: proposalDeletedEvent,
                fromBlock: currentFrom,
                toBlock: currentTo,
            }),
        ]);

        proposedLogs.push(...chunkProposed);
        executedLogs.push(...chunkExecuted);
        deletedLogs.push(...chunkDeleted);

        currentFrom = currentTo + 1n;
    }

    const newProposals = [];
    for (const log of proposedLogs) {
        const proposalHash = log.args?.proposalHash;
        const assertionId = log.args?.assertionId;
        const proposal = log.args?.proposal;
        const challengeWindowEnds = log.args?.challengeWindowEnds;
        if (!proposalHash || !proposal?.transactions) continue;
        const proposer = log.args?.proposer;
        const explanationHex = log.args?.explanation;
        const rules = log.args?.rules;
        let explanation;
        if (explanationHex && typeof explanationHex === 'string') {
            if (explanationHex.startsWith('0x')) {
                try {
                    explanation = hexToString(explanationHex);
                } catch (error) {
                    explanation = undefined;
                }
            } else {
                explanation = explanationHex;
            }
        }

        const transactions = proposal.transactions.map((tx) => ({
            to: getAddress(tx.to),
            operation: Number(tx.operation ?? 0),
            value: BigInt(tx.value ?? 0),
            data: tx.data ?? '0x',
        }));

        const proposalRecord = {
            proposalHash,
            assertionId,
            proposer: proposer ? getAddress(proposer) : undefined,
            challengeWindowEnds: BigInt(challengeWindowEnds ?? 0),
            transactions,
            lastAttemptMs: 0,
            disputeAttemptMs: 0,
            rules,
            explanation,
        };
        proposalsByHash.set(proposalHash, proposalRecord);
        newProposals.push(proposalRecord);
    }

    const executedProposals = [];
    for (const log of executedLogs) {
        const proposalHash = log.args?.proposalHash;
        if (proposalHash) {
            proposalsByHash.delete(proposalHash);
            executedProposals.push(proposalHash);
        }
    }

    const deletedProposals = [];
    for (const log of deletedLogs) {
        const proposalHash = log.args?.proposalHash;
        if (proposalHash) {
            proposalsByHash.delete(proposalHash);
            deletedProposals.push(proposalHash);
        }
    }

    return { newProposals, executedProposals, deletedProposals, lastProposalCheckedBlock: toBlock };
}

async function executeReadyProposals({
    publicClient,
    walletClient,
    account,
    ogModule,
    proposalsByHash,
    executeRetryMs,
}) {
    if (proposalsByHash.size === 0) return;

    const latestBlock = await publicClient.getBlockNumber();
    const block = await publicClient.getBlock({ blockNumber: latestBlock });
    const now = BigInt(block.timestamp);
    const nowMs = Date.now();

    for (const proposal of proposalsByHash.values()) {
        if (!proposal?.transactions?.length) continue;
        if (proposal.challengeWindowEnds === undefined) continue;
        if (now < proposal.challengeWindowEnds) continue;
        if (proposal.lastAttemptMs && nowMs - proposal.lastAttemptMs < executeRetryMs) {
            continue;
        }

        proposal.lastAttemptMs = nowMs;

        let assertionId;
        try {
            assertionId = await publicClient.readContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'assertionIds',
                args: [proposal.proposalHash],
            });
        } catch (error) {
            console.warn('[agent] Failed to read assertionId:', error);
            continue;
        }

        if (!assertionId || assertionId === `0x${'0'.repeat(64)}`) {
            proposalsByHash.delete(proposal.proposalHash);
            continue;
        }

        try {
            await publicClient.simulateContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'executeProposal',
                args: [proposal.transactions],
                account: account.address,
            });
        } catch (error) {
            const reason = error?.shortMessage ?? error?.message ?? String(error);
            console.warn(
                `[agent] Proposal execution simulation failed for ${proposal.proposalHash}: ${reason}`
            );
            continue;
        }

        try {
            const txHash = await walletClient.writeContract({
                address: ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'executeProposal',
                args: [proposal.transactions],
            });
            console.log('[agent] Proposal execution submitted:', txHash);
        } catch (error) {
            console.warn('[agent] Proposal execution failed:', error?.shortMessage ?? error?.message ?? error);
        }
    }
}

export {
    primeBalances,
    pollCommitmentChanges,
    pollProposalChanges,
    executeReadyProposals,
};
