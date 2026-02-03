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
import { callAgent, explainToolCalls } from './lib/llm.js';
import { executeToolCalls, toolDefinitions } from './lib/tools.js';
import { makeDeposit, postBondAndDispute, postBondAndPropose } from './lib/tx.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

dotenv.config();
dotenv.config({ path: path.resolve(repoRoot, 'agent/.env') });

const config = buildConfig();
const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
const { account, walletClient } = await createSignerClient({ rpcUrl: config.rpcUrl });
const agentAddress = account.address;

const trackedAssets = new Set(config.watchAssets);
let lastCheckedBlock = config.startBlock;
let lastProposalCheckedBlock = config.startBlock;
let lastNativeBalance;
let ogContext;
const proposalsByHash = new Map();

async function loadAgentModule() {
    const modulePath = config.agentModule ?? 'agent-library/agents/default/agent.js';
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

    return { agentModule, commitmentText, resolvedPath };
}

const { agentModule, commitmentText } = await loadAgentModule();

async function decideOnSignals(signals) {
    if (!config.openAiApiKey) {
        return;
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
            return;
        }

        if (decision.toolCalls.length > 0) {
            const toolOutputs = await executeToolCalls({
                toolCalls: decision.toolCalls,
                publicClient,
                walletClient,
                account,
                config,
                ogContext,
            });
            if (decision.responseId && toolOutputs.length > 0) {
                const explanation = await explainToolCalls({
                    config,
                    previousResponseId: decision.responseId,
                    toolOutputs,
                });
                if (explanation) {
                    console.log('[agent] Agent explanation:', explanation);
                }
            }
            return;
        }

        if (decision?.textDecision) {
            console.log('[agent] Decision:', decision.textDecision);
        }
    } catch (error) {
        console.error('[agent] Agent call failed', error);
    }
}

async function agentLoop() {
    try {
        const { deposits, lastCheckedBlock: nextCheckedBlock, lastNativeBalance: nextNative } =
            await pollCommitmentChanges({
                publicClient,
                trackedAssets,
                commitmentSafe: config.commitmentSafe,
                watchNativeBalance: config.watchNativeBalance,
                lastCheckedBlock,
                lastNativeBalance,
            });
        lastCheckedBlock = nextCheckedBlock;
        lastNativeBalance = nextNative;

        const { newProposals, lastProposalCheckedBlock: nextProposalBlock } =
            await pollProposalChanges({
                publicClient,
                ogModule: config.ogModule,
                lastProposalCheckedBlock,
                proposalsByHash,
            });
        lastProposalCheckedBlock = nextProposalBlock;

        const combinedSignals = deposits.concat(
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

        if (combinedSignals.length > 0) {
            await decideOnSignals(combinedSignals);
        }

        await executeReadyProposals({
            publicClient,
            walletClient,
            account,
            ogModule: config.ogModule,
            proposalsByHash,
            executeRetryMs: config.executeRetryMs,
        });
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
