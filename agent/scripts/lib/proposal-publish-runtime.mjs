import path from 'node:path';
import { createPublicClient, http } from 'viem';
import { buildConfig } from '../../src/lib/config.js';
import {
    createValidatedReadOnlyRuntime,
    createValidatedReadWriteRuntime,
} from '../../src/lib/chain-runtime.js';
import { resolveAgentRuntimeConfig, resolveConfiguredChainId } from '../../src/lib/agent-config.js';
import { createSignerClient } from '../../src/lib/signer.js';
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

function normalizeBaseUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('base URL must be a non-empty string.');
    }
    return value.trim().replace(/\/+$/, '');
}

function formatBaseUrl({ scheme, host, port, pathname = '', search = '' }) {
    const authorityHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const normalizedPath = pathname && pathname !== '/' ? pathname.replace(/\/+$/, '') : '';
    return `${scheme}://${authorityHost}:${port}${normalizedPath}${search}`;
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

async function resolveProposalPublishApiConfigForAgent({
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
        hasProposalPublishApiConfig: Boolean(runtimeConfig.agentConfig?.proposalPublishApi),
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

function buildUnsupportedChainError(message) {
    const error = new Error(message);
    error.code = 'unsupported_chain';
    error.statusCode = 400;
    return error;
}

function normalizeProposalRuntimeResolutionError(error, { agentRef, chainId }) {
    if (error?.code && error?.statusCode) {
        return error;
    }

    const message = String(error?.message ?? error);
    if (message.includes('conflicting chainId')) {
        return buildUnsupportedChainError(
            `Agent "${agentRef}" does not support proposal submission for chainId ${chainId}. ${message}`
        );
    }

    return error;
}

async function createProposalPublishSubmissionRuntimeResolver({
    agentRef,
    env = process.env,
    repoRootPath = repoRoot,
    argv = process.argv,
    overlayPaths = undefined,
    createPublicClientFn = createPublicClient,
    createSignerClientFn = createSignerClient,
} = {}) {
    const resolvedOverlayPaths =
        overlayPaths === undefined ? resolveExplicitOverlayPaths({ argv }) : overlayPaths;
    const explicitChainIdRaw = getArgValue('--chain-id=', argv);
    const explicitChainId =
        explicitChainIdRaw === null ? undefined : parseInteger(explicitChainIdRaw, 'chainId');
    const cache = new Map();
    const serverRuntimeConfig = await resolveProposalPublishApiConfigForAgent({
        agentRef,
        chainId: explicitChainId,
        repoRootPath,
        env,
        overlayPaths: resolvedOverlayPaths,
        argv,
        allowAmbiguousChainId: explicitChainId === undefined,
    });
    const servedChainIds = listServedChainIds(
        serverRuntimeConfig,
        serverRuntimeConfig.agentConfigStack
    );

    return async function resolveProposalSubmissionRuntime({ chainId }) {
        const normalizedChainId = normalizeChainIdValue(chainId);
        if (
            servedChainIds.length > 0 &&
            !servedChainIds.includes(normalizedChainId)
        ) {
            throw buildUnsupportedChainError(
                `Agent "${agentRef}" does not support proposal submission for chainId ${normalizedChainId}. Supported chainIds: ${servedChainIds.join(', ')}.`
            );
        }
        if (!cache.has(normalizedChainId)) {
            cache.set(
                normalizedChainId,
                (async () => {
                    let runtimeConfig;
                    try {
                        runtimeConfig = await resolveProposalPublishApiConfigForAgent({
                            agentRef,
                            chainId: normalizedChainId,
                            repoRootPath,
                            env,
                            overlayPaths: resolvedOverlayPaths,
                            argv,
                        });
                    } catch (error) {
                        throw normalizeProposalRuntimeResolutionError(error, {
                            agentRef,
                            chainId: normalizedChainId,
                        });
                    }

                    if (!runtimeConfig.proposalPublishApiEnabled) {
                        throw buildUnsupportedChainError(
                            `Agent "${agentRef}" does not enable proposalPublishApi for chainId ${normalizedChainId}.`
                        );
                    }
                    if (runtimeConfig.proposalPublishApiMode !== 'propose') {
                        throw buildUnsupportedChainError(
                            `Agent "${agentRef}" is not configured for propose mode on chainId ${normalizedChainId}.`
                        );
                    }
                    if (!runtimeConfig.proposeEnabled) {
                        throw buildUnsupportedChainError(
                            `Agent "${agentRef}" does not enable proposing on chainId ${normalizedChainId}.`
                        );
                    }
                    if (!runtimeConfig.rpcUrl) {
                        throw buildUnsupportedChainError(
                            `Agent "${agentRef}" does not define rpcUrl for chainId ${normalizedChainId}.`
                        );
                    }

                    const { publicClient, account, walletClient } =
                        await createValidatedReadWriteRuntime({
                            rpcUrl: runtimeConfig.rpcUrl,
                            expectedChainId: normalizedChainId,
                            buildError: buildUnsupportedChainError,
                            createPublicClientFn,
                            createSignerClientFn,
                            httpTransportFn: http,
                        });

                    return {
                        runtimeConfig,
                        publicClient,
                        walletClient,
                        account,
                    };
                })()
            );
        }

        try {
            return await cache.get(normalizedChainId);
        } catch (error) {
            cache.delete(normalizedChainId);
            throw error;
        }
    };
}

async function createProposalPublishVerificationRuntimeResolver({
    agentRef,
    env = process.env,
    repoRootPath = repoRoot,
    argv = process.argv,
    overlayPaths = undefined,
    createPublicClientFn = createPublicClient,
} = {}) {
    const resolvedOverlayPaths =
        overlayPaths === undefined ? resolveExplicitOverlayPaths({ argv }) : overlayPaths;
    const explicitChainIdRaw = getArgValue('--chain-id=', argv);
    const explicitChainId =
        explicitChainIdRaw === null ? undefined : parseInteger(explicitChainIdRaw, 'chainId');
    const cache = new Map();
    const serverRuntimeConfig = await resolveProposalPublishApiConfigForAgent({
        agentRef,
        chainId: explicitChainId,
        repoRootPath,
        env,
        overlayPaths: resolvedOverlayPaths,
        argv,
        allowAmbiguousChainId: explicitChainId === undefined,
    });
    const servedChainIds = listServedChainIds(
        serverRuntimeConfig,
        serverRuntimeConfig.agentConfigStack
    );

    return async function resolveProposalVerificationRuntime({ chainId }) {
        const normalizedChainId = normalizeChainIdValue(chainId);
        if (
            servedChainIds.length > 0 &&
            !servedChainIds.includes(normalizedChainId)
        ) {
            throw buildUnsupportedChainError(
                `Agent "${agentRef}" does not support proposal verification for chainId ${normalizedChainId}. Supported chainIds: ${servedChainIds.join(', ')}.`
            );
        }
        if (!cache.has(normalizedChainId)) {
            cache.set(
                normalizedChainId,
                (async () => {
                    let runtimeConfig;
                    try {
                        runtimeConfig = await resolveProposalPublishApiConfigForAgent({
                            agentRef,
                            chainId: normalizedChainId,
                            repoRootPath,
                            env,
                            overlayPaths: resolvedOverlayPaths,
                            argv,
                        });
                    } catch (error) {
                        throw normalizeProposalRuntimeResolutionError(error, {
                            agentRef,
                            chainId: normalizedChainId,
                        });
                    }

                    if (!runtimeConfig.proposalPublishApiEnabled) {
                        throw buildUnsupportedChainError(
                            `Agent "${agentRef}" does not enable proposalPublishApi for chainId ${normalizedChainId}.`
                        );
                    }
                    if (!runtimeConfig.rpcUrl) {
                        throw buildUnsupportedChainError(
                            `Agent "${agentRef}" does not define rpcUrl for chainId ${normalizedChainId}.`
                        );
                    }

                    const { publicClient } = await createValidatedReadOnlyRuntime({
                        rpcUrl: runtimeConfig.rpcUrl,
                        expectedChainId: normalizedChainId,
                        buildError: buildUnsupportedChainError,
                        createPublicClientFn,
                        httpTransportFn: http,
                    });

                    return {
                        runtimeConfig,
                        publicClient,
                    };
                })()
            );
        }

        try {
            return await cache.get(normalizedChainId);
        } catch (error) {
            cache.delete(normalizedChainId);
            throw error;
        }
    };
}

async function resolveProposalPublishApiTarget({
    argv = process.argv,
    env = process.env,
    repoRootPath = repoRoot,
    overlayPaths = resolveExplicitOverlayPaths({ argv }),
} = {}) {
    const explicit = getArgValue('--url=', argv);
    const explicitChainIdRaw = getArgValue('--chain-id=', argv);
    const explicitChainId =
        explicitChainIdRaw === null ? undefined : parseInteger(explicitChainIdRaw, 'chainId');
    if (explicit) {
        const configuredAgentRef = getArgValue('--module=', argv) ?? env.AGENT_MODULE ?? null;
        if (!configuredAgentRef) {
            if (explicitChainId !== undefined) {
                return {
                    baseUrl: normalizeBaseUrl(explicit),
                    chainId: explicitChainId,
                };
            }
            throw new Error(
                '--url requires --chain-id or --module so the target chain can be inferred for chain-bound proposal publication.'
            );
        }

        try {
            const runtimeConfig = await resolveProposalPublishApiConfigForAgent({
                agentRef: configuredAgentRef,
                chainId: explicitChainId,
                repoRootPath,
                env,
                overlayPaths,
                argv,
            });
            if (runtimeConfig.chainId === undefined) {
                throw new Error('resolved module config does not define chainId.');
            }
            return {
                baseUrl: normalizeBaseUrl(explicit),
                chainId: runtimeConfig.chainId,
            };
        } catch (error) {
            throw new Error(
                `Unable to infer chainId for explicit --url from module "${configuredAgentRef}". Pass --chain-id explicitly or fix the module config. ${error?.message ?? error}`
            );
        }
    }

    const explicitHost = getArgValue('--host=', argv);
    const explicitPortRaw = getArgValue('--port=', argv);
    const explicitPort =
        explicitPortRaw === null ? undefined : parseInteger(explicitPortRaw, 'port');
    const explicitScheme = getArgValue('--scheme=', argv);
    const hasExplicitEndpointOverride = explicitHost !== null || explicitPort !== undefined;
    const hasExplicitBaseOverride =
        hasExplicitEndpointOverride || explicitScheme !== null;
    const configuredAgentRef = getArgValue('--module=', argv) ?? env.AGENT_MODULE ?? null;

    if (hasExplicitBaseOverride && explicitChainId === undefined && !configuredAgentRef) {
        throw new Error(
            '--host/--port/--scheme require --chain-id or --module so the target chain can be inferred for chain-bound proposal publication.'
        );
    }

    const agentRef = resolveAgentRef({ argv, env });
    const runtimeConfig = await resolveProposalPublishApiConfigForAgent({
        agentRef,
        chainId: explicitChainId,
        repoRootPath,
        env,
        overlayPaths,
        argv,
    });

    if (hasExplicitBaseOverride && runtimeConfig.chainId === undefined) {
        throw new Error(
            `Unable to infer chainId for host/port override mode from module "${agentRef}". Pass --chain-id explicitly or fix the module config.`
        );
    }
    if (!runtimeConfig.proposalPublishApiEnabled && !hasExplicitEndpointOverride) {
        throw new Error(
            `Agent "${agentRef}" does not enable proposalPublishApi. Enable proposalPublishApi.enabled in the active config stack or pass --url, --host, or --port explicitly.`
        );
    }

    return {
        baseUrl: formatBaseUrl({
            scheme: explicitScheme ?? 'http',
            host: explicitHost ?? runtimeConfig.proposalPublishApiHost,
            port: explicitPort ?? runtimeConfig.proposalPublishApiPort,
        }),
        chainId: runtimeConfig.chainId,
    };
}

async function buildProposalPublishBaseUrl({
    argv = process.argv,
    env = process.env,
    repoRootPath = repoRoot,
    overlayPaths = resolveExplicitOverlayPaths({ argv }),
} = {}) {
    const target = await resolveProposalPublishApiTarget({
        argv,
        env,
        repoRootPath,
        overlayPaths,
    });
    return target.baseUrl;
}

function sanitizeStatePathSegment(value) {
    return String(value)
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
}

function resolveProposalPublishStateFile({
    runtimeConfig,
    agentRef,
    repoRootPath = repoRoot,
}) {
    const configured = runtimeConfig.proposalPublishApiStateFile;
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
        'proposal-publications',
        `${agentName}-chain-${sanitizeStatePathSegment(chainSegment) || 'unknown'}.json`
    );
}

async function resolveProposalPublishServerConfig({
    argv = process.argv,
    env = process.env,
    repoRootPath = repoRoot,
    overlayPaths = resolveExplicitOverlayPaths({ argv }),
} = {}) {
    const agentRef = resolveAgentRef({ argv, env });
    const explicitChainIdRaw = getArgValue('--chain-id=', argv);
    const explicitChainId =
        explicitChainIdRaw === null ? undefined : parseInteger(explicitChainIdRaw, 'chainId');
    const runtimeConfig = await resolveProposalPublishApiConfigForAgent({
        agentRef,
        chainId: explicitChainId,
        repoRootPath,
        env,
        overlayPaths,
        argv,
        allowAmbiguousChainId: true,
    });
    const supportedChainIds = listServedChainIds(runtimeConfig, runtimeConfig.agentConfigStack);
    if (runtimeConfig.proposalPublishApiMode === 'propose') {
        const proposeCapableChains = [];
        for (const chainId of supportedChainIds) {
            const chainRuntimeConfig = await resolveProposalPublishApiConfigForAgent({
                agentRef,
                chainId,
                repoRootPath,
                env,
                overlayPaths,
                argv,
            });
            if (
                chainRuntimeConfig.proposalPublishApiEnabled &&
                chainRuntimeConfig.proposalPublishApiMode === 'propose' &&
                chainRuntimeConfig.proposeEnabled &&
                chainRuntimeConfig.rpcUrl
            ) {
                proposeCapableChains.push(chainId);
            }
        }
        if (proposeCapableChains.length === 0) {
            throw new Error(
                `Agent "${agentRef}" enables proposalPublishApi.mode="propose" but does not resolve any propose-capable chain runtime. Configure at least one chain with proposal publishing enabled, proposeEnabled=true, and rpcUrl.`
            );
        }
    }

    return {
        agentRef,
        stateFile: resolveProposalPublishStateFile({
            runtimeConfig,
            agentRef,
            repoRootPath,
        }),
        runtimeConfig,
        supportedChainIds,
    };
}

export {
    buildProposalPublishBaseUrl,
    createProposalPublishSubmissionRuntimeResolver,
    createProposalPublishVerificationRuntimeResolver,
    resolveProposalPublishApiConfigForAgent,
    resolveProposalPublishApiTarget,
    resolveProposalPublishServerConfig,
    resolveProposalPublishStateFile,
};
