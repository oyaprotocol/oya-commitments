import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import {
    loadAgentConfigStack,
    resolveAgentRuntimeConfig,
    resolveConfiguredChainId,
} from './agent-config.js';
import { assertNoDeprecatedConfigEnvVars, buildConfig } from './config.js';
import {
    validateMessageApiDecisionEngine,
} from './decision-support.js';
import { createMessageInbox } from './message-inbox.js';
import { createSignerClient } from './signer.js';
import { createValidatedReadWriteRuntime } from './chain-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

function normalizeAgentModuleName(agentRef) {
    if (!agentRef) {
        return 'default';
    }
    if (!agentRef.includes('/')) {
        return agentRef;
    }
    const trimmed = agentRef.endsWith('.js') ? path.dirname(agentRef) : agentRef;
    return path.basename(trimmed);
}

function loadRuntimeEnv() {
    dotenv.config();
    dotenv.config({ path: path.resolve(repoRoot, 'agent/.env') });
}

async function loadAgentModule({ agentModuleRef }) {
    const modulePath = agentModuleRef.includes('/')
        ? agentModuleRef
        : `agent-library/agents/${agentModuleRef}/agent.js`;
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
    const agentConfigFile = await loadAgentConfigStack(agentConfigPath);

    return {
        agentModule,
        commitmentText,
        agentConfigFile,
    };
}

function createRuntimeMessageInbox(config) {
    if (!config.messageApiEnabled) {
        return null;
    }
    return createMessageInbox({
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

function resolvePollingOptions({ agentModule, commitmentText }) {
    if (typeof agentModule?.getPollingOptions !== 'function') {
        return {};
    }
    try {
        return agentModule.getPollingOptions({ commitmentText }) ?? {};
    } catch (error) {
        console.warn('[agent] getPollingOptions() failed; using defaults.');
        return {};
    }
}

export async function initializeAgentRuntime({
    loadRuntimeEnvFn = loadRuntimeEnv,
    buildConfigFn = buildConfig,
    assertNoDeprecatedConfigEnvVarsFn = assertNoDeprecatedConfigEnvVars,
    loadAgentModuleFn = loadAgentModule,
    createPublicClientFn = createPublicClient,
    createSignerClientFn = createSignerClient,
    httpTransportFn = http,
    validateMessageApiDecisionEngineFn = validateMessageApiDecisionEngine,
} = {}) {
    loadRuntimeEnvFn();

    const config = buildConfigFn();
    const agentRef = config.agentModule ?? 'default';
    assertNoDeprecatedConfigEnvVarsFn({
        env: process.env,
        agentModuleName: normalizeAgentModuleName(agentRef),
    });

    const { agentModule, commitmentText, agentConfigFile } = await loadAgentModuleFn({
        agentModuleRef: agentRef,
    });
    const provisionalConfig = resolveAgentRuntimeConfig({
        baseConfig: config,
        agentConfigFile,
        allowAmbiguousChainId: true,
    });
    const provisionalPublicClient = createPublicClientFn({
        transport: httpTransportFn(provisionalConfig.rpcUrl),
    });
    const runtimeChainId = await provisionalPublicClient.getChainId();
    resolveConfiguredChainId({
        agentConfigFile,
        explicitChainId: runtimeChainId,
    });

    Object.assign(
        config,
        resolveAgentRuntimeConfig({
            baseConfig: config,
            agentConfigFile,
            chainId: runtimeChainId,
        })
    );
    const { publicClient, account, walletClient } = await createValidatedReadWriteRuntime({
        rpcUrl: config.rpcUrl,
        expectedChainId: runtimeChainId,
        publicClientLabel: 'Resolved runtime rpcUrl',
        signerClientLabel: 'Resolved runtime signer',
        createPublicClientFn,
        createSignerClientFn,
        httpTransportFn,
    });
    const agentAddress = account.address;

    if (!config.commitmentSafe) {
        throw new Error(
            'Missing commitmentSafe in the active agent config stack (config.json/config.local.json/overlay). Legacy COMMITMENT_SAFE env fallback has been removed; migrate it into module config.'
        );
    }
    if (!config.ogModule) {
        throw new Error(
            'Missing ogModule in the active agent config stack (config.json/config.local.json/overlay). Legacy OG_MODULE env fallback has been removed; migrate it into module config.'
        );
    }

    const trackedAssets = new Set(
        config.watchAssets.map((asset) => String(asset).toLowerCase())
    );
    const messageInbox = createRuntimeMessageInbox(config);
    validateMessageApiDecisionEngineFn({ config, agentModule });

    return {
        config,
        publicClient,
        account,
        walletClient,
        agentAddress,
        agentModule,
        commitmentText,
        trackedAssets,
        messageInbox,
        pollingOptions: resolvePollingOptions({ agentModule, commitmentText }),
    };
}
