import {
    ensureHarnessOverlayChainId,
    ensureHarnessSession,
    readHarnessJson,
    readHarnessPids,
    writeHarnessJson,
    writeHarnessPids,
} from './testnet-harness-session.mjs';
import { resolveHarnessProfile } from './testnet-harness-profiles.mjs';
import { resolveHarnessRoles } from './testnet-harness-roles.mjs';
import {
    getAnvilRuntimeStatus,
    startHarnessAnvil,
    stopHarnessAnvil,
} from './testnet-harness-anvil.mjs';
import {
    ensureHarnessIpfs,
    stopHarnessIpfs,
} from './testnet-harness-ipfs.mjs';
import { resolveHarnessRuntimeContext } from './testnet-harness-runtime.mjs';

function buildHarnessRuntimeEnv({
    env = process.env,
    profile,
    rpcUrl,
    pids,
} = {}) {
    return {
        ...env,
        AGENT_CONFIG_OVERLAY_PATH: '',
        AGENT_CONFIG_OVERLAY_PATHS: '',
        ...(rpcUrl
            ? { RPC_URL: rpcUrl }
            : pids?.anvil?.rpcUrl
                ? { RPC_URL: pids.anvil.rpcUrl }
                : profile?.rpcUrl
                    ? { RPC_URL: profile.rpcUrl }
                    : {}),
    };
}

async function ensureManagedHarnessRuntime({
    repoRootPath,
    agentRef,
    profileName,
    port,
    env = process.env,
    cwd,
}) {
    const profile = resolveHarnessProfile(profileName, { env });
    const sessionPaths = await ensureHarnessSession({
        repoRootPath,
        agentRef,
        profile: profileName,
    });
    await ensureHarnessOverlayChainId(sessionPaths, profile.chainId);
    const roles = resolveHarnessRoles({ profile, env });
    const existingRoles = await readHarnessJson(sessionPaths.files.roles);
    if (existingRoles === null || profile.mode === 'remote') {
        await writeHarnessJson(sessionPaths.files.roles, roles);
    }

    const existingPids = await readHarnessPids(sessionPaths);
    const nextPids = { ...existingPids };

    const existingAnvilStatus = await getAnvilRuntimeStatus(existingPids.anvil);
    if (!profile.managesLocalNode && existingPids.anvil) {
        await stopHarnessAnvil(existingPids.anvil);
        delete nextPids.anvil;
    } else if (
        !existingAnvilStatus.running &&
        existingAnvilStatus.pidAlive &&
        existingPids.anvil
    ) {
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
                env,
                port,
            });
            nextPids.anvil = anvilRecord;
        }
        rpcUrl = anvilRecord.rpcUrl;
    }

    const rolesData = (await readHarnessJson(sessionPaths.files.roles)) ?? roles;
    const runtimeContext = await resolveHarnessRuntimeContext({
        repoRootPath,
        agentRef,
        profileName,
        overlayPath: sessionPaths.files.overlay,
        env: buildHarnessRuntimeEnv({
            env,
            profile,
            rpcUrl,
        }),
    });

    if (runtimeContext.runtimeConfig.ipfsEnabled !== true && nextPids.ipfs) {
        await stopHarnessIpfs(nextPids.ipfs);
        delete nextPids.ipfs;
    } else if (runtimeContext.runtimeConfig.ipfsEnabled === true) {
        nextPids.ipfs = await ensureHarnessIpfs({
            sessionPaths,
            runtimeConfig: runtimeContext.runtimeConfig,
            existingRecord: nextPids.ipfs,
            env,
            cwd,
        });
    }

    await writeHarnessPids(sessionPaths, nextPids);

    return {
        sessionPaths,
        profile,
        anvilRecord,
        rpcUrl,
        rolesData,
        runtimeContext,
    };
}

export {
    buildHarnessRuntimeEnv,
    ensureManagedHarnessRuntime,
};
