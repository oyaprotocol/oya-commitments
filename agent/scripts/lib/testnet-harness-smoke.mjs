import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';
import {
    createHarnessClients,
    loadRoleRecord,
    mintHarnessErc20,
    seedHarnessErc20FromHolder,
    sendHarnessDeposit,
    sendHarnessSignedMessage,
} from './testnet-harness-actions.mjs';
import {
    getAgentRuntimeStatus,
    readLogTail,
    startHarnessAgent,
    stopHarnessAgent,
    waitForLogPattern,
} from './testnet-harness-agent.mjs';
import { readHarnessJson, writeHarnessJson } from './testnet-harness-session.mjs';
import { resolveAgentModulePath, resolveHarnessRuntimeContext } from './testnet-harness-runtime.mjs';

async function pathExists(filePath) {
    try {
        await stat(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function loadModuleHarness({ repoRootPath, agentRef }) {
    const modulePath = resolveAgentModulePath(repoRootPath, agentRef);
    const harnessPath = path.join(path.dirname(modulePath), 'harness.mjs');
    if (!(await pathExists(harnessPath))) {
        return {
            harnessPath,
            module: null,
            definition: null,
        };
    }

    const imported = await import(`${pathToFileURL(harnessPath).href}?t=${Date.now()}`);
    const definition =
        typeof imported.getHarnessDefinition === 'function' ? await imported.getHarnessDefinition() : {};

    return {
        harnessPath,
        module: imported,
        definition,
    };
}

async function createSmokeContext({
    repoRootPath,
    agentRef,
    profileName,
    runtime,
    ensureDeployment,
}) {
    let runtimeContext = await resolveHarnessRuntimeContext({
        repoRootPath,
        agentRef,
        profileName,
        overlayPath: runtime.sessionPaths.files.overlay,
        env: process.env,
    });

    async function refreshRuntimeContext() {
        runtimeContext = await resolveHarnessRuntimeContext({
            repoRootPath,
            agentRef,
            profileName,
            overlayPath: runtime.sessionPaths.files.overlay,
            env: process.env,
        });
        return runtimeContext;
    }

    async function readPids() {
        return (await readHarnessJson(runtime.sessionPaths.files.pids)) ?? {};
    }

    async function writePids(nextPids) {
        await writeHarnessJson(runtime.sessionPaths.files.pids, nextPids);
    }

    async function ensureAgentStarted({ restart = false, forceDeploy = false } = {}) {
        if (forceDeploy) {
            await ensureDeployment({ force: true });
            await refreshRuntimeContext();
        }

        const currentPids = await readPids();
        const currentStatus = await getAgentRuntimeStatus(currentPids.agent);
        if (restart && currentPids.agent) {
            await stopHarnessAgent(currentPids.agent);
            const nextPids = { ...currentPids };
            delete nextPids.agent;
            await writePids(nextPids);
        } else if (currentStatus.running) {
            return currentPids.agent;
        }

        const signerRole = loadRoleRecord(runtime.rolesData, 'agent');
        const record = await startHarnessAgent({
            repoRootPath,
            agentRef,
            sessionPaths: runtime.sessionPaths,
            runtimeContext,
            rpcUrl: runtime.rpcUrl,
            signerRole: {
                ...signerRole,
                name: 'agent',
            },
            env: process.env,
        });
        await writePids({
            ...(await readPids()),
            agent: record,
        });
        return record;
    }

    function getHarnessClients() {
        return createHarnessClients({
            rpcUrl: runtime.rpcUrl,
            chainId: runtime.profile.chainId,
            rolesData: runtime.rolesData,
        });
    }

    return {
        agentRef,
        profile: runtime.profile,
        sessionPaths: runtime.sessionPaths,
        rolesData: runtime.rolesData,
        anvilRecord: runtime.anvilRecord,
        get runtimeContext() {
            return runtimeContext;
        },
        get runtimeConfig() {
            return runtimeContext.runtimeConfig;
        },
        async refreshRuntimeContext() {
            return await refreshRuntimeContext();
        },
        async ensureDeployment(options = {}) {
            const result = await ensureDeployment(options);
            await refreshRuntimeContext();
            return result;
        },
        async ensureAgentStarted(options = {}) {
            return await ensureAgentStarted(options);
        },
        async getAgentStatus() {
            const pids = await readPids();
            return await getAgentRuntimeStatus(pids.agent);
        },
        async stopAgent() {
            const pids = await readPids();
            const stopResult = await stopHarnessAgent(pids.agent);
            if (pids.agent) {
                const nextPids = { ...pids };
                delete nextPids.agent;
                await writePids(nextPids);
            }
            return stopResult;
        },
        async waitForAgentLog(pattern, options = {}) {
            return await waitForLogPattern({
                logPath: runtime.sessionPaths.files.agentLog,
                pid: (await readPids()).agent?.pid,
                pattern,
                ...options,
            });
        },
        async readAgentLog(options = {}) {
            return await readLogTail(runtime.sessionPaths.files.agentLog, options);
        },
        loadRole(roleName) {
            return loadRoleRecord(runtime.rolesData, roleName);
        },
        createHarnessClients: getHarnessClients,
        async sendDeposit({ roleName, asset, amountWei }) {
            return await sendHarnessDeposit({
                runtimeConfig: runtimeContext.runtimeConfig,
                roleName,
                asset,
                amountWei,
                harnessClients: getHarnessClients(),
            });
        },
        async sendMessage({
            roleName,
            text,
            requestId,
            command,
            args,
            metadata,
            deadline,
            dryRun,
        }) {
            const role = loadRoleRecord(runtime.rolesData, roleName ?? 'depositor');
            return await sendHarnessSignedMessage({
                repoRootPath,
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
        },
        async mintErc20({ token, recipientRoleName = 'depositor', amountWei }) {
            const harnessClients = getHarnessClients();
            const deployerEntry = harnessClients.walletClients.deployer;
            if (!deployerEntry) {
                throw new Error('Missing deployer wallet client.');
            }
            const recipientRole = loadRoleRecord(runtime.rolesData, recipientRoleName);
            return await mintHarnessErc20({
                walletClient: deployerEntry.walletClient,
                account: deployerEntry.account,
                token,
                recipient: recipientRole.address,
                amountWei: BigInt(amountWei),
                publicClient: harnessClients.publicClient,
            });
        },
        async seedErc20FromHolder({ token, holder, recipientRoleName = 'depositor', amountWei }) {
            const harnessClients = getHarnessClients();
            const recipientRole = loadRoleRecord(runtime.rolesData, recipientRoleName);
            return await seedHarnessErc20FromHolder({
                publicClient: harnessClients.publicClient,
                testClient: harnessClients.testClient,
                rpcUrl: runtime.rpcUrl,
                token,
                holder,
                recipient: recipientRole.address,
                amountWei: BigInt(amountWei),
            });
        },
    };
}

async function runDefaultSmokeScenario(ctx) {
    const deployment = await ctx.ensureDeployment();
    const agent = await ctx.ensureAgentStarted();
    return {
        scenario: 'default',
        deployment,
        agent,
    };
}

async function runHarnessSmokeScenario({
    repoRootPath,
    agentRef,
    profileName,
    runtime,
    ensureDeployment,
    force = false,
}) {
    const loadedHarness = await loadModuleHarness({
        repoRootPath,
        agentRef,
    });
    const ctx = await createSmokeContext({
        repoRootPath,
        agentRef,
        profileName,
        runtime,
        ensureDeployment,
    });

    if (force) {
        await ctx.ensureDeployment({ force: true });
        await ctx.ensureAgentStarted({ restart: true });
    }

    const moduleHarness = loadedHarness.module;
    const runScenario =
        typeof moduleHarness?.runSmokeScenario === 'function' ? moduleHarness.runSmokeScenario : runDefaultSmokeScenario;
    const result = await runScenario(ctx, {
        force,
        definition: loadedHarness.definition ?? {},
    });

    return {
        ok: true,
        module: agentRef,
        profile: profileName,
        harnessPath: loadedHarness.harnessPath,
        usedModuleHarness: Boolean(moduleHarness?.runSmokeScenario),
        definition: loadedHarness.definition ?? {},
        result,
    };
}

export {
    createSmokeContext,
    loadModuleHarness,
    runDefaultSmokeScenario,
    runHarnessSmokeScenario,
};
