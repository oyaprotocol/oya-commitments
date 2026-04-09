import path from 'node:path';
import { buildConfig } from '../../src/lib/config.js';
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
        baseConfig: {
            ...baseConfig,
            chainId: runtimeChainId,
        },
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

export {
    resolveMessagePublishApiConfigForAgent,
    resolveMessagePublishServerConfig,
    resolveMessagePublishStateFile,
};
