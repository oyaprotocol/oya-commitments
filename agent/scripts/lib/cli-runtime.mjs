import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAgentConfigStack } from '../../src/lib/agent-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, '../../..');

export function loadScriptEnv({ repoRootPath = repoRoot } = {}) {
    dotenv.config();
    dotenv.config({ path: path.resolve(repoRootPath, 'agent/.env') });
}

export function getArgValue(prefix, argv = process.argv) {
    const arg = argv.find((value) => value.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : null;
}

export function hasFlag(flag, argv = process.argv) {
    return argv.includes(flag);
}

export function resolveAgentRef({
    argv = process.argv,
    env = process.env,
    flag = '--module=',
    envKey = 'AGENT_MODULE',
    fallback = 'default',
} = {}) {
    return getArgValue(flag, argv) ?? env[envKey] ?? fallback;
}

export function normalizeAgentName(agentRef) {
    if (!agentRef) {
        return 'default';
    }
    if (!agentRef.includes('/')) {
        return agentRef;
    }
    const trimmed = agentRef.endsWith('.js') ? path.dirname(agentRef) : agentRef;
    return path.basename(trimmed);
}

export function resolveAgentDirectory(agentRef, { repoRootPath = repoRoot } = {}) {
    const agentName = normalizeAgentName(agentRef);
    const agentDir = agentRef.includes('/')
        ? agentRef.endsWith('.js')
            ? path.dirname(agentRef)
            : agentRef
        : `agent-library/agents/${agentName}`;
    return path.isAbsolute(agentDir) ? agentDir : path.resolve(repoRootPath, agentDir);
}

export function resolveAgentModulePath(agentRef, { repoRootPath = repoRoot } = {}) {
    const modulePath = agentRef.includes('/')
        ? agentRef
        : `agent-library/agents/${agentRef}/agent.js`;
    return path.isAbsolute(modulePath)
        ? modulePath
        : path.resolve(repoRootPath, modulePath);
}

export function resolveAgentFilePath(
    agentRef,
    filename,
    { repoRootPath = repoRoot } = {}
) {
    return path.join(resolveAgentDirectory(agentRef, { repoRootPath }), filename);
}

export async function loadAgentConfigForScript(
    agentRef,
    { repoRootPath = repoRoot, env = process.env, overlayPaths = [] } = {}
) {
    const configPath = resolveAgentFilePath(agentRef, 'config.json', { repoRootPath });
    const modulePath = resolveAgentModulePath(agentRef, { repoRootPath });
    const agentConfigStack = await loadAgentConfigStack(configPath, {
        env,
        overlayPaths,
    });
    return {
        agentName: normalizeAgentName(agentRef),
        agentDir: resolveAgentDirectory(agentRef, { repoRootPath }),
        modulePath,
        configPath,
        agentConfigStack,
    };
}

export function isDirectScriptExecution(importMetaUrl, argv = process.argv) {
    return Boolean(argv[1]) && importMetaUrl === pathToFileURL(argv[1]).href;
}
