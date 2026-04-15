import { pathToFileURL } from 'node:url';
import {
    createValidatedReadWriteRuntime,
    createMessagePublicationStore,
    executeToolCalls,
    loadOgContext,
    pollProposalChanges,
} from './lib/control-node-runtime.mjs';
import {
    getArgValue,
    hasFlag,
    loadScriptEnv,
} from './lib/cli-runtime.mjs';
import {
    resolveMessagePublishServerConfig,
} from './lib/message-publish-runtime.mjs';

loadScriptEnv();

function parseInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function resolveUsageScriptPath(argv = process.argv) {
    return argv[1] || 'node/scripts/start-control-node.mjs';
}

function printUsage({ argv = process.argv } = {}) {
    console.log(`Usage:
  node ${resolveUsageScriptPath(argv)} --module=<agent-ref> [options]

Options:
  --module=<agent-ref>                 Agent module whose config.json should supply messagePublishApi and runtime settings
  --chain-id=<int>                     Optional assertion; must match the active module chain when provided
  --overlay=<path>                     Optional extra config overlay file for script-side config resolution
  --overlay-paths=<a,b>                Optional comma-separated extra overlay files
  --dry-run                            Print resolved control-node config without starting
  --help                               Show this help

The control node requires a module export getNodeDeterministicToolCalls() and a configured messagePublishApi state file.
Modules that submit reimbursement proposals through the standalone proposal node also require proposalPublishApi.enabled=true and proposalPublishApi.mode="propose".
`);
}

function buildProposalSignal(proposal) {
    return {
        kind: 'proposal',
        proposalHash: proposal.proposalHash,
        assertionId: proposal.assertionId,
        proposer: proposal.proposer,
        challengeWindowEnds: proposal.challengeWindowEnds,
        transactions: proposal.transactions,
        rules: proposal.rules,
        explanation: proposal.explanation,
    };
}

function buildActiveProposalSignals(proposalsByHash) {
    return Array.from(proposalsByHash?.values?.() ?? []).map(buildProposalSignal);
}

async function resolveToolExecutionOgContext({
    toolCalls,
    publicClient,
    ogModule,
    cachedOgContext = null,
}) {
    if (!Array.isArray(toolCalls) || !toolCalls.some((call) => call?.name === 'dispute_assertion')) {
        return cachedOgContext;
    }
    if (cachedOgContext) {
        return cachedOgContext;
    }
    return loadOgContext({ publicClient, ogModule });
}

async function main({ argv = process.argv } = {}) {
    if (hasFlag('--help', argv) || hasFlag('-h', argv)) {
        printUsage({ argv });
        return;
    }

    const explicitChainIdRaw = getArgValue('--chain-id=', argv);
    if (explicitChainIdRaw !== null) {
        parseInteger(explicitChainIdRaw, 'chainId');
    }

    const { agentRef, runtimeConfig, stateFile: messagePublicationStateFile } =
        await resolveMessagePublishServerConfig({ argv });
    if (!runtimeConfig.messagePublishApiEnabled) {
        throw new Error(
            `Agent "${agentRef}" does not enable messagePublishApi. Enable messagePublishApi.enabled in the active config stack.`
        );
    }
    if (!runtimeConfig.rpcUrl) {
        throw new Error(`Agent "${agentRef}" must define rpcUrl for the control node.`);
    }
    if (!runtimeConfig.modulePath) {
        throw new Error(`Agent "${agentRef}" did not resolve a module path.`);
    }

    const agentModule = await import(pathToFileURL(runtimeConfig.modulePath).href);
    if (typeof agentModule.getNodeDeterministicToolCalls !== 'function') {
        throw new Error(
            `Agent module "${runtimeConfig.modulePath}" must export getNodeDeterministicToolCalls() for node control.`
        );
    }

    if (hasFlag('--dry-run', argv)) {
        console.log(
            JSON.stringify(
                {
                    agentRef,
                    chainId: runtimeConfig.chainId ?? null,
                    commitmentSafe: runtimeConfig.commitmentSafe ?? null,
                    ogModule: runtimeConfig.ogModule ?? null,
                    pollIntervalMs: runtimeConfig.pollIntervalMs,
                    messagePublicationStateFile,
                    modulePath: runtimeConfig.modulePath,
                    proposeEnabled: runtimeConfig.proposeEnabled,
                    disputeEnabled: runtimeConfig.disputeEnabled,
                    proposalPublishApiEnabled: runtimeConfig.proposalPublishApiEnabled,
                    proposalPublishApiHost: runtimeConfig.proposalPublishApiHost ?? null,
                    proposalPublishApiPort: runtimeConfig.proposalPublishApiPort ?? null,
                    proposalPublishApiMode: runtimeConfig.proposalPublishApiMode ?? null,
                },
                null,
                2
            )
        );
        return;
    }

    const { publicClient, walletClient, account } = await createValidatedReadWriteRuntime({
        rpcUrl: runtimeConfig.rpcUrl,
        expectedChainId: runtimeConfig.chainId,
        publicClientLabel: 'Control node rpcUrl',
        signerClientLabel: 'Control node signer',
    });
    const messagePublicationStore = createMessagePublicationStore({
        stateFile: messagePublicationStateFile,
    });

    let lastProposalCheckedBlock = runtimeConfig.startBlock;
    const proposalsByHash = new Map();
    let ogContext = null;
    let stopped = false;
    let loopTimer = null;

    async function handleToolOutput({ callId, name, output }) {
        if (typeof agentModule.onNodeToolOutput !== 'function') {
            return;
        }
        let parsedOutput;
        try {
            parsedOutput = JSON.parse(output);
        } catch {
            parsedOutput = { raw: output };
        }
        await agentModule.onNodeToolOutput({
            callId,
            name,
            parsedOutput,
            config: runtimeConfig,
            commitmentSafe: runtimeConfig.commitmentSafe,
        });
    }

    async function loop() {
        if (stopped) {
            return;
        }
        try {
            const {
                newProposals,
                executedProposals,
                deletedProposals,
                lastProposalCheckedBlock: nextProposalBlock,
            } = await pollProposalChanges({
                publicClient,
                ogModule: runtimeConfig.ogModule,
                lastProposalCheckedBlock,
                proposalsByHash,
                startBlock: runtimeConfig.startBlock,
                logChunkSize: runtimeConfig.logChunkSize,
            });
            lastProposalCheckedBlock = nextProposalBlock;

            if (typeof agentModule.onNodeProposalEvents === 'function') {
                agentModule.onNodeProposalEvents({
                    executedProposals,
                    deletedProposals,
                    config: runtimeConfig,
                });
            }

            const toolCalls = await agentModule.getNodeDeterministicToolCalls({
                signals: buildActiveProposalSignals(proposalsByHash),
                commitmentSafe: runtimeConfig.commitmentSafe,
                agentAddress: account.address,
                publicClient,
                config: runtimeConfig,
                messagePublicationStore,
                onchainPendingProposal: proposalsByHash.size > 0,
            });

            if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                ogContext = await resolveToolExecutionOgContext({
                    toolCalls,
                    publicClient,
                    ogModule: runtimeConfig.ogModule,
                    cachedOgContext: ogContext,
                });
                await executeToolCalls({
                    toolCalls,
                    publicClient,
                    walletClient,
                    account,
                    config: runtimeConfig,
                    ogContext,
                    onToolOutput: handleToolOutput,
                });
            }
        } catch (error) {
            console.error('[oya-node] control loop error:', error?.message ?? error);
        }

        loopTimer = setTimeout(loop, runtimeConfig.pollIntervalMs);
    }

    function stopAndExit(code) {
        if (stopped) {
            return;
        }
        stopped = true;
        if (loopTimer) {
            clearTimeout(loopTimer);
            loopTimer = null;
        }
        process.exit(code);
    }

    process.on('SIGINT', () => stopAndExit(0));
    process.on('SIGTERM', () => stopAndExit(0));

    console.log(
        `[oya-node] Control loop running for ${agentRef} on chain ${runtimeConfig.chainId}.`
    );
    await loop();
    await new Promise(() => {});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch((error) => {
        console.error('[oya-node] start control node failed:', error?.message ?? error);
        process.exit(1);
    });
}

export { buildActiveProposalSignals, main, resolveToolExecutionOgContext };
