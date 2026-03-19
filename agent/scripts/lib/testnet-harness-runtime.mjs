import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createDefaultRuntimeConfig } from '../../src/lib/config.js';
import { loadAgentConfigStack, resolveAgentRuntimeConfig } from '../../src/lib/agent-config.js';
import { resolveHarnessProfile } from './testnet-harness-profiles.mjs';

function createHarnessBaseConfig({ env = process.env } = {}) {
    return createDefaultRuntimeConfig({
        env: {},
        rpcUrl: env.RPC_URL ?? 'http://127.0.0.1:8545',
    });
}

function resolveAgentModulePath(repoRootPath, agentRef) {
    const modulePath = agentRef.includes('/')
        ? agentRef
        : `agent-library/agents/${agentRef}/agent.js`;
    return path.isAbsolute(modulePath)
        ? modulePath
        : path.resolve(repoRootPath, modulePath);
}

async function readCommitmentText(commitmentPath) {
    try {
        return (await readFile(commitmentPath, 'utf8')).trim();
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return '';
        }
        throw error;
    }
}

async function resolveHarnessRuntimeContext({
    repoRootPath,
    agentRef,
    profileName,
    overlayPath,
    env = process.env,
}) {
    const profile = resolveHarnessProfile(profileName, { env });
    const modulePath = resolveAgentModulePath(repoRootPath, agentRef);
    const moduleDir = path.dirname(modulePath);
    const configPath = path.join(moduleDir, 'config.json');
    const commitmentPath = path.join(moduleDir, 'commitment.txt');
    const configStack = await loadAgentConfigStack(configPath, {
        overlayPaths: overlayPath ? [overlayPath] : [],
        env,
    });
    const runtimeConfig = resolveAgentRuntimeConfig({
        baseConfig: {
            ...createHarnessBaseConfig({ env }),
            rpcUrl: env.RPC_URL ?? profile.rpcUrl ?? 'http://127.0.0.1:8545',
        },
        agentConfigFile: configStack,
        chainId: profile.chainId,
    });

    return {
        profile,
        modulePath,
        moduleDir,
        configPath,
        commitmentPath,
        commitmentText: await readCommitmentText(commitmentPath),
        configStack,
        runtimeConfig,
    };
}

export {
    createHarnessBaseConfig,
    readCommitmentText,
    resolveAgentModulePath,
    resolveHarnessRuntimeContext,
};
