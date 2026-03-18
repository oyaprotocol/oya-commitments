import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import { loadAgentConfigFile, resolveAgentRuntimeConfig } from './lib/agent-config.js';
import { buildConfig } from './lib/config.js';
import { createSignerClient } from './lib/signer.js';
import {
    loadOgContext,
    loadOptimisticGovernorDefaults,
    logOgFundingStatus,
} from './lib/og.js';
import {
    executeReadyProposals,
    pollCommitmentChanges,
    pollProposalChanges,
    primeBalances,
} from './lib/polling.js';
import { callAgent, explainToolCalls, parseToolArguments } from './lib/llm.js';
import { executeToolCalls, hasCommittedToolSideEffects, toolDefinitions } from './lib/tools.js';
import { makeDeposit, postBondAndDispute, postBondAndPropose } from './lib/tx.js';
import { extractTimelockTriggers } from './lib/timelock.js';
import { collectPriceTriggerSignals } from './lib/uniswapV3Price.js';
import { createMessageInbox } from './lib/message-inbox.js';
import { createMessageApiServer } from './lib/message-api.js';
import { processQueuedUserMessages } from './lib/message-loop.js';
import {
    DECISION_STATUS,
    evaluateToolOutputsDecisionStatus,
    hasDeterministicDecisionEngine,
    isRetryableDecisionError,
    validateMessageApiDecisionEngine,
} from './lib/decision-support.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

dotenv.config();
dotenv.config({ path: path.resolve(repoRoot, 'agent/.env') });

const config = buildConfig();
const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
const { account, walletClient } = await createSignerClient({ rpcUrl: config.rpcUrl });
const agentAddress = account.address;

const trackedAssets = new Set();
let lastCheckedBlock = config.startBlock;
let lastProposalCheckedBlock = config.startBlock;
let lastNativeBalance;
let lastAssetBalances = new Map();
let ogContext;
const proposalsByHash = new Map();
const depositHistory = [];
const blockTimestampCache = new Map();
const timelockTriggers = new Map();
const priceTriggerState = new Map();
const tokenMetaCache = new Map();
const poolMetaCache = new Map();
const resolvedPoolCache = new Map();
const LOOP_PHASE_WARN_INTERVAL_MS = 15_000;
let messageInbox = null;
let messageApiServer;

function formatLoopPhaseContext(context) {
    if (!context || typeof context !== 'object') {
        return '';
    }
    const parts = Object.entries(context)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${value}`);
    return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}

async function runLoopPhase(name, work, { warnIntervalMs = LOOP_PHASE_WARN_INTERVAL_MS, logStart = false, context } = {}) {
    const startedAtMs = Date.now();
    const contextText = formatLoopPhaseContext(context);
    if (logStart) {
        console.log(`[agent] Loop phase started: ${name}${contextText}.`);
    }

    let warningCount = 0;
    const timer =
        warnIntervalMs > 0
            ? setInterval(() => {
                warningCount += 1;
                console.warn(
                    `[agent] Loop phase still running: ${name}${contextText} elapsedMs=${warningCount * warnIntervalMs}.`
                );
            }, warnIntervalMs)
            : null;
    timer?.unref?.();

    try {
        const result = await work();
        const durationMs = Date.now() - startedAtMs;
        if (logStart || durationMs >= warnIntervalMs) {
            console.log(
                `[agent] Loop phase complete: ${name}${contextText} durationMs=${durationMs}.`
            );
        }
        return result;
    } catch (error) {
        const durationMs = Date.now() - startedAtMs;
        console.error(
            `[agent] Loop phase failed: ${name}${contextText} durationMs=${durationMs}.`,
            error
        );
        throw error;
    } finally {
        if (timer) {
            clearInterval(timer);
        }
    }
}

async function loadAgentModule() {
    const agentRef = config.agentModule ?? 'default';
    const modulePath = agentRef.includes('/')
        ? agentRef
        : `agent-library/agents/${agentRef}/agent.js`;
    const resolvedPath = path.resolve(repoRoot, modulePath);
    const moduleUrl = pathToFileURL(resolvedPath).href;
    const agentModule = await import(moduleUrl);

    const commitmentPath = path.join(path.dirname(resolvedPath), 'commitment.txt');
    let commitmentText = '';
    try {
        commitmentText = (await readFile(commitmentPath, 'utf8')).trim();
    } catch (error) {
        console.warn('[agent] Missing commitment.txt next to agent module:', commitmentPath);
    }

    const agentConfigPath = path.join(path.dirname(resolvedPath), 'config.json');
    const agentConfigFile = await loadAgentConfigFile(agentConfigPath);

    return { agentModule, commitmentText, agentConfigFile };
}

const { agentModule, commitmentText, agentConfigFile } = await loadAgentModule();
const runtimeChainId = await publicClient.getChainId();
Object.assign(
    config,
    resolveAgentRuntimeConfig({
        baseConfig: config,
        agentConfigFile,
        chainId: runtimeChainId,
    })
);
if (!config.commitmentSafe) {
    throw new Error('Missing COMMITMENT_SAFE env or agent config.json commitmentSafe for the active chain.');
}
if (!config.ogModule) {
    throw new Error('Missing OG_MODULE env or agent config.json ogModule for the active chain.');
}
if (config.messageApiEnabled) {
    messageInbox = createMessageInbox({
        queueLimit: config.messageApiQueueLimit,
        defaultTtlSeconds: config.messageApiDefaultTtlSeconds,
        minTtlSeconds: config.messageApiMinTtlSeconds,
        maxTtlSeconds: config.messageApiMaxTtlSeconds,
        idempotencyTtlSeconds: config.messageApiIdempotencyTtlSeconds,
        signedReplayWindowSeconds: config.messageApiSignatureMaxAgeSeconds,
        maxTextLength: config.messageApiMaxTextLength,
        rateLimitPerMinute: config.messageApiRateLimitPerMinute,
        rateLimitBurst: config.messageApiRateLimitBurst,
    });
}
for (const asset of config.watchAssets) {
    trackedAssets.add(String(asset).toLowerCase());
}
validateMessageApiDecisionEngine({ config, agentModule });
const pollingOptions = (() => {
    if (typeof agentModule?.getPollingOptions !== 'function') {
        return {};
    }
    try {
        return agentModule.getPollingOptions({ commitmentText }) ?? {};
    } catch (error) {
        console.warn('[agent] getPollingOptions() failed; using defaults.');
        return {};
    }
})();

async function getBlockTimestampMs(blockNumber) {
    if (!blockNumber) return undefined;
    const key = blockNumber.toString();
    if (blockTimestampCache.has(key)) {
        return blockTimestampCache.get(key);
    }
    const block = await publicClient.getBlock({ blockNumber });
    const timestampMs = Number(block.timestamp) * 1000;
    blockTimestampCache.set(key, timestampMs);
    return timestampMs;
}

function updateTimelockSchedule({ rulesText }) {
    const triggers = extractTimelockTriggers({
        rulesText,
        deposits: depositHistory,
    });

    for (const trigger of triggers) {
        if (!timelockTriggers.has(trigger.id)) {
            timelockTriggers.set(trigger.id, { ...trigger, fired: false });
        }
    }
}

function collectDueTimelocks(nowMs) {
    const due = [];
    for (const trigger of timelockTriggers.values()) {
        if (trigger.fired) continue;
        if (trigger.timestampMs <= nowMs) {
            due.push(trigger);
        }
    }
    return due;
}

function markTimelocksFired(triggers) {
    for (const trigger of triggers) {
        const existing = timelockTriggers.get(trigger.id);
        if (existing) {
            existing.fired = true;
        }
    }
}

async function getActivePriceTriggers({ rulesText }) {
    if (typeof agentModule?.getPriceTriggers === 'function') {
        try {
            const parsed = await agentModule.getPriceTriggers({
                commitmentText: rulesText,
                config,
            });
            if (Array.isArray(parsed)) {
                return parsed;
            }
            console.warn('[agent] getPriceTriggers() returned non-array; ignoring.');
            return [];
        } catch (error) {
            console.warn(
                '[agent] getPriceTriggers() failed; skipping price triggers:',
                error?.message ?? error
            );
            return [];
        }
    }

    return [];
}

async function processAgentToolCalls({
    toolCalls,
    signals,
    commitmentText,
    onchainPendingProposal,
    decisionResponseId,
}) {
    let approvedToolCalls = toolCalls;
    if (typeof agentModule?.validateToolCalls === 'function') {
        try {
            const validated = await agentModule.validateToolCalls({
                toolCalls: toolCalls.map((call) => ({
                    ...call,
                    parsedArguments: parseToolArguments(call.arguments),
                })),
                signals,
                commitmentText,
                commitmentSafe: config.commitmentSafe,
                agentAddress,
                publicClient,
                config,
                onchainPendingProposal,
            });
            if (Array.isArray(validated)) {
                approvedToolCalls = validated.map((call) => ({
                    name: call.name,
                    callId: call.callId,
                    arguments:
                        call.parsedArguments !== undefined
                            ? JSON.stringify(call.parsedArguments)
                            : call.arguments !== undefined
                                ? call.arguments
                                : JSON.stringify({}),
                }));
            } else {
                approvedToolCalls = [];
            }
        } catch (error) {
            const retryableValidationError = isRetryableDecisionError(error);
            console.warn(
                '[agent] validateToolCalls failed:',
                error?.message ?? error
            );
            return retryableValidationError
                ? DECISION_STATUS.FAILED_RETRYABLE
                : DECISION_STATUS.FAILED_NON_RETRYABLE;
        }
    }

    if (approvedToolCalls.length === 0) {
        return DECISION_STATUS.NO_ACTION;
    }

    let toolOutputs;
    try {
        toolOutputs = await executeToolCalls({
            toolCalls: approvedToolCalls,
            publicClient,
            walletClient,
            account,
            config,
            ogContext,
        });
    } catch (error) {
        const sideEffectsLikelyCommitted = hasCommittedToolSideEffects(error);
        const retryableExecutionError = isRetryableDecisionError(error);
        console.error('[agent] Tool execution failed:', error?.message ?? error);
        // Never replay messages when side effects may already be committed.
        if (sideEffectsLikelyCommitted) {
            return DECISION_STATUS.FAILED_NON_RETRYABLE;
        }
        // For pre-side-effect failures, retry only transient/network-like errors.
        return retryableExecutionError
            ? DECISION_STATUS.FAILED_RETRYABLE
            : DECISION_STATUS.FAILED_NON_RETRYABLE;
    }

    for (const output of toolOutputs) {
        if (!output?.name || typeof output.output !== 'string') {
            continue;
        }
        let payload = null;
        try {
            payload = JSON.parse(output.output);
        } catch (error) {
            continue;
        }
        const status =
            typeof payload?.status === 'string' && payload.status.trim()
                ? payload.status.trim().toLowerCase()
                : '';
        if (status === 'error') {
            const message =
                typeof payload?.message === 'string' && payload.message.trim()
                    ? payload.message.trim()
                    : 'unknown tool error';
            console.warn(
                `[agent] Tool output error: name=${output.name} callId=${output.callId ?? 'unknown'} retryable=${payload?.retryable === true} sideEffectsLikelyCommitted=${payload?.sideEffectsLikelyCommitted === true} message=${message}`
            );
        } else if (status === 'skipped') {
            const reason =
                typeof payload?.reason === 'string' && payload.reason.trim()
                    ? payload.reason.trim()
                    : 'no reason provided';
            console.warn(
                `[agent] Tool output skipped: name=${output.name} callId=${output.callId ?? 'unknown'} reason=${reason}`
            );
        }
    }

    if (toolOutputs.length > 0 && agentModule?.onToolOutput) {
        for (const output of toolOutputs) {
            if (!output?.name || !output?.output) continue;
            let parsed;
            try {
                parsed = JSON.parse(output.output);
            } catch (error) {
                parsed = null;
            }
            try {
                await agentModule.onToolOutput({
                    name: output.name,
                    parsedOutput: parsed,
                    commitmentText,
                    commitmentSafe: config.commitmentSafe,
                    agentAddress,
                    config,
                });
            } catch (error) {
                // Tool already executed; hook failures should not trigger message replay.
                console.warn('[agent] onToolOutput hook failed:', error?.message ?? error);
            }
        }
    }
    const modelCallIds = new Set(
        approvedToolCalls
            .map((call) => call?.callId)
            .filter((callId) => typeof callId === 'string' && callId.length > 0)
    );
    const explainableOutputs = toolOutputs.filter(
        (output) => output?.callId && modelCallIds.has(output.callId)
    );

    if (decisionResponseId && explainableOutputs.length > 0) {
        try {
            const explanation = await explainToolCalls({
                config,
                previousResponseId: decisionResponseId,
                toolOutputs: explainableOutputs,
            });
            if (explanation) {
                console.log('[agent] Agent explanation:', explanation);
            }
        } catch (error) {
            // Explanation is observability-only and should not affect ack/requeue outcomes.
            console.warn('[agent] Failed to fetch post-tool explanation:', error?.message ?? error);
        }
    }
    return evaluateToolOutputsDecisionStatus(toolOutputs);
}

async function decideOnSignals(signals, { onchainPendingProposal = false } = {}) {
    if (hasDeterministicDecisionEngine(agentModule)) {
        try {
            const deterministicCalls = await agentModule.getDeterministicToolCalls({
                signals,
                commitmentText,
                commitmentSafe: config.commitmentSafe,
                agentAddress,
                publicClient,
                config,
                onchainPendingProposal,
            });
            if (Array.isArray(deterministicCalls) && deterministicCalls.length > 0) {
                return processAgentToolCalls({
                    toolCalls: deterministicCalls,
                    signals,
                    commitmentText,
                    onchainPendingProposal,
                    decisionResponseId: null,
                });
            }
            return DECISION_STATUS.NO_ACTION;
        } catch (error) {
            const retryableDeterministicError = isRetryableDecisionError(error);
            console.error('[agent] Deterministic tool-call generation failed', error);
            return retryableDeterministicError
                ? DECISION_STATUS.FAILED_RETRYABLE
                : DECISION_STATUS.FAILED_NON_RETRYABLE;
        }
    }

    if (!config.openAiApiKey) {
        return DECISION_STATUS.NO_ACTION;
    }

    try {
        if (!ogContext) {
            ogContext = await loadOgContext({
                publicClient,
                ogModule: config.ogModule,
            });
        }

        const systemPrompt =
            agentModule?.getSystemPrompt?.({
                proposeEnabled: config.proposeEnabled,
                disputeEnabled: config.disputeEnabled,
                commitmentText,
            }) ??
            'You are an agent monitoring an onchain commitment (Safe + Optimistic Governor).';

        const executableToolsEnabled =
            config.proposeEnabled ||
            config.disputeEnabled ||
            config.polymarketClobEnabled ||
            config.ipfsEnabled;
        const tools = toolDefinitions({
            proposeEnabled: config.proposeEnabled,
            disputeEnabled: config.disputeEnabled,
            clobEnabled: config.polymarketClobEnabled,
            ipfsEnabled: config.ipfsEnabled,
            onchainToolsEnabled: config.proposeEnabled || config.disputeEnabled,
        });
        const allowTools = executableToolsEnabled;
        const decision = await callAgent({
            config,
            systemPrompt,
            signals,
            ogContext,
            commitmentText,
            agentAddress,
            tools,
            allowTools,
        });

        if (!allowTools && decision?.textDecision) {
            console.log('[agent] Opinion:', decision.textDecision);
            return DECISION_STATUS.HANDLED;
        }

        if (decision.toolCalls.length > 0) {
            return processAgentToolCalls({
                toolCalls: decision.toolCalls,
                signals,
                commitmentText,
                onchainPendingProposal,
                decisionResponseId: decision.responseId,
            });
        }

        if (decision?.textDecision) {
            console.log('[agent] Decision:', decision.textDecision);
            return DECISION_STATUS.HANDLED;
        }
    } catch (error) {
        const retryableAgentError = isRetryableDecisionError(error);
        console.error('[agent] Agent call failed', error);
        return retryableAgentError
            ? DECISION_STATUS.FAILED_RETRYABLE
            : DECISION_STATUS.FAILED_NON_RETRYABLE;
    }

    return DECISION_STATUS.NO_ACTION;
}

async function prepareSignalsForDecision(
    signals,
    { nowMs, latestBlock, onchainPendingProposal }
) {
    let signalsToProcess = signals;
    if (agentModule?.augmentSignals) {
        signalsToProcess = agentModule.augmentSignals(signalsToProcess, {
            nowMs,
            latestBlock,
        });
    }
    if (agentModule?.enrichSignals) {
        try {
            signalsToProcess = await agentModule.enrichSignals(signalsToProcess, {
                publicClient,
                config,
                account,
                onchainPendingProposal,
                nowMs,
                latestBlock,
            });
        } catch (error) {
            console.error('[agent] Failed to enrich signals:', error);
        }
    }
    return Array.isArray(signalsToProcess) ? signalsToProcess : [];
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

        const triggerSeedRulesText = ogContext?.rules ?? commitmentText ?? '';
        const triggerSeed = await getActivePriceTriggers({ rulesText: triggerSeedRulesText });
        for (const trigger of triggerSeed) {
            if (trigger?.baseToken) trackedAssets.add(String(trigger.baseToken).toLowerCase());
            if (trigger?.quoteToken) trackedAssets.add(String(trigger.quoteToken).toLowerCase());
        }

        const { latestBlock, latestBlockData } = await runLoopPhase(
            'load_head_block',
            async () => {
                const latestBlock = await publicClient.getBlockNumber();
                const latestBlockData = await publicClient.getBlock({ blockNumber: latestBlock });
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
                emitBalanceSnapshotsEveryPoll: Boolean(pollingOptions.emitBalanceSnapshotsEveryPoll),
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

        for (const deposit of deposits) {
            const timestampMs = await getBlockTimestampMs(deposit.blockNumber);
            depositHistory.push({
                ...deposit,
                timestampMs,
            });
        }

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

        const rulesText = ogContext?.rules ?? commitmentText ?? '';
        updateTimelockSchedule({ rulesText });
        const dueTimelocks = collectDueTimelocks(nowMs);
        const activePriceTriggers = await getActivePriceTriggers({ rulesText });
        const duePriceSignals = await runLoopPhase(
            'collect_price_trigger_signals',
            async () =>
                collectPriceTriggerSignals({
                    publicClient,
                    config,
                    triggers: activePriceTriggers,
                    nowMs,
                    triggerState: priceTriggerState,
                    tokenMetaCache,
                    poolMetaCache,
                    resolvedPoolCache,
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
                    prepareSignalsForDecision(baseSignals, {
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
                        decideOnSignals(signalsToProcess, {
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
            if (decisionStatus === DECISION_STATUS.HANDLED && dueTimelocks.length > 0) {
                markTimelocksFired(dueTimelocks);
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
                    prepareSignals: prepareSignalsForDecision,
                    decideOnSignals,
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

if (import.meta.url === `file://${process.argv[1]}`) {
    startAgent().catch((error) => {
        console.error('[agent] failed to start', error);
        process.exit(1);
    });
}

export { makeDeposit, postBondAndDispute, postBondAndPropose, startAgent };
