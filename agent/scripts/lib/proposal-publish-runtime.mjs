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

async function resolveProposalPublishApiConfigForAgent({
    agentRef,
    chainId,
    repoRootPath = repoRoot,
    env = process.env,
    overlayPaths,
    argv = process.argv,
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
    const runtimeChainId = resolveConfiguredChainId({
        agentConfigFile: agentConfigStack,
        explicitChainId: chainId,
    });
    const baseConfig = buildConfig({
        env,
        requireRpcUrl: false,
        fallbackRpcUrl: 'http://127.0.0.1:8545',
    });

    const runtimeConfig = resolveAgentRuntimeConfig({
        baseConfig: {
            ...baseConfig,
            chainId: runtimeChainId,
        },
        agentConfigFile: agentConfigStack,
        chainId: runtimeChainId,
    });

    return {
        ...runtimeConfig,
        agentName,
        hasProposalPublishApiConfig: Boolean(runtimeConfig.agentConfig?.proposalPublishApi),
        modulePath: resolvedModulePath,
        configPath: agentConfigPath,
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
    const hasExplicitBaseOverride =
        explicitHost !== null || explicitPort !== undefined || explicitScheme !== null;
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
    });

    return {
        agentRef,
        stateFile: resolveProposalPublishStateFile({
            runtimeConfig,
            agentRef,
            repoRootPath,
        }),
        runtimeConfig,
    };
}

export {
    buildProposalPublishBaseUrl,
    resolveProposalPublishApiConfigForAgent,
    resolveProposalPublishApiTarget,
    resolveProposalPublishServerConfig,
    resolveProposalPublishStateFile,
};
