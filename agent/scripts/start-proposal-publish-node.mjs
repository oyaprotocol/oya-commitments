import {
    hasFlag,
    isDirectScriptExecution,
    loadScriptEnv,
} from './lib/cli-runtime.mjs';
import { createProposalPublicationApiServer } from '../src/lib/proposal-publication-api.js';
import { createProposalPublicationStore } from '../src/lib/proposal-publication-store.js';
import { resolveProposalPublishServerConfig } from './lib/proposal-publish-runtime.mjs';

loadScriptEnv();

function printUsage() {
    console.log(`Usage:
  node agent/scripts/start-proposal-publish-node.mjs --module=<agent-ref> [options]

Options:
  --module=<agent-ref>                 Agent module whose config.json should supply proposalPublishApi settings
  --chain-id=<int>                     Optional assertion; must match the module config's selected chain when provided
  --overlay=<path>                     Optional extra config overlay file for script-side config resolution
  --overlay-paths=<a,b>                Optional comma-separated extra overlay files
  --dry-run                            Print resolved server config without starting
  --help                               Show this help
`);
}

async function main() {
    if (hasFlag('--help', process.argv) || hasFlag('-h', process.argv)) {
        printUsage();
        return;
    }

    const { agentRef, runtimeConfig, stateFile } = await resolveProposalPublishServerConfig();
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

    if (hasFlag('--dry-run', process.argv)) {
        console.log(
            JSON.stringify(
                {
                    agentRef,
                    host: runtimeConfig.proposalPublishApiHost,
                    port: runtimeConfig.proposalPublishApiPort,
                    chainId: runtimeConfig.chainId ?? null,
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
    const api = createProposalPublicationApiServer({
        config: runtimeConfig,
        store,
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

if (isDirectScriptExecution(import.meta.url)) {
    main().catch((error) => {
        console.error('[oya-node] start proposal publish node failed:', error?.message ?? error);
        process.exit(1);
    });
}

export { main };
