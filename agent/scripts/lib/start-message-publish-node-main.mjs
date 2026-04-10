import path from 'node:path';
import { createMessagePublicationApiServer } from '../../src/lib/message-publication-api.js';
import { createMessagePublicationStore } from '../../src/lib/message-publication-store.js';
import {
    hasFlag,
    loadScriptEnv,
} from './cli-runtime.mjs';
import {
    resolveMessagePublishNodeSigner,
    resolveMessagePublishServerConfig,
} from './message-publish-runtime.mjs';

loadScriptEnv();

function resolveUsageScriptPath(argv = process.argv) {
    if (!argv[1]) {
        return 'node/scripts/start-message-publish-node.mjs';
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
  --module=<agent-ref>                 Agent module whose config.json should supply messagePublishApi settings
  --chain-id=<int>                     Optional assertion; must match the module config's selected chain when provided
  --overlay=<path>                     Optional extra config overlay file for script-side config resolution
  --overlay-paths=<a,b>                Optional comma-separated extra overlay files
  signer env                           Use MESSAGE_PUBLISH_API_SIGNER_PRIVATE_KEY for an explicit key
                                       Or fall back to the shared SIGNER_TYPE-based signer config
  --dry-run                            Print resolved server config and supported chains without starting
  --help                               Show this help
`);
}

async function main({ argv = process.argv } = {}) {
    if (hasFlag('--help', argv) || hasFlag('-h', argv)) {
        printUsage({ argv });
        return;
    }

    const { agentRef, runtimeConfig, stateFile, supportedChainIds } =
        await resolveMessagePublishServerConfig({ argv });
    if (!runtimeConfig.messagePublishApiEnabled) {
        throw new Error(
            `Agent "${agentRef}" does not enable messagePublishApi. Enable messagePublishApi.enabled in the active config stack.`
        );
    }
    if (!runtimeConfig.ipfsEnabled) {
        throw new Error(
            `Agent "${agentRef}" must enable ipfsEnabled=true for signed message publication.`
        );
    }

    if (hasFlag('--dry-run', argv)) {
        console.log(
            JSON.stringify(
                {
                    agentRef,
                    host: runtimeConfig.messagePublishApiHost,
                    port: runtimeConfig.messagePublishApiPort,
                    chainId: runtimeConfig.chainId ?? null,
                    supportedChainIds,
                    stateFile,
                    ipfsApiUrl: runtimeConfig.ipfsApiUrl,
                    nodeName: runtimeConfig.messagePublishApiNodeName ?? null,
                },
                null,
                2
            )
        );
        return;
    }

    const store = createMessagePublicationStore({ stateFile });
    const nodeSigner = await resolveMessagePublishNodeSigner({
        runtimeConfig,
    });
    const api = createMessagePublicationApiServer({
        config: runtimeConfig,
        store,
        nodeSigner,
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
