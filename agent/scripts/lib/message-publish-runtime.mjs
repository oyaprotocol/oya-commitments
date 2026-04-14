import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { buildConfig } from '../../src/lib/config.js';
import { createSignerClient } from '../../src/lib/signer.js';
import { normalizePrivateKey } from '../../src/lib/utils.js';
import { resolveAgentRuntimeConfig, resolveConfiguredChainId } from '../../src/lib/agent-config.js';
import {
    getArgValue,
    loadAgentConfigForScript,
    normalizeAgentName,
    repoRoot,
    resolveAgentRef,
    resolveExplicitOverlayPaths,
} from './cli-runtime.mjs';

function parseInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        throw new Error(`${label} must be an integer.`);
    }
    return parsed;
}

function normalizeChainIdValue(value, label = 'chainId') {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function overrideBaseConfigChainId(baseConfig, chainId) {
    return Object.create(
        Object.getPrototypeOf(baseConfig),
        {
            ...Object.getOwnPropertyDescriptors(baseConfig),
            chainId: {
                value: chainId,
                writable: true,
                enumerable: true,
                configurable: true,
            },
        }
    );
}

async function resolveMessagePublishApiConfigForAgent({
    agentRef,
    chainId,
    repoRootPath = repoRoot,
    env = process.env,
    overlayPaths,
    argv = process.argv,
    allowAmbiguousChainId = false,
}) {
    const {
        modulePath: resolvedModulePath,
        configPath: agentConfigPath,
        agentConfigStack,
        agentName,
    } = await loadAgentConfigForScript(agentRef, {
        repoRootPath,
        env,
        overlayPaths,
        argv,
    });
    let runtimeChainId;
    try {
        runtimeChainId = resolveConfiguredChainId({
            agentConfigFile: agentConfigStack,
            explicitChainId: chainId,
        });
    } catch (error) {
        if (
            allowAmbiguousChainId &&
            (chainId === undefined || chainId === null) &&
            String(error?.message ?? '').includes('defines multiple byChain entries')
        ) {
            runtimeChainId = undefined;
        } else {
            throw error;
        }
    }

    const baseConfig = buildConfig({
        env,
        requireRpcUrl: false,
        fallbackRpcUrl: undefined,
    });

    const runtimeConfig = resolveAgentRuntimeConfig({
        baseConfig: overrideBaseConfigChainId(baseConfig, runtimeChainId),
        agentConfigFile: agentConfigStack,
        chainId: runtimeChainId,
        allowAmbiguousChainId,
    });

    return {
        ...runtimeConfig,
        agentName,
        hasMessagePublishApiConfig: Boolean(runtimeConfig.agentConfig?.messagePublishApi),
        agentConfigStack,
        modulePath: resolvedModulePath,
        configPath: agentConfigPath,
    };
}

function listConfiguredChainIds(agentConfigStack) {
    const rawAgentConfig = agentConfigStack?.raw;
    if (!rawAgentConfig) {
        return [];
    }

    const configuredChainIds = [];
    if (rawAgentConfig.chainId !== undefined && rawAgentConfig.chainId !== null) {
        configuredChainIds.push(
            normalizeChainIdValue(rawAgentConfig.chainId, 'agent config chainId')
        );
    }

    if (rawAgentConfig.byChain && typeof rawAgentConfig.byChain === 'object' && !Array.isArray(rawAgentConfig.byChain)) {
        for (const key of Object.keys(rawAgentConfig.byChain)) {
            configuredChainIds.push(
                normalizeChainIdValue(key, 'agent config byChain key')
            );
        }
    }

    return Array.from(new Set(configuredChainIds));
}

function listServedChainIds(runtimeConfig, agentConfigStack) {
    if (runtimeConfig.chainId !== undefined && runtimeConfig.chainId !== null) {
        return [normalizeChainIdValue(runtimeConfig.chainId, 'resolved chainId')];
    }
    return listConfiguredChainIds(agentConfigStack);
}

function sanitizeStatePathSegment(value) {
    return String(value)
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
}

function resolveMessagePublishStateFile({
    runtimeConfig,
    agentRef,
    repoRootPath = repoRoot,
}) {
    const configured = runtimeConfig.messagePublishApiStateFile;
    if (typeof configured === 'string' && configured.trim()) {
        return path.isAbsolute(configured)
            ? configured
            : path.resolve(repoRootPath, configured.trim());
    }

    const agentName = sanitizeStatePathSegment(normalizeAgentName(agentRef)) || 'default';
    const chainSegment =
        runtimeConfig.chainId === undefined || runtimeConfig.chainId === null
            ? 'unknown'
            : String(runtimeConfig.chainId).trim();
    return path.join(
        repoRootPath,
        'agent',
        '.state',
        'message-publications',
        `${agentName}-chain-${sanitizeStatePathSegment(chainSegment) || 'unknown'}.json`
    );
}

async function resolveMessagePublishServerConfig({
    argv = process.argv,
    env = process.env,
    repoRootPath = repoRoot,
    overlayPaths = resolveExplicitOverlayPaths({ argv }),
} = {}) {
    const agentRef = resolveAgentRef({ argv, env });
    const explicitChainIdRaw = getArgValue('--chain-id=', argv);
    const explicitChainId =
        explicitChainIdRaw === null ? undefined : parseInteger(explicitChainIdRaw, 'chainId');
    const runtimeConfig = await resolveMessagePublishApiConfigForAgent({
        agentRef,
        chainId: explicitChainId,
        repoRootPath,
        env,
        overlayPaths,
        argv,
        allowAmbiguousChainId: true,
    });

    return {
        agentRef,
        stateFile: resolveMessagePublishStateFile({
            runtimeConfig,
            agentRef,
            repoRootPath,
        }),
        runtimeConfig,
        supportedChainIds: listServedChainIds(runtimeConfig, runtimeConfig.agentConfigStack),
    };
}

async function resolveMessagePublishNodeSigner({
    runtimeConfig,
    env = process.env,
} = {}) {
    const explicitPrivateKey = normalizePrivateKey(
        env.MESSAGE_PUBLISH_API_SIGNER_PRIVATE_KEY ?? env.MESSAGE_PUBLISH_SIGNER_PRIVATE_KEY
    );
    if (explicitPrivateKey) {
        const account = privateKeyToAccount(explicitPrivateKey);
        return {
            address: account.address,
            async signMessage(message) {
                return account.signMessage({ message });
            },
        };
    }

    const rpcUrl =
        runtimeConfig?.rpcUrl ??
        env.RPC_URL ??
        'http://127.0.0.1:8545';
    const { account, walletClient } = await createSignerClient({ rpcUrl });
    if (!walletClient || typeof walletClient.signMessage !== 'function') {
        throw new Error('Configured node signer does not support signMessage.');
    }
    return {
        address: account.address,
        async signMessage(message) {
            return walletClient.signMessage({
                account,
                message,
            });
        },
    };
}

async function resolveMessagePublishValidator({
    runtimeConfig,
} = {}) {
    const modulePath = runtimeConfig?.modulePath;
    if (!modulePath) {
        return undefined;
    }

    const agentModule = await import(pathToFileURL(modulePath).href);
    if (agentModule.validatePublishedMessage === undefined) {
        return undefined;
    }
    if (typeof agentModule.validatePublishedMessage !== 'function') {
        throw new Error(
            `Agent module "${modulePath}" export validatePublishedMessage must be a function when provided.`
        );
    }

    return (args) =>
        agentModule.validatePublishedMessage({
            ...args,
            config: runtimeConfig,
        });
}

async function resolveMessagePublishLockKeyDeriver({
    runtimeConfig,
} = {}) {
    const modulePath = runtimeConfig?.modulePath;
    if (!modulePath) {
        return undefined;
    }

    const agentModule = await import(pathToFileURL(modulePath).href);
    if (agentModule.derivePublishedMessageLockKeys === undefined) {
        return undefined;
    }
    if (typeof agentModule.derivePublishedMessageLockKeys !== 'function') {
        throw new Error(
            `Agent module "${modulePath}" export derivePublishedMessageLockKeys must be a function when provided.`
        );
    }

    return (args) =>
        agentModule.derivePublishedMessageLockKeys({
            ...args,
            config: runtimeConfig,
        });
}

export {
    resolveMessagePublishLockKeyDeriver,
    resolveMessagePublishApiConfigForAgent,
    resolveMessagePublishNodeSigner,
    resolveMessagePublishServerConfig,
    resolveMessagePublishStateFile,
    resolveMessagePublishValidator,
};
