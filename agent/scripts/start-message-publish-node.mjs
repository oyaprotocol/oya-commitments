import {
    hasFlag,
    isDirectScriptExecution,
    loadScriptEnv,
} from './lib/cli-runtime.mjs';
import { createMessagePublicationApiServer } from '../src/lib/message-publication-api.js';
import { createMessagePublicationStore } from '../src/lib/message-publication-store.js';
import {
    resolveMessagePublishNodeSigner,
    resolveMessagePublishServerConfig,
} from './lib/message-publish-runtime.mjs';

loadScriptEnv();

function printUsage() {
    console.log(`Usage:
  node agent/scripts/start-message-publish-node.mjs --module=<agent-ref> [options]

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

async function main() {
    if (hasFlag('--help', process.argv) || hasFlag('-h', process.argv)) {
        printUsage();
        return;
    }

    const { agentRef, runtimeConfig, stateFile, supportedChainIds } =
        await resolveMessagePublishServerConfig();
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

    if (hasFlag('--dry-run', process.argv)) {
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

if (isDirectScriptExecution(import.meta.url)) {
    main().catch((error) => {
        console.error('[oya-node] start message publish node failed:', error?.message ?? error);
        process.exit(1);
    });
}

export { main };
