import dotenv from 'dotenv';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
import {
    getAgentRuntimeStatus,
    startHarnessAgent,
    stopHarnessAgent,
} from './lib/testnet-harness-agent.mjs';
import {
    ensureHarnessIpfs,
    getIpfsRuntimeStatus,
    stopHarnessIpfs,
} from './lib/testnet-harness-ipfs.mjs';
import {
    createHarnessClients,
    loadRoleRecord,
    mintHarnessErc20,
    parseHarnessAsset,
    seedHarnessErc20FromHolder,
    sendHarnessDeposit,
    sendHarnessSignedMessage,
} from './lib/testnet-harness-actions.mjs';
import { deployHarnessCommitment } from './lib/testnet-harness-deploy.mjs';
import { listHarnessProfiles, resolveHarnessProfile } from './lib/testnet-harness-profiles.mjs';
import { resolveHarnessRoles } from './lib/testnet-harness-roles.mjs';
import { resolveHarnessRuntimeContext } from './lib/testnet-harness-runtime.mjs';
import { runHarnessSmokeScenario } from './lib/testnet-harness-smoke.mjs';

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
  node agent/scripts/testnet-harness.mjs deploy --module=<agent-ref> --profile=<name> [--force]
  node agent/scripts/testnet-harness.mjs agent-up --module=<agent-ref> --profile=<name> [--port=<int>] [--force]
  node agent/scripts/testnet-harness.mjs run-agent --module=<agent-ref> --profile=<name> [--port=<int>] [--force]
  node agent/scripts/testnet-harness.mjs smoke --module=<agent-ref> --profile=<name> [--port=<int>] [--force]
  node agent/scripts/testnet-harness.mjs status --module=<agent-ref> --profile=<name>
  node agent/scripts/testnet-harness.mjs seed-erc20 --module=<agent-ref> --profile=<name> --token=<address> --amount-wei=<int> [--role=<name>] [--holder=<address>|--mint]
  node agent/scripts/testnet-harness.mjs deposit --module=<agent-ref> --profile=<name> [--role=<name>] [--asset=<address|native>] [--amount-wei=<int>]
  node agent/scripts/testnet-harness.mjs message --module=<agent-ref> --profile=<name> --text=<string> [--role=<name>] [--dry-run]
  node agent/scripts/testnet-harness.mjs down --module=<agent-ref> --profile=<name>
  node agent/scripts/testnet-harness.mjs reset --module=<agent-ref> --profile=<name>

Available profiles: ${profiles}

Phase 2 manages session state, deterministic local roles, and Anvil supervision.
Phase 5 adds background agent supervision and one-command smoke scenarios.`);
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

function parseOptionalObject(raw, label) {
    if (raw === null || raw === undefined || raw === '') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('not object');
        }
        return parsed;
    } catch (error) {
        throw new Error(`${label} must be a JSON object.`);
    }
}

function parseOptionalInteger(raw, label) {
    if (raw === null || raw === undefined || raw === '') {
        return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
        throw new Error(`${label} must be an integer.`);
    }
    return parsed;
}

function hasFlag(flag, argv = process.argv) {
    return argv.includes(flag);
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
    const runtimeContext = await resolveHarnessRuntimeContext({
        repoRootPath: repoRoot,
        agentRef,
        profileName,
        overlayPath: sessionStatus.files.overlay,
        env: {
            ...process.env,
            ...(sessionStatus.data.pids?.anvil?.rpcUrl
                ? { RPC_URL: sessionStatus.data.pids.anvil.rpcUrl }
                : profile.rpcUrl
                  ? { RPC_URL: profile.rpcUrl }
                  : {}),
        },
    });
    const anvilStatus = await getAnvilRuntimeStatus(sessionStatus.data.pids?.anvil);
    const agentStatus = await getAgentRuntimeStatus(sessionStatus.data.pids?.agent);
    const ipfsStatus = await getIpfsRuntimeStatus(sessionStatus.data.pids?.ipfs, {
        runtimeConfig: runtimeContext.runtimeConfig,
    });

    return {
        module: agentRef,
        profile: {
            name: profile.name,
            mode: profile.mode,
            chainId: profile.chainId,
            rpcEnv: profile.rpcEnv,
            forkRpcEnv: profile.forkRpcEnv,
            managesLocalNode: profile.managesLocalNode,
            rpcConfigured: profile.rpcConfigured,
            forkConfigured: profile.forkConfigured,
            rpcUrl: profile.rpcUrl,
        },
        sessionDir: sessionStatus.sessionDir,
        exists: sessionStatus.exists,
        files: sessionStatus.fileStatuses,
        data: sanitizeStatusData(sessionStatus.data),
        runtime: {
            rpc: {
                url: runtimeContext.runtimeConfig.rpcUrl,
                chainId: runtimeContext.profile.chainId,
                mode: profile.mode,
            },
            anvil: anvilStatus,
            agent: agentStatus,
            ipfs: ipfsStatus,
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

async function ensureHarnessRuntime({ agentRef, profileName, port }) {
    const sessionPaths = await ensureHarnessSession({
        repoRootPath: repoRoot,
        agentRef,
        profile: profileName,
    });
    await ensureOverlayFile(sessionPaths);

    const profile = resolveHarnessProfile(profileName, { env: process.env });
    const roles = resolveHarnessRoles({ profile, env: process.env });
    const existingRoles = await readHarnessJson(sessionPaths.files.roles);
    if (existingRoles === null || profile.mode === 'remote') {
        await writeHarnessJson(sessionPaths.files.roles, roles);
    }

    const existingPids = (await readHarnessJson(sessionPaths.files.pids)) ?? {};
    const nextPids = { ...existingPids };

    const existingAnvilStatus = await getAnvilRuntimeStatus(existingPids.anvil);
    if (!profile.managesLocalNode && existingPids.anvil) {
        await stopHarnessAnvil(existingPids.anvil);
        delete nextPids.anvil;
    } else if (!existingAnvilStatus.running && existingAnvilStatus.pidAlive && existingPids.anvil) {
        await stopHarnessAnvil(existingPids.anvil);
        delete nextPids.anvil;
    }

    let anvilRecord = nextPids.anvil;
    let rpcUrl = profile.rpcUrl;
    if (profile.managesLocalNode) {
        if (!existingAnvilStatus.running) {
            anvilRecord = await startHarnessAnvil({
                profile,
                sessionPaths,
                env: process.env,
                port,
            });
            nextPids.anvil = anvilRecord;
        }
        rpcUrl = anvilRecord.rpcUrl;
    }

    const rolesData = (await readHarnessJson(sessionPaths.files.roles)) ?? roles;
    const runtimeContext = await resolveHarnessRuntimeContext({
        repoRootPath: repoRoot,
        agentRef,
        profileName,
        overlayPath: sessionPaths.files.overlay,
        env: {
            ...process.env,
            RPC_URL: rpcUrl,
        },
    });

    if (runtimeContext.runtimeConfig.ipfsEnabled !== true && nextPids.ipfs) {
        await stopHarnessIpfs(nextPids.ipfs);
        delete nextPids.ipfs;
    } else if (runtimeContext.runtimeConfig.ipfsEnabled === true) {
        nextPids.ipfs = await ensureHarnessIpfs({
            sessionPaths,
            runtimeConfig: runtimeContext.runtimeConfig,
            existingRecord: nextPids.ipfs,
            env: process.env,
            cwd: repoRoot,
        });
    }

    await writeHarnessJson(sessionPaths.files.pids, nextPids);

    return {
        sessionPaths,
        profile,
        anvilRecord,
        rpcUrl,
        rolesData,
        runtimeContext,
    };
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
    await ensureHarnessRuntime({ agentRef, profileName, port });
    await handleStatus({ agentRef, profileName });
}

async function handleDeploy({ agentRef, profileName, port, force }) {
    const runtime = await ensureHarnessRuntime({ agentRef, profileName, port });
    const result = await ensureHarnessDeployment({
        runtime,
        agentRef,
        profileName,
        force,
    });

    console.log(JSON.stringify(result, null, 2));
}

async function ensureHarnessDeployment({ runtime, agentRef, profileName, force }) {
    const deployerRole = loadRoleRecord(runtime.rolesData, 'deployer');
    return await deployHarnessCommitment({
        repoRootPath: repoRoot,
        agentRef,
        profileName,
        sessionPaths: runtime.sessionPaths,
        rpcUrl: runtime.rpcUrl,
        deployerPrivateKey: deployerRole.privateKey,
        force,
        env: process.env,
    });
}

async function handleRunAgent({ agentRef, profileName, port, force }) {
    const runtime = await ensureHarnessRuntime({ agentRef, profileName, port });
    const runtimeContext = await resolveHarnessRuntimeContext({
        repoRootPath: repoRoot,
        agentRef,
        profileName,
        overlayPath: runtime.sessionPaths.files.overlay,
        env: process.env,
    });

    const existingPids = (await readHarnessJson(runtime.sessionPaths.files.pids)) ?? {};
    const existingAgentStatus = await getAgentRuntimeStatus(existingPids.agent);
    if (existingAgentStatus.running) {
        throw new Error(
            'A background harness agent is already running for this module/profile. Stop it with "down" before using run-agent.'
        );
    }

    if (!runtimeContext.runtimeConfig.commitmentSafe || !runtimeContext.runtimeConfig.ogModule || force) {
        await ensureHarnessDeployment({
            runtime,
            agentRef,
            profileName,
            force,
        });
    }

    const agentRole = loadRoleRecord(runtime.rolesData, 'agent');

    const child = spawn('node', ['agent/src/index.js'], {
        cwd: repoRoot,
        env: {
            ...process.env,
            RPC_URL: runtime.rpcUrl,
            SIGNER_TYPE: 'env',
            PRIVATE_KEY: agentRole.privateKey,
            AGENT_MODULE: agentRef,
            AGENT_CONFIG_OVERLAY_PATH: runtime.sessionPaths.files.overlay,
        },
        stdio: 'inherit',
    });

    const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            resolve({ code, signal });
        });
    });

    if (result.signal) {
        throw new Error(`Agent runner exited from signal ${result.signal}.`);
    }
    if (result.code !== 0) {
        process.exitCode = result.code ?? 1;
    }
}

async function handleAgentUp({ agentRef, profileName, port, force }) {
    const runtime = await ensureHarnessRuntime({ agentRef, profileName, port });
    let currentPids = (await readHarnessJson(runtime.sessionPaths.files.pids)) ?? {};
    const currentAgentStatus = await getAgentRuntimeStatus(currentPids.agent);

    if (force && currentPids.agent) {
        await stopHarnessAgent(currentPids.agent);
        delete currentPids.agent;
        await writeHarnessJson(runtime.sessionPaths.files.pids, currentPids);
    }

    const runtimeContextBeforeDeploy = await resolveHarnessRuntimeContext({
        repoRootPath: repoRoot,
        agentRef,
        profileName,
        overlayPath: runtime.sessionPaths.files.overlay,
        env: process.env,
    });

    if (!runtimeContextBeforeDeploy.runtimeConfig.commitmentSafe || !runtimeContextBeforeDeploy.runtimeConfig.ogModule || force) {
        await ensureHarnessDeployment({
            runtime,
            agentRef,
            profileName,
            force,
        });
    }

    if (!force && currentAgentStatus.running) {
        console.log(
            JSON.stringify(
                {
                    started: false,
                    alreadyRunning: true,
                    agent: currentPids.agent,
                },
                null,
                2
            )
        );
        return;
    }

    const runtimeContext = await resolveHarnessRuntimeContext({
        repoRootPath: repoRoot,
        agentRef,
        profileName,
        overlayPath: runtime.sessionPaths.files.overlay,
        env: process.env,
    });
    const agentRole = loadRoleRecord(runtime.rolesData, 'agent');
    const agentRecord = await startHarnessAgent({
        repoRootPath: repoRoot,
        agentRef,
        sessionPaths: runtime.sessionPaths,
        runtimeContext,
        rpcUrl: runtime.rpcUrl,
        signerRole: {
            ...agentRole,
            name: 'agent',
        },
        env: process.env,
    });
    await writeHarnessJson(runtime.sessionPaths.files.pids, {
        ...(await readHarnessJson(runtime.sessionPaths.files.pids)),
        agent: agentRecord,
    });

    console.log(
        JSON.stringify(
            {
                started: true,
                alreadyRunning: false,
                agent: agentRecord,
            },
            null,
            2
        )
    );
}

async function handleSmoke({ agentRef, profileName, port, force }) {
    const runtime = await ensureHarnessRuntime({ agentRef, profileName, port });
    const result = await runHarnessSmokeScenario({
        repoRootPath: repoRoot,
        agentRef,
        profileName,
        runtime,
        ensureDeployment: async ({ force: deployForce } = {}) =>
            await ensureHarnessDeployment({
                runtime,
                agentRef,
                profileName,
                force: Boolean(deployForce),
            }),
        force,
    });

    console.log(JSON.stringify(result, null, 2));
}

async function handleSeedErc20({
    agentRef,
    profileName,
    port,
    roleName,
    token,
    amountWei,
    holder,
    mint,
}) {
    if (!token) {
        throw new Error('--token is required.');
    }
    if (amountWei === undefined) {
        throw new Error('--amount-wei is required.');
    }

    const runtime = await ensureHarnessRuntime({ agentRef, profileName, port });
    const harnessClients = createHarnessClients({
        rpcUrl: runtime.rpcUrl,
        chainId: runtime.profile.chainId,
        rolesData: runtime.rolesData,
    });
    const recipientRole = loadRoleRecord(runtime.rolesData, roleName ?? 'depositor');
    let result;

    if (mint) {
        const deployerEntry = harnessClients.walletClients.deployer;
        if (!deployerEntry) {
            throw new Error('Missing deployer wallet client.');
        }
        result = await mintHarnessErc20({
            walletClient: deployerEntry.walletClient,
            account: deployerEntry.account,
            token,
            recipient: recipientRole.address,
            amountWei: BigInt(amountWei),
            publicClient: harnessClients.publicClient,
        });
    } else {
        if (runtime.profile.mode === 'remote') {
            throw new Error('seed-erc20 with --holder is only supported on local/fork profiles.');
        }
        const runtimeContext = await resolveHarnessRuntimeContext({
            repoRootPath: repoRoot,
            agentRef,
            profileName,
            overlayPath: runtime.sessionPaths.files.overlay,
            env: process.env,
        });
        const defaultHolder =
            runtimeContext.runtimeConfig.agentConfig?.harness?.seedErc20Holders?.[getNormalizedAddressKey(token)];
        const sourceHolder = holder ?? defaultHolder;
        if (!sourceHolder) {
            throw new Error(
                'ERC20 seeding requires --holder=<address> or config.agentConfig.harness.seedErc20Holders[token].'
            );
        }
        result = await seedHarnessErc20FromHolder({
            publicClient: harnessClients.publicClient,
            testClient: harnessClients.testClient,
            rpcUrl: runtime.rpcUrl,
            token,
            holder: sourceHolder,
            recipient: recipientRole.address,
            amountWei: BigInt(amountWei),
        });
    }

    console.log(
        JSON.stringify(
            {
                token,
                amountWei: BigInt(amountWei).toString(),
                recipientRole: normalizeRoleForOutput(roleName),
                recipient: recipientRole.address,
                ...summarizeSeedResult(result),
            },
            null,
            2
        )
    );
}

function getNormalizedAddressKey(value) {
    return String(value).trim().toLowerCase();
}

function normalizeRoleForOutput(roleName) {
    return typeof roleName === 'string' && roleName.trim() ? roleName.trim() : 'depositor';
}

function summarizeSeedResult(result) {
    return {
        mode: result?.mode,
        transactionHash: result?.transactionHash,
        blockNumber:
            result?.receipt?.blockNumber !== undefined
                ? result.receipt.blockNumber.toString()
                : undefined,
    };
}

async function handleDeposit({ agentRef, profileName, port, roleName, asset, amountWei }) {
    const runtime = await ensureHarnessRuntime({ agentRef, profileName, port });
    const runtimeContext = await resolveHarnessRuntimeContext({
        repoRootPath: repoRoot,
        agentRef,
        profileName,
        overlayPath: runtime.sessionPaths.files.overlay,
        env: process.env,
    });
    if (!runtimeContext.runtimeConfig.commitmentSafe) {
        throw new Error('No commitment deployment is configured for the selected module/profile.');
    }

    const harnessClients = createHarnessClients({
        rpcUrl: runtime.rpcUrl,
        chainId: runtime.profile.chainId,
        rolesData: runtime.rolesData,
    });
    const result = await sendHarnessDeposit({
        runtimeConfig: runtimeContext.runtimeConfig,
        roleName,
        asset,
        amountWei,
        harnessClients,
    });
    console.log(JSON.stringify(result, null, 2));
}

async function handleMessage({
    agentRef,
    profileName,
    port,
    roleName,
    text,
    requestId,
    command,
    args,
    metadata,
    deadline,
    dryRun,
}) {
    if (!text || !text.trim()) {
        throw new Error('--text is required.');
    }
    const runtime = await ensureHarnessRuntime({ agentRef, profileName, port });
    const role = loadRoleRecord(runtime.rolesData, roleName ?? 'depositor');
    const result = await sendHarnessSignedMessage({
        repoRootPath: repoRoot,
        agentRef,
        profile: runtime.profile,
        overlayPath: runtime.sessionPaths.files.overlay,
        role,
        text,
        requestId,
        command,
        args,
        metadata,
        deadline,
        dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
}

async function handleDown({ agentRef, profileName }) {
    const sessionStatus = await readHarnessSessionStatus({
        repoRootPath: repoRoot,
        agentRef,
        profile: profileName,
    });
    const existingPids = sessionStatus.data.pids ?? {};
    if (!sessionStatus.exists && !existingPids.anvil && !existingPids.agent && !existingPids.ipfs) {
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

    const agentStopResult = await stopHarnessAgent(existingPids.agent);
    const ipfsStopResult = await stopHarnessIpfs(existingPids.ipfs);
    const stopResult = await stopHarnessAnvil(existingPids.anvil);
    const nextPids = { ...existingPids };
    delete nextPids.agent;
    delete nextPids.ipfs;
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
                agentStopped: agentStopResult.stopped,
                agentAlreadyStopped: agentStopResult.alreadyStopped ?? false,
                ipfsStopped: ipfsStopResult.stopped,
                ipfsAlreadyStopped: ipfsStopResult.alreadyStopped ?? false,
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
    if (existingPids.agent) {
        await stopHarnessAgent(existingPids.agent);
    }
    if (existingPids.ipfs) {
        await stopHarnessIpfs(existingPids.ipfs);
    }
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
    const roleName = getArgValue('--role=');
    const amountWeiRaw = getArgValue('--amount-wei=');
    const amountWei = amountWeiRaw === null ? undefined : BigInt(amountWeiRaw);
    const asset = parseHarnessAsset(getArgValue('--asset='));
    const text = getArgValue('--text=');
    const requestId = getArgValue('--request-id=') ?? undefined;
    const commandArg = getArgValue('--command=') ?? undefined;
    const args = parseOptionalObject(getArgValue('--args-json='), '--args-json');
    const metadata = parseOptionalObject(getArgValue('--metadata-json='), '--metadata-json');
    const deadline = parseOptionalInteger(getArgValue('--deadline-ms='), '--deadline-ms');
    const token = getArgValue('--token=');
    const holder = getArgValue('--holder=') ?? undefined;
    const force = hasFlag('--force');
    const mint = hasFlag('--mint');
    const dryRun = hasFlag('--dry-run');

    if (command === 'init') {
        await handleInit({ agentRef, profileName });
        return;
    }
    if (command === 'up') {
        await handleUp({ agentRef, profileName, port });
        return;
    }
    if (command === 'deploy') {
        await handleDeploy({ agentRef, profileName, port, force });
        return;
    }
    if (command === 'agent-up') {
        await handleAgentUp({ agentRef, profileName, port, force });
        return;
    }
    if (command === 'run-agent') {
        await handleRunAgent({ agentRef, profileName, port, force });
        return;
    }
    if (command === 'smoke') {
        await handleSmoke({ agentRef, profileName, port, force });
        return;
    }
    if (command === 'status') {
        await handleStatus({ agentRef, profileName });
        return;
    }
    if (command === 'seed-erc20') {
        await handleSeedErc20({
            agentRef,
            profileName,
            port,
            roleName,
            token,
            amountWei,
            holder,
            mint,
        });
        return;
    }
    if (command === 'deposit') {
        await handleDeposit({
            agentRef,
            profileName,
            port,
            roleName,
            asset,
            amountWei,
        });
        return;
    }
    if (command === 'message') {
        await handleMessage({
            agentRef,
            profileName,
            port,
            roleName,
            text,
            requestId,
            command: commandArg,
            args,
            metadata,
            deadline,
            dryRun,
        });
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

    throw new Error(
        `Unsupported command "${command}". Phase 5 supports: init, up, deploy, agent-up, run-agent, smoke, status, seed-erc20, deposit, message, down, reset.`
    );
}

main().catch((error) => {
    console.error('[testnet-harness] failed:', error?.message ?? error);
    process.exit(1);
});
