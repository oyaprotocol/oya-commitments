import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    getArgValue,
    loadScriptEnv,
    repoRoot,
    resolveAgentModulePath,
    resolveAgentRef,
} from './lib/cli-runtime.mjs';

loadScriptEnv();

async function main() {
    const moduleArg = getArgValue('--module=');
    const agentRef = moduleArg ?? resolveAgentRef();
    const resolvedPath = resolveAgentModulePath(agentRef, { repoRootPath: repoRoot });

    const agentModule = await import(pathToFileURL(resolvedPath).href);
    const hasSystemPrompt = typeof agentModule.getSystemPrompt === 'function';
    const hasDeterministicToolCalls =
        typeof agentModule.getDeterministicToolCalls === 'function';
    if (!hasSystemPrompt && !hasDeterministicToolCalls) {
        throw new Error(
            'Agent module must export at least one decision entrypoint: getSystemPrompt() or getDeterministicToolCalls().'
        );
    }

    const commitmentPath = path.join(path.dirname(resolvedPath), 'commitment.txt');
    const commitmentText = (await readFile(commitmentPath, 'utf8')).trim();
    if (!commitmentText) {
        throw new Error('commitment.txt is missing or empty.');
    }

    if (hasSystemPrompt) {
        const prompt = agentModule.getSystemPrompt({
            proposeEnabled: true,
            disputeEnabled: true,
            commitmentText,
        });
        if (!prompt || typeof prompt !== 'string') {
            throw new Error('getSystemPrompt() must return a non-empty string.');
        }
    }

    console.log('[agent] Agent module OK:', resolvedPath);
    console.log('[agent] commitment.txt length:', commitmentText.length);
}

main().catch((error) => {
    console.error('[agent] validation failed:', error.message ?? error);
    process.exit(1);
});
