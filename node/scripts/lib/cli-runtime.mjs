import { importAgentModule } from './shared-agent-import.mjs';

const {
    getArgValue,
    hasFlag,
    isDirectScriptExecution,
    loadAgentConfigForScript,
    loadScriptEnv,
    normalizeAgentName,
    repoRoot,
    resolveAgentDirectory,
    resolveAgentFilePath,
    resolveAgentModulePath,
    resolveAgentRef,
    resolveConfiguredChainIdForScript,
    resolveExplicitOverlayPaths,
    sanitizeConfigSelectionEnv,
} = await importAgentModule(
    new URL('../../../agent/scripts/lib/cli-runtime.mjs', import.meta.url).href,
    'scripts/lib/cli-runtime.mjs'
);

export {
    getArgValue,
    hasFlag,
    isDirectScriptExecution,
    loadAgentConfigForScript,
    loadScriptEnv,
    normalizeAgentName,
    repoRoot,
    resolveAgentDirectory,
    resolveAgentFilePath,
    resolveAgentModulePath,
    resolveAgentRef,
    resolveConfiguredChainIdForScript,
    resolveExplicitOverlayPaths,
    sanitizeConfigSelectionEnv,
};
