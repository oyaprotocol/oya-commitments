import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentConfigStack } from '../src/lib/agent-config.js';
import {
    ensureHarnessSession,
    readHarnessJson,
    readHarnessSessionStatus,
    resetHarnessSession,
    writeHarnessJson,
} from './lib/testnet-harness-session.mjs';
import {
    getAnvilRuntimeStatus,
    startHarnessAnvil,
    stopHarnessAnvil,
} from './lib/testnet-harness-anvil.mjs';
import { listHarnessProfiles, resolveHarnessProfile } from './lib/testnet-harness-profiles.mjs';
import { deriveHarnessRoles } from './lib/testnet-harness-roles.mjs';

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
    const profiles = listHarnessProfiles()
        .map((profile) => {
            const suffix = profile.forkRpcEnv ? ` (${profile.forkRpcEnv})` : '';
            return `${profile.name}${suffix}`;
        })
        .join(', ');
    console.log(`Usage:
  node agent/scripts/testnet-harness.mjs init --module=<agent-ref> --profile=<name>
  node agent/scripts/testnet-harness.mjs up --module=<agent-ref> --profile=<name> [--port=<int>]
  node agent/scripts/testnet-harness.mjs status --module=<agent-ref> --profile=<name>
  node agent/scripts/testnet-harness.mjs down --module=<agent-ref> --profile=<name>
  node agent/scripts/testnet-harness.mjs reset --module=<agent-ref> --profile=<name>

Available profiles: ${profiles}

Phase 2 manages session state, deterministic local roles, and Anvil supervision.
Later phases will add deployment, seeding, and smoke execution.`);
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
    return getArgValue('--profile=', argv) ?? 'local-mock';
}

function parseOptionalPort(argv = process.argv) {
    const rawValue = getArgValue('--port=', argv);
    if (rawValue === null) {
        return undefined;
    }
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
        throw new Error('--port must be an integer between 1 and 65535.');
    }
    return parsed;
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

function sanitizeStatusData(data) {
    const roles = data?.roles?.roles
        ? Object.fromEntries(
              Object.entries(data.roles.roles).map(([name, role]) => [
                  name,
                  {
                      ...role,
                      privateKey: role?.privateKey ? '<redacted-local-key>' : undefined,
                  },
              ])
          )
        : data?.roles?.roles;

    return {
        overlay: data?.overlay ?? null,
        deployment: data?.deployment ?? null,
        roles:
            data?.roles === null
                ? null
                : {
                      ...data.roles,
                      roles,
                  },
        pids: data?.pids ?? null,
    };
}

async function buildStatusPayload({ agentRef, profileName }) {
    const sessionStatus = await readHarnessSessionStatus({
        repoRootPath: repoRoot,
        agentRef,
        profile: profileName,
    });
    const config = await resolveConfigSummary(agentRef, sessionStatus.files.overlay);
    const profile = resolveHarnessProfile(profileName, { env: process.env });
    const anvilStatus = await getAnvilRuntimeStatus(sessionStatus.data.pids?.anvil);

    return {
        module: agentRef,
        profile: {
            name: profile.name,
            mode: profile.mode,
            chainId: profile.chainId,
            forkRpcEnv: profile.forkRpcEnv,
            forkConfigured: profile.forkConfigured,
        },
        sessionDir: sessionStatus.sessionDir,
        exists: sessionStatus.exists,
        files: sessionStatus.fileStatuses,
        data: sanitizeStatusData(sessionStatus.data),
        runtime: {
            anvil: anvilStatus,
        },
        config,
    };
}

async function handleStatus({ agentRef, profileName }) {
    const payload = await buildStatusPayload({ agentRef, profileName });
    console.log(JSON.stringify(payload, null, 2));
}

async function ensureOverlayFile(sessionPaths) {
    const existingOverlay = await readHarnessJson(sessionPaths.files.overlay);
    if (existingOverlay === null) {
        await writeHarnessJson(sessionPaths.files.overlay, {});
    }
}

async function handleInit({ agentRef, profileName }) {
    const sessionPaths = await ensureHarnessSession({
        repoRootPath: repoRoot,
        agentRef,
        profile: profileName,
    });
    await ensureOverlayFile(sessionPaths);
    await handleStatus({ agentRef, profileName });
}

async function handleUp({ agentRef, profileName, port }) {
    const sessionPaths = await ensureHarnessSession({
        repoRootPath: repoRoot,
        agentRef,
        profile: profileName,
    });
    await ensureOverlayFile(sessionPaths);

    const profile = resolveHarnessProfile(profileName, { env: process.env });
    const roles = deriveHarnessRoles();
    await writeHarnessJson(sessionPaths.files.roles, roles);

    const existingPids = (await readHarnessJson(sessionPaths.files.pids)) ?? {};
    const existingAnvilStatus = await getAnvilRuntimeStatus(existingPids.anvil);
    if (!existingAnvilStatus.running && existingAnvilStatus.pidAlive && existingPids.anvil) {
        await stopHarnessAnvil(existingPids.anvil);
    }

    if (!existingAnvilStatus.running) {
        const anvilRecord = await startHarnessAnvil({
            profile,
            sessionPaths,
            env: process.env,
            port,
        });
        await writeHarnessJson(sessionPaths.files.pids, {
            ...existingPids,
            anvil: anvilRecord,
        });
    }

    await handleStatus({ agentRef, profileName });
}

async function handleDown({ agentRef, profileName }) {
    const sessionStatus = await readHarnessSessionStatus({
        repoRootPath: repoRoot,
        agentRef,
        profile: profileName,
    });
    const existingPids = sessionStatus.data.pids ?? {};
    if (!sessionStatus.exists && !existingPids.anvil) {
        console.log(
            JSON.stringify(
                {
                    module: agentRef,
                    profile: profileName,
                    stopped: false,
                    alreadyStopped: true,
                    sessionDir: sessionStatus.sessionDir,
                },
                null,
                2
            )
        );
        return;
    }

    const stopResult = await stopHarnessAnvil(existingPids.anvil);
    const nextPids = { ...existingPids };
    delete nextPids.anvil;
    if (sessionStatus.exists || Object.keys(nextPids).length > 0) {
        await writeHarnessJson(sessionStatus.files.pids, nextPids);
    }

    console.log(
        JSON.stringify(
            {
                module: agentRef,
                profile: profileName,
                stopped: stopResult.stopped,
                alreadyStopped: stopResult.alreadyStopped ?? false,
                sessionDir: sessionStatus.sessionDir,
            },
            null,
            2
        )
    );
}

async function handleReset({ agentRef, profileName }) {
    const sessionStatus = await readHarnessSessionStatus({
        repoRootPath: repoRoot,
        agentRef,
        profile: profileName,
    });
    const existingPids = sessionStatus.data.pids ?? {};
    if (existingPids.anvil) {
        await stopHarnessAnvil(existingPids.anvil);
    }

    await resetHarnessSession({
        repoRootPath: repoRoot,
        agentRef,
        profile: profileName,
    });

    console.log(
        JSON.stringify(
            {
                module: agentRef,
                profile: profileName,
                reset: true,
                sessionDir: sessionStatus.sessionDir,
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
    const profileName = resolveProfile();
    const port = parseOptionalPort();

    if (command === 'init') {
        await handleInit({ agentRef, profileName });
        return;
    }
    if (command === 'up') {
        await handleUp({ agentRef, profileName, port });
        return;
    }
    if (command === 'status') {
        await handleStatus({ agentRef, profileName });
        return;
    }
    if (command === 'down') {
        await handleDown({ agentRef, profileName });
        return;
    }
    if (command === 'reset') {
        await handleReset({ agentRef, profileName });
        return;
    }

    throw new Error(`Unsupported command "${command}". Phase 2 supports: init, up, status, down, reset.`);
}

main().catch((error) => {
    console.error('[testnet-harness] failed:', error?.message ?? error);
    process.exit(1);
});
