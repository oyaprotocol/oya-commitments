import { erc20Abi, getAddress, hexToString, isAddressEqual, zeroAddress } from 'viem';
import {
    optimisticGovernorAbi,
    proposalDeletedEvent,
    proposalExecutedEvent,
    transactionsProposedEvent,
    transferEvent,
} from './og.js';
import { findContractDeploymentBlock, getLogsChunked } from './chain-history.js';

function getAlwaysEmitBalanceSnapshotPollingOptions() {
    return {
        emitBalanceSnapshotsEveryPoll: true,
    };
}

function isReceiptUnavailableError(error) {
    const name = String(error?.name ?? '');
    if (name.includes('TransactionReceiptNotFoundError') || name.includes('TransactionNotFoundError')) {
        return true;
    }

    const message = String(error?.shortMessage ?? error?.message ?? '').toLowerCase();
    return message.includes('transaction receipt') && message.includes('not found');
}

function isReceiptReverted(receipt) {
    const status = receipt?.status;
    return status === 0n || status === 0 || status === 'reverted';
}

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
    logChunkSize,
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
            lastAssetBalances: lastAssetBalances ?? initialAssetBalanceMap,
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

    for (const asset of trackedAssets) {
        if (isAddressEqual(asset, zeroAddress)) {
            continue;
        }
        const logs = await getLogsChunked({
            publicClient,
            address: asset,
            event: transferEvent,
            args: { to: commitmentSafe },
            fromBlock,
            toBlock,
            chunkSize: logChunkSize,
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

async function resolveInitialProposalScanStartBlock({
    publicClient,
    ogModule,
    startBlock,
    latestBlock,
}) {
    if (startBlock !== undefined) {
        return BigInt(startBlock);
    }

    try {
        const discovered = await findContractDeploymentBlock({
            publicClient,
            address: ogModule,
            latestBlock,
        });
        if (discovered !== null) {
            console.log(
                `[agent] Backfilling proposal history from OG deployment block ${discovered.toString()}.`
            );
            return discovered;
        }
    } catch (error) {
        console.warn(
            '[agent] Failed to auto-discover proposal scan start block; skipping startup backfill.',
            error?.message ?? error
        );
    }

    return latestBlock + 1n;
}

async function pollProposalChanges({
    publicClient,
    ogModule,
    lastProposalCheckedBlock,
    proposalsByHash,
    startBlock,
    logChunkSize,
}) {
    const latestBlock = await publicClient.getBlockNumber();
    let fromBlock;
    if (lastProposalCheckedBlock === undefined) {
        fromBlock = await resolveInitialProposalScanStartBlock({
            publicClient,
            ogModule,
            startBlock,
            latestBlock,
        });
        if (fromBlock > latestBlock) {
            return {
                newProposals: [],
                executedProposals: [],
                deletedProposals: [],
                lastProposalCheckedBlock: latestBlock,
            };
        }
    } else if (latestBlock <= lastProposalCheckedBlock) {
        return {
            newProposals: [],
            executedProposals: [],
            deletedProposals: [],
            lastProposalCheckedBlock,
        };
    } else {
        fromBlock = lastProposalCheckedBlock + 1n;
    }
    const toBlock = latestBlock;

    const [proposedLogs, executedLogs, deletedLogs] = await Promise.all([
        getLogsChunked({
            publicClient,
            address: ogModule,
            event: transactionsProposedEvent,
            fromBlock,
            toBlock,
            chunkSize: logChunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: ogModule,
            event: proposalExecutedEvent,
            fromBlock,
            toBlock,
            chunkSize: logChunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: ogModule,
            event: proposalDeletedEvent,
            fromBlock,
            toBlock,
            chunkSize: logChunkSize,
        }),
    ]);

    // Process proposal lifecycle events in strict chain order so startup backfills
    // do not emit stale proposals that are finalized later in the same scan range.
    const lifecycleEvents = [
        ...proposedLogs.map((log) => ({ kind: 'proposed', log })),
        ...executedLogs.map((log) => ({ kind: 'executed', log })),
        ...deletedLogs.map((log) => ({ kind: 'deleted', log })),
    ].sort((left, right) => {
        const leftBlock = BigInt(left.log?.blockNumber ?? 0n);
        const rightBlock = BigInt(right.log?.blockNumber ?? 0n);
        if (leftBlock !== rightBlock) {
            return leftBlock < rightBlock ? -1 : 1;
        }
        const leftLogIndex = BigInt(left.log?.logIndex ?? 0);
        const rightLogIndex = BigInt(right.log?.logIndex ?? 0);
        if (leftLogIndex === rightLogIndex) return 0;
        return leftLogIndex < rightLogIndex ? -1 : 1;
    });

    const newProposalsByHash = new Map();
    const executedProposals = [];
    const deletedProposals = [];

    for (const event of lifecycleEvents) {
        const log = event.log;
        if (event.kind === 'proposed') {
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
                executionTxHash: null,
                executionSubmittedMs: null,
                disputeAttemptMs: 0,
                rules,
                explanation,
            };

            proposalsByHash.set(proposalHash, proposalRecord);
            newProposalsByHash.set(proposalHash, proposalRecord);
            continue;
        }

        const proposalHash = log.args?.proposalHash;
        if (!proposalHash) continue;

        proposalsByHash.delete(proposalHash);
        newProposalsByHash.delete(proposalHash);

        if (event.kind === 'executed') {
            executedProposals.push(proposalHash);
            continue;
        }

        deletedProposals.push(proposalHash);
    }

    const newProposals = [...newProposalsByHash.values()];

    return { newProposals, executedProposals, deletedProposals, lastProposalCheckedBlock: toBlock };
}

async function executeReadyProposals({
    publicClient,
    walletClient,
    account,
    ogModule,
    proposalsByHash,
    executeRetryMs,
    executePendingTxTimeoutMs,
}) {
    if (proposalsByHash.size === 0) return;

    const latestBlock = await publicClient.getBlockNumber();
    const block = await publicClient.getBlock({ blockNumber: latestBlock });
    const now = BigInt(block.timestamp);
    const nowMs = Date.now();
    const pendingTxTimeoutMs =
        Number.isFinite(executePendingTxTimeoutMs) && executePendingTxTimeoutMs > 0
            ? executePendingTxTimeoutMs
            : 900_000;

    for (const proposal of proposalsByHash.values()) {
        if (!proposal?.transactions?.length) continue;
        if (proposal.challengeWindowEnds === undefined) continue;
        if (now < proposal.challengeWindowEnds) continue;

        if (proposal.executionTxHash) {
            try {
                const receipt = await publicClient.getTransactionReceipt({
                    hash: proposal.executionTxHash,
                });
                if (isReceiptReverted(receipt)) {
                    console.warn(
                        `[agent] Proposal execution tx reverted for ${proposal.proposalHash}; retrying after backoff.`
                    );
                    proposal.executionTxHash = null;
                    proposal.executionSubmittedMs = null;
                } else {
                    continue;
                }
            } catch (error) {
                if (!isReceiptUnavailableError(error)) {
                    console.warn(
                        `[agent] Failed to read proposal execution receipt for ${proposal.proposalHash}: ${error?.shortMessage ?? error?.message ?? error}`
                    );
                    continue;
                }

                const executionSubmittedMs = Number(
                    proposal.executionSubmittedMs ?? proposal.lastAttemptMs ?? 0
                );
                const pendingForMs = Math.max(0, nowMs - executionSubmittedMs);
                if (
                    Number.isFinite(executionSubmittedMs) &&
                    executionSubmittedMs > 0 &&
                    pendingForMs < pendingTxTimeoutMs
                ) {
                    continue;
                }

                console.warn(
                    `[agent] Proposal execution tx ${proposal.executionTxHash} for ${proposal.proposalHash} has no receipt after ${pendingTxTimeoutMs}ms; allowing retry.`
                );
                proposal.executionTxHash = null;
                proposal.executionSubmittedMs = null;
            }
        }

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
            proposal.executionTxHash = txHash;
            proposal.executionSubmittedMs = nowMs;
            console.log('[agent] Proposal execution submitted:', txHash);
        } catch (error) {
            console.warn('[agent] Proposal execution failed:', error?.shortMessage ?? error?.message ?? error);
        }
    }
}

export {
    primeBalances,
    getAlwaysEmitBalanceSnapshotPollingOptions,
    pollCommitmentChanges,
    pollProposalChanges,
    executeReadyProposals,
};
