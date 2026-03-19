import { createMessageApiServer } from './message-api.js';
import { processQueuedUserMessages } from './message-loop.js';
import { DECISION_STATUS } from './decision-support.js';
import { runLoopPhase } from './loop-phase.js';
import {
    loadOgContext,
    loadOptimisticGovernorDefaults,
    logOgFundingStatus,
} from './og.js';
import {
    executeReadyProposals,
    pollCommitmentChanges,
    pollProposalChanges,
    primeBalances,
} from './polling.js';

export function createAgentLoopRunner({
    config,
    publicClient,
    walletClient,
    account,
    agentModule,
    commitmentText,
    trackedAssets,
    messageInbox,
    pollingOptions,
    signalPreparation,
    decideOnSignals,
}) {
    let decideOnSignalsFn = decideOnSignals;
    let lastCheckedBlock = config.startBlock;
    let lastProposalCheckedBlock = config.startBlock;
    let lastNativeBalance;
    let lastAssetBalances = new Map();
    let ogContext;
    let messageApiServer;
    const proposalsByHash = new Map();

    function getOgContext() {
        return ogContext;
    }

    async function ensureOgContext() {
        if (!ogContext) {
            ogContext = await loadOgContext({ publicClient, ogModule: config.ogModule });
        }
        return ogContext;
    }

    async function agentLoop() {
        try {
            const queuedMessageCountAtLoopStart = messageInbox?.getQueueDepth?.() ?? 0;
            const noisyLoop = queuedMessageCountAtLoopStart > 0;
            if (noisyLoop) {
                console.log(
                    `[agent] Starting loop with ${queuedMessageCountAtLoopStart} queued user message(s).`
                );
            }

            const triggerSeedRulesText = getOgContext()?.rules ?? commitmentText ?? '';
            await signalPreparation.seedTrackedAssetsFromRules({ rulesText: triggerSeedRulesText });

            const { latestBlock, latestBlockData } = await runLoopPhase(
                'load_head_block',
                async () => {
                    const latestBlock = await publicClient.getBlockNumber();
                    const latestBlockData = await publicClient.getBlock({
                        blockNumber: latestBlock,
                    });
                    return { latestBlock, latestBlockData };
                },
                {
                    logStart: noisyLoop,
                    context: {
                        queuedMessages: queuedMessageCountAtLoopStart,
                    },
                }
            );
            const nowMs = Number(latestBlockData.timestamp) * 1000;

            const {
                deposits,
                balanceSnapshots,
                lastCheckedBlock: nextCheckedBlock,
                lastNativeBalance: nextNative,
                lastAssetBalances: nextAssetBalances,
            } = await runLoopPhase(
                'poll_commitment_changes',
                async () =>
                    pollCommitmentChanges({
                        publicClient,
                        trackedAssets,
                        trackedErc1155Assets: config.watchErc1155Assets,
                        commitmentSafe: config.commitmentSafe,
                        watchNativeBalance: config.watchNativeBalance,
                        lastCheckedBlock,
                        lastNativeBalance,
                        lastAssetBalances,
                        logChunkSize: config.logChunkSize,
                        emitBalanceSnapshotsEveryPoll: Boolean(
                            pollingOptions.emitBalanceSnapshotsEveryPoll
                        ),
                    }),
                {
                    logStart: noisyLoop,
                    context: {
                        queuedMessages: queuedMessageCountAtLoopStart,
                        fromBlock: lastCheckedBlock?.toString?.() ?? 'unset',
                    },
                }
            );
            lastCheckedBlock = nextCheckedBlock;
            lastNativeBalance = nextNative;
            lastAssetBalances = nextAssetBalances ?? lastAssetBalances;
            await signalPreparation.recordDeposits(deposits);

            const {
                newProposals,
                executedProposals,
                deletedProposals,
                lastProposalCheckedBlock: nextProposalBlock,
            } = await runLoopPhase(
                'poll_proposal_changes',
                async () =>
                    pollProposalChanges({
                        publicClient,
                        ogModule: config.ogModule,
                        lastProposalCheckedBlock,
                        proposalsByHash,
                        startBlock: config.startBlock,
                        logChunkSize: config.logChunkSize,
                    }),
                {
                    logStart: noisyLoop,
                    context: {
                        queuedMessages: queuedMessageCountAtLoopStart,
                        fromBlock: lastProposalCheckedBlock?.toString?.() ?? 'unset',
                    },
                }
            );
            lastProposalCheckedBlock = nextProposalBlock;
            const executedProposalCount = executedProposals?.length ?? 0;
            const deletedProposalCount = deletedProposals?.length ?? 0;
            if (agentModule?.onProposalEvents) {
                agentModule.onProposalEvents({
                    executedProposalCount,
                    deletedProposalCount,
                    executedProposals,
                    deletedProposals,
                    config,
                });
            }
            if (agentModule?.reconcileProposalSubmission) {
                await agentModule.reconcileProposalSubmission({
                    publicClient,
                    ogModule: config.ogModule,
                    startBlock: config.startBlock,
                    config,
                });
            }

            await runLoopPhase(
                'execute_ready_proposals',
                async () =>
                    executeReadyProposals({
                        publicClient,
                        walletClient,
                        account,
                        ogModule: config.ogModule,
                        proposalsByHash,
                        executeRetryMs: config.executeRetryMs,
                        executePendingTxTimeoutMs: config.executePendingTxTimeoutMs,
                    }),
                {
                    logStart: noisyLoop && proposalsByHash.size > 0,
                    context: {
                        queuedMessages: queuedMessageCountAtLoopStart,
                        proposals: proposalsByHash.size,
                    },
                }
            );

            const rulesText = getOgContext()?.rules ?? commitmentText ?? '';
            signalPreparation.updateTimelockSchedule({ rulesText });
            const dueTimelocks = signalPreparation.collectDueTimelocks(nowMs);
            const activePriceTriggers = await signalPreparation.getActivePriceTriggers({
                rulesText,
            });
            const duePriceSignals = await runLoopPhase(
                'collect_price_trigger_signals',
                async () =>
                    signalPreparation.collectPriceSignals({
                        triggers: activePriceTriggers,
                        nowMs,
                    }),
                {
                    logStart: noisyLoop && activePriceTriggers.length > 0,
                    context: {
                        queuedMessages: queuedMessageCountAtLoopStart,
                        triggers: activePriceTriggers.length,
                    },
                }
            );
            const baseSignals = deposits.concat(
                balanceSnapshots,
                newProposals.map((proposal) => ({
                    kind: 'proposal',
                    proposalHash: proposal.proposalHash,
                    assertionId: proposal.assertionId,
                    proposer: proposal.proposer,
                    challengeWindowEnds: proposal.challengeWindowEnds,
                    transactions: proposal.transactions,
                    rules: proposal.rules,
                    explanation: proposal.explanation,
                }))
            );

            for (const trigger of dueTimelocks) {
                baseSignals.push({
                    kind: 'timelock',
                    triggerId: trigger.id,
                    triggerTimestampMs: trigger.timestampMs,
                    source: trigger.source,
                    anchor: trigger.anchor,
                    deposit: trigger.deposit,
                });
            }
            baseSignals.push(...duePriceSignals);

            const onchainPendingProposal = proposalsByHash.size > 0;
            let decisionStatus = DECISION_STATUS.NO_ACTION;
            if (baseSignals.length > 0) {
                const signalsToProcess = await runLoopPhase(
                    'prepare_base_signals',
                    async () =>
                        signalPreparation.prepareSignalsForDecision(baseSignals, {
                            nowMs,
                            latestBlock,
                            onchainPendingProposal,
                        }),
                    {
                        logStart: noisyLoop,
                        context: {
                            queuedMessages: queuedMessageCountAtLoopStart,
                            baseSignals: baseSignals.length,
                        },
                    }
                );
                if (signalsToProcess.length > 0) {
                    decisionStatus = await runLoopPhase(
                        'decide_on_base_signals',
                        async () =>
                            decideOnSignalsFn(signalsToProcess, {
                                onchainPendingProposal,
                            }),
                        {
                            logStart: noisyLoop,
                            context: {
                                queuedMessages: queuedMessageCountAtLoopStart,
                                signals: signalsToProcess.length,
                            },
                        }
                    );
                }
                if (
                    decisionStatus === DECISION_STATUS.HANDLED &&
                    dueTimelocks.length > 0
                ) {
                    signalPreparation.markTimelocksFired(dueTimelocks);
                }
            }

            const queuedMessageCountBeforeProcessing = messageInbox?.getQueueDepth?.() ?? 0;
            await runLoopPhase(
                'process_queued_user_messages',
                async () =>
                    processQueuedUserMessages({
                        messageInbox,
                        maxBatchSize: config.messageApiBatchSize,
                        nowMs,
                        latestBlock,
                        onchainPendingProposal,
                        prepareSignals: signalPreparation.prepareSignalsForDecision,
                        decideOnSignals: decideOnSignalsFn,
                    }),
                {
                    logStart: queuedMessageCountBeforeProcessing > 0,
                    context: {
                        queueDepth: queuedMessageCountBeforeProcessing,
                        latestBlock: latestBlock.toString(),
                    },
                }
            );
        } catch (error) {
            console.error('[agent] loop error', error);
        }

        setTimeout(agentLoop, config.pollIntervalMs);
    }

    async function startAgent() {
        if (typeof decideOnSignalsFn !== 'function') {
            throw new Error('Missing decideOnSignals runtime callback');
        }
        await loadOptimisticGovernorDefaults({
            publicClient,
            ogModule: config.ogModule,
            trackedAssets,
        });

        ogContext = await loadOgContext({ publicClient, ogModule: config.ogModule });
        await logOgFundingStatus({ publicClient, ogModule: config.ogModule, account });

        if (lastCheckedBlock === undefined) {
            lastCheckedBlock = await publicClient.getBlockNumber();
        }
        lastNativeBalance = await primeBalances({
            publicClient,
            commitmentSafe: config.commitmentSafe,
            watchNativeBalance: config.watchNativeBalance,
            blockNumber: lastCheckedBlock,
        });

        if (messageInbox && !messageApiServer) {
            messageApiServer = createMessageApiServer({
                config,
                inbox: messageInbox,
            });
            await messageApiServer.start();
        }

        console.log('[agent] running...');
        agentLoop();
    }

    return {
        startAgent,
        getOgContext,
        ensureOgContext,
        setDecideOnSignals(decideOnSignalsCallback) {
            decideOnSignalsFn = decideOnSignalsCallback;
        },
    };
}
