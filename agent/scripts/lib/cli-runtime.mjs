import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAgentConfigStack, resolveConfiguredChainId } from '../../src/lib/agent-config.js';

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

function parseOverlayListValue(raw) {
    if (raw === undefined || raw === null) {
        return [];
    }
    return String(raw)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

function dedupeStringList(values) {
    return Array.from(new Set(values.filter(Boolean)));
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

export function resolveExplicitOverlayPaths({ argv = process.argv } = {}) {
    const singleOverlayPaths = argv
        .filter((value) => value.startsWith('--overlay='))
        .map((value) => value.slice('--overlay='.length).trim())
        .filter(Boolean);
    const multiOverlayPaths = [
        ...parseOverlayListValue(getArgValue('--overlay-paths=', argv)),
        ...parseOverlayListValue(getArgValue('--overlays=', argv)),
    ];
    return dedupeStringList([...singleOverlayPaths, ...multiOverlayPaths]);
}

export function sanitizeConfigSelectionEnv(env = process.env) {
    return {
        ...env,
        AGENT_CONFIG_OVERLAY_PATH: '',
        AGENT_CONFIG_OVERLAY_PATHS: '',
    };
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
    {
        repoRootPath = repoRoot,
        env = process.env,
        overlayPaths,
        allowAmbientOverlays = false,
        argv = process.argv,
    } = {}
) {
    const configPath = resolveAgentFilePath(agentRef, 'config.json', { repoRootPath });
    const modulePath = resolveAgentModulePath(agentRef, { repoRootPath });
    const resolvedOverlayPaths =
        overlayPaths === undefined ? resolveExplicitOverlayPaths({ argv }) : overlayPaths;
    const agentConfigStack = await loadAgentConfigStack(configPath, {
        env: allowAmbientOverlays ? env : sanitizeConfigSelectionEnv(env),
        overlayPaths: resolvedOverlayPaths,
    });
    return {
        agentName: normalizeAgentName(agentRef),
        agentDir: resolveAgentDirectory(agentRef, { repoRootPath }),
        modulePath,
        configPath,
        agentConfigStack,
    };
}

export async function resolveConfiguredChainIdForScript(
    agentRef,
    {
        repoRootPath = repoRoot,
        env = process.env,
        overlayPaths,
        allowAmbientOverlays = false,
        argv = process.argv,
        explicitChainId,
    } = {}
) {
    const { agentConfigStack } = await loadAgentConfigForScript(agentRef, {
        repoRootPath,
        env,
        overlayPaths,
        allowAmbientOverlays,
        argv,
    });
    return resolveConfiguredChainId({
        agentConfigFile: agentConfigStack,
        explicitChainId,
    });
}

export function isDirectScriptExecution(importMetaUrl, argv = process.argv) {
    return Boolean(argv[1]) && importMetaUrl === pathToFileURL(argv[1]).href;
}
