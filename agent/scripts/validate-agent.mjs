import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function getArgValue(prefix) {
    const arg = process.argv.find((value) => value.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : null;
}

async function main() {
    const moduleArg = getArgValue('--module=');
    const modulePath =
        moduleArg ?? process.env.AGENT_MODULE ?? 'agent-library/agents/default/agent.js';
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, '../..');
    const resolvedPath = path.isAbsolute(modulePath)
        ? modulePath
        : path.resolve(repoRoot, modulePath);

    const agentModule = await import(pathToFileURL(resolvedPath).href);
    if (typeof agentModule.getSystemPrompt !== 'function') {
        throw new Error('Agent module must export getSystemPrompt().');
    }

    const commitmentPath = path.join(path.dirname(resolvedPath), 'commitment.txt');
    const commitmentText = (await readFile(commitmentPath, 'utf8')).trim();
    if (!commitmentText) {
        throw new Error('commitment.txt is missing or empty.');
    }

    const prompt = agentModule.getSystemPrompt({
        proposeEnabled: true,
        disputeEnabled: true,
        commitmentText,
    });
    if (!prompt || typeof prompt !== 'string') {
        throw new Error('getSystemPrompt() must return a non-empty string.');
    }

    console.log('[agent] Agent module OK:', resolvedPath);
    console.log('[agent] commitment.txt length:', commitmentText.length);
}

main().catch((error) => {
    console.error('[agent] validation failed:', error.message ?? error);
    process.exit(1);
});
