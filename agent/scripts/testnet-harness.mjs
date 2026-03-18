import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentConfigStack } from '../src/lib/agent-config.js';
import {
    ensureHarnessSession,
    readHarnessSessionStatus,
    resetHarnessSession,
    writeHarnessJson,
} from './lib/testnet-harness-session.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

dotenv.config();
dotenv.config({ path: path.resolve(repoRoot, 'agent/.env') });

function getArgValue(prefix, argv = process.argv) {
    const arg = argv.find((value) => value.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : null;
}

function printUsage() {
    console.log(`Usage:
  node agent/scripts/testnet-harness.mjs status --module=<agent-ref> --profile=<name>
  node agent/scripts/testnet-harness.mjs init --module=<agent-ref> --profile=<name>
  node agent/scripts/testnet-harness.mjs reset --module=<agent-ref> --profile=<name>

Phase 1 currently manages harness session state and config overlays only.
Later phases will add process supervision, seeding, and smoke execution.`);
}

function resolveCommand(argv = process.argv) {
    const command = argv[2];
    if (!command || command === '--help' || command === '-h') {
        return null;
    }
    return command;
}

function resolveAgentRef(argv = process.argv, env = process.env) {
    return getArgValue('--module=', argv) ?? env.AGENT_MODULE ?? 'default';
}

function resolveProfile(argv = process.argv) {
    return getArgValue('--profile=', argv) ?? 'default';
}

function resolveAgentModulePath(agentRef) {
    const modulePath = agentRef.includes('/')
        ? agentRef
        : `agent-library/agents/${agentRef}/agent.js`;
    return path.isAbsolute(modulePath)
        ? modulePath
        : path.resolve(repoRoot, modulePath);
}

async function resolveConfigSummary(agentRef, sessionOverlayPath) {
    const resolvedModulePath = resolveAgentModulePath(agentRef);
    const configPath = path.join(path.dirname(resolvedModulePath), 'config.json');
    const agentConfigStack = await loadAgentConfigStack(configPath, {
        overlayPaths: [sessionOverlayPath],
        env: process.env,
    });

    return {
        modulePath: resolvedModulePath,
        configPath,
        sourceLabel: agentConfigStack.sourceLabel,
        layers: agentConfigStack.layers.map((layer) => ({
            kind: layer.kind,
            path: layer.path,
            exists: layer.exists,
        })),
    };
}

async function handleStatus({ agentRef, profile }) {
    const sessionStatus = await readHarnessSessionStatus({
        repoRootPath: repoRoot,
        agentRef,
        profile,
    });
    const config = await resolveConfigSummary(agentRef, sessionStatus.files.overlay);

    console.log(
        JSON.stringify(
            {
                module: agentRef,
                profile,
                sessionDir: sessionStatus.sessionDir,
                exists: sessionStatus.exists,
                files: sessionStatus.fileStatuses,
                data: sessionStatus.data,
                config,
            },
            null,
            2
        )
    );
}

async function handleInit({ agentRef, profile }) {
    const sessionPaths = await ensureHarnessSession({
        repoRootPath: repoRoot,
        agentRef,
        profile,
    });
    const statusBefore = await readHarnessSessionStatus({
        repoRootPath: repoRoot,
        agentRef,
        profile,
    });
    if (!statusBefore.fileStatuses.overlay.exists) {
        await writeHarnessJson(sessionPaths.files.overlay, {});
    }
    await handleStatus({ agentRef, profile });
}

async function handleReset({ agentRef, profile }) {
    const sessionPaths = await resetHarnessSession({
        repoRootPath: repoRoot,
        agentRef,
        profile,
    });
    console.log(
        JSON.stringify(
            {
                module: agentRef,
                profile,
                reset: true,
                sessionDir: sessionPaths.sessionDir,
            },
            null,
            2
        )
    );
}

async function main() {
    const command = resolveCommand(process.argv);
    if (!command) {
        printUsage();
        return;
    }

    const agentRef = resolveAgentRef();
    const profile = resolveProfile();

    if (command === 'status') {
        await handleStatus({ agentRef, profile });
        return;
    }
    if (command === 'init') {
        await handleInit({ agentRef, profile });
        return;
    }
    if (command === 'reset') {
        await handleReset({ agentRef, profile });
        return;
    }

    throw new Error(`Unsupported command "${command}". Phase 1 supports: status, init, reset.`);
}

main().catch((error) => {
    console.error('[testnet-harness] failed:', error?.message ?? error);
    process.exit(1);
});
