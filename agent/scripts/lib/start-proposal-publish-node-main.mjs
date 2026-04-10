import path from 'node:path';
import { createProposalPublicationApiServer } from '../../src/lib/proposal-publication-api.js';
import { createProposalPublicationStore } from '../../src/lib/proposal-publication-store.js';
import {
    hasFlag,
    loadScriptEnv,
} from './cli-runtime.mjs';
import {
    createProposalPublishSubmissionRuntimeResolver,
    resolveProposalPublishServerConfig,
} from './proposal-publish-runtime.mjs';

loadScriptEnv();

function resolveUsageScriptPath(argv = process.argv) {
    if (!argv[1]) {
        return 'node/scripts/start-proposal-publish-node.mjs';
    }

    const relativePath = path.relative(process.cwd(), argv[1]);
    if (relativePath && !relativePath.startsWith('..')) {
        return relativePath;
    }
    return argv[1];
}

function printUsage({ argv = process.argv } = {}) {
    console.log(`Usage:
  node ${resolveUsageScriptPath(argv)} --module=<agent-ref> [options]

Options:
  --module=<agent-ref>                 Agent module whose config.json should supply proposalPublishApi settings
  --chain-id=<int>                     Optional assertion; must match the module config's selected chain when provided
  --overlay=<path>                     Optional extra config overlay file for script-side config resolution
  --overlay-paths=<a,b>                Optional comma-separated extra overlay files
  --dry-run                            Print resolved server config, mode, and supported chains without starting
  --help                               Show this help

The node mode comes from proposalPublishApi.mode in the active config stack:
  publish  -> archive and pin only
  propose  -> archive, pin, then propose onchain for the signed request chainId
`);
}

async function main({ argv = process.argv } = {}) {
    if (hasFlag('--help', argv) || hasFlag('-h', argv)) {
        printUsage({ argv });
        return;
    }

    const { agentRef, runtimeConfig, stateFile, supportedChainIds } =
        await resolveProposalPublishServerConfig({ argv });
    if (!runtimeConfig.proposalPublishApiEnabled) {
        throw new Error(
            `Agent "${agentRef}" does not enable proposalPublishApi. Enable proposalPublishApi.enabled in the active config stack.`
        );
    }
    if (!runtimeConfig.ipfsEnabled) {
        throw new Error(
            `Agent "${agentRef}" must enable ipfsEnabled=true for proposal publication.`
        );
    }

    if (hasFlag('--dry-run', argv)) {
        console.log(
            JSON.stringify(
                {
                    agentRef,
                    host: runtimeConfig.proposalPublishApiHost,
                    port: runtimeConfig.proposalPublishApiPort,
                    mode: runtimeConfig.proposalPublishApiMode,
                    chainId: runtimeConfig.chainId ?? null,
                    supportedChainIds,
                    stateFile,
                    ipfsApiUrl: runtimeConfig.ipfsApiUrl,
                    nodeName: runtimeConfig.proposalPublishApiNodeName ?? null,
                },
                null,
                2
            )
        );
        return;
    }

    const store = createProposalPublicationStore({ stateFile });
    const resolveProposalRuntime =
        runtimeConfig.proposalPublishApiMode === 'propose'
            ? await createProposalPublishSubmissionRuntimeResolver({
                  agentRef,
                  argv,
              })
            : undefined;
    const api = createProposalPublicationApiServer({
        config: runtimeConfig,
        store,
        resolveProposalRuntime,
    });
    await api.start();

    let stopping = false;
    async function stopAndExit(code) {
        if (stopping) {
            return;
        }
        stopping = true;
        try {
            await api.stop();
        } finally {
            process.exit(code);
        }
    }

    process.on('SIGINT', () => {
        void stopAndExit(0);
    });
    process.on('SIGTERM', () => {
        void stopAndExit(0);
    });

    await new Promise(() => {});
}

export { main };
