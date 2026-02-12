import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
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
import { executeToolCalls, toolDefinitions } from './lib/tools.js';
import { makeDeposit, postBondAndDispute, postBondAndPropose } from './lib/tx.js';
import { extractTimelockTriggers } from './lib/timelock.js';
import { collectPriceTriggerSignals } from './lib/uniswapV3Price.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

dotenv.config();
dotenv.config({ path: path.resolve(repoRoot, 'agent/.env') });

const config = buildConfig();
const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
const { account, walletClient } = await createSignerClient({ rpcUrl: config.rpcUrl });
const agentAddress = account.address;

const trackedAssets = new Set(config.watchAssets.map((asset) => String(asset).toLowerCase()));
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

    return { agentModule, commitmentText };
}

const { agentModule, commitmentText } = await loadAgentModule();
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

async function decideOnSignals(signals, { onchainPendingProposal = false } = {}) {
    if (!config.openAiApiKey) {
        return false;
    }

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

    try {
        const tools = toolDefinitions({
            proposeEnabled: config.proposeEnabled,
            disputeEnabled: config.disputeEnabled,
        });
        const allowTools = config.proposeEnabled || config.disputeEnabled;
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
            return true;
        }

        if (decision.toolCalls.length > 0) {
            let approvedToolCalls = decision.toolCalls;
            if (typeof agentModule?.validateToolCalls === 'function') {
                try {
                    const validated = await agentModule.validateToolCalls({
                        toolCalls: decision.toolCalls.map((call) => ({
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
                                call.arguments !== undefined
                                    ? call.arguments
                                    : JSON.stringify(call.parsedArguments ?? {}),
                        }));
                    } else {
                        approvedToolCalls = [];
                    }
                } catch (error) {
                    console.warn(
                        '[agent] validateToolCalls rejected tool calls:',
                        error?.message ?? error
                    );
                    approvedToolCalls = [];
                }
            }

            if (approvedToolCalls.length === 0) {
                return false;
            }

            const toolOutputs = await executeToolCalls({
                toolCalls: approvedToolCalls,
                publicClient,
                walletClient,
                account,
                config,
                ogContext,
            });
            if (toolOutputs.length > 0 && agentModule?.onToolOutput) {
                for (const output of toolOutputs) {
                    if (!output?.name || !output?.output) continue;
                    let parsed;
                    try {
                        parsed = JSON.parse(output.output);
                    } catch (error) {
                        parsed = null;
                    }
                    await agentModule.onToolOutput({
                        name: output.name,
                        parsedOutput: parsed,
                        commitmentText,
                        commitmentSafe: config.commitmentSafe,
                        agentAddress,
                    });
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

            if (decision.responseId && explainableOutputs.length > 0) {
                const explanation = await explainToolCalls({
                    config,
                    previousResponseId: decision.responseId,
                    toolOutputs: explainableOutputs,
                });
                if (explanation) {
                    console.log('[agent] Agent explanation:', explanation);
                }
            }
            return true;
        }

        if (decision?.textDecision) {
            console.log('[agent] Decision:', decision.textDecision);
            return true;
        }
    } catch (error) {
        console.error('[agent] Agent call failed', error);
    }

    return false;
}

async function agentLoop() {
    try {
        const triggerSeedRulesText = ogContext?.rules ?? commitmentText ?? '';
        const triggerSeed = await getActivePriceTriggers({ rulesText: triggerSeedRulesText });
        for (const trigger of triggerSeed) {
            if (trigger?.baseToken) trackedAssets.add(String(trigger.baseToken).toLowerCase());
            if (trigger?.quoteToken) trackedAssets.add(String(trigger.quoteToken).toLowerCase());
        }

        const latestBlock = await publicClient.getBlockNumber();
        const latestBlockData = await publicClient.getBlock({ blockNumber: latestBlock });
        const nowMs = Number(latestBlockData.timestamp) * 1000;

        const {
            deposits,
            balanceSnapshots,
            lastCheckedBlock: nextCheckedBlock,
            lastNativeBalance: nextNative,
            lastAssetBalances: nextAssetBalances,
        } =
            await pollCommitmentChanges({
                publicClient,
                trackedAssets,
                commitmentSafe: config.commitmentSafe,
                watchNativeBalance: config.watchNativeBalance,
                lastCheckedBlock,
                lastNativeBalance,
                lastAssetBalances,
                emitBalanceSnapshotsEveryPoll: Boolean(pollingOptions.emitBalanceSnapshotsEveryPoll),
            });
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
        } = await pollProposalChanges({
                publicClient,
                ogModule: config.ogModule,
                lastProposalCheckedBlock,
                proposalsByHash,
            });
        lastProposalCheckedBlock = nextProposalBlock;
        const executedProposalCount = executedProposals?.length ?? 0;
        const deletedProposalCount = deletedProposals?.length ?? 0;
        if (agentModule?.onProposalEvents) {
            agentModule.onProposalEvents({
                executedProposalCount,
                deletedProposalCount,
            });
        }
        if (agentModule?.reconcileProposalSubmission) {
            await agentModule.reconcileProposalSubmission({
                publicClient,
                ogModule: config.ogModule,
                startBlock: config.startBlock,
            });
        }

        await executeReadyProposals({
            publicClient,
            walletClient,
            account,
            ogModule: config.ogModule,
            proposalsByHash,
            executeRetryMs: config.executeRetryMs,
        });

        const rulesText = ogContext?.rules ?? commitmentText ?? '';
        updateTimelockSchedule({ rulesText });
        const dueTimelocks = collectDueTimelocks(nowMs);
        const activePriceTriggers = await getActivePriceTriggers({ rulesText });
        const duePriceSignals = await collectPriceTriggerSignals({
            publicClient,
            config,
            triggers: activePriceTriggers,
            nowMs,
            triggerState: priceTriggerState,
            tokenMetaCache,
            poolMetaCache,
            resolvedPoolCache,
        });

        const combinedSignals = deposits.concat(
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
            combinedSignals.push({
                kind: 'timelock',
                triggerId: trigger.id,
                triggerTimestampMs: trigger.timestampMs,
                source: trigger.source,
                anchor: trigger.anchor,
                deposit: trigger.deposit,
            });
        }
        combinedSignals.push(...duePriceSignals);

        // Allow agent module to augment signals (e.g., add timer signals)
        let signalsToProcess = combinedSignals;
        if (agentModule?.augmentSignals) {
            signalsToProcess = agentModule.augmentSignals(combinedSignals, {
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
                    onchainPendingProposal: proposalsByHash.size > 0,
                    nowMs,
                    latestBlock,
                });
            } catch (error) {
                console.error('[agent] Failed to enrich signals:', error);
            }
        }

        if (signalsToProcess.length > 0) {
            const decisionOk = await decideOnSignals(signalsToProcess, {
                onchainPendingProposal: proposalsByHash.size > 0,
            });
            if (decisionOk && dueTimelocks.length > 0) {
                markTimelocksFired(dueTimelocks);
            }
        }
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
    if (lastProposalCheckedBlock === undefined) {
        lastProposalCheckedBlock = lastCheckedBlock;
    }

    lastNativeBalance = await primeBalances({
        publicClient,
        commitmentSafe: config.commitmentSafe,
        watchNativeBalance: config.watchNativeBalance,
        blockNumber: lastCheckedBlock,
    });

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
