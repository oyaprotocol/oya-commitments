import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPublicClient, erc20Abi, http } from 'viem';
import {
    createHarnessClients,
    mintHarnessErc20,
    sendHarnessDeposit,
    sendHarnessSignedMessage,
} from './lib/testnet-harness-actions.mjs';
import { deployHarnessCommitment } from './lib/testnet-harness-deploy.mjs';
import {
    resolveAnvilExecutable,
    startHarnessAnvil,
    stopHarnessAnvil,
} from './lib/testnet-harness-anvil.mjs';
import { resolveHarnessProfile } from './lib/testnet-harness-profiles.mjs';
import { deriveHarnessRoles } from './lib/testnet-harness-roles.mjs';
import {
    ensureHarnessSession,
    readHarnessJson,
    resetHarnessSession,
    writeHarnessJson,
} from './lib/testnet-harness-session.mjs';
import { resolveHarnessRuntimeContext } from './lib/testnet-harness-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

function commandAvailable(command) {
    const result = spawnSync(command, ['--version'], {
        encoding: 'utf8',
    });
    if (result.error?.code === 'ENOENT') {
        return false;
    }
    if (result.status !== 0) {
        throw new Error(
            `${command} --version failed: ${result.stderr?.trim() || result.stdout?.trim() || 'unknown error'}`
        );
    }
    return true;
}

async function createTempModule() {
    const tempRoot = await mkdtemp(path.join(repoRoot, 'agent/.state/harness-phase3-module-'));
    const moduleDir = path.join(tempRoot, 'fixture-agent');
    await mkdir(moduleDir, { recursive: true });
    await writeFile(path.join(moduleDir, 'agent.js'), 'export {};\n', 'utf8');
    await writeFile(
        path.join(moduleDir, 'commitment.txt'),
        'The agent watching this commitment should log and monitor deposits for testing.\n',
        'utf8'
    );
    await writeFile(
        path.join(moduleDir, 'config.json'),
        `${JSON.stringify(
            {
                defaultDepositAmountWei: '2500000',
                messageApi: {
                    enabled: true,
                    host: '127.0.0.1',
                    port: 9911,
                    requireSignerAllowlist: false,
                },
                harness: {
                    deployment: {
                        bondAmount: '1',
                    },
                },
            },
            null,
            2
        )}\n`,
        'utf8'
    );
    return {
        moduleDir,
        agentPath: path.join(moduleDir, 'agent.js'),
        tempRoot,
    };
}

async function run() {
    const anvilBin = resolveAnvilExecutable(process.env);
    if (!commandAvailable(anvilBin)) {
        console.log('ok (skipped phase 3 harness integration: anvil not found)');
        return;
    }
    if (!commandAvailable(process.env.FORGE_BIN?.trim() || 'forge')) {
        console.log('ok (skipped phase 3 harness integration: forge not found)');
        return;
    }

    const localProfile = resolveHarnessProfile('local-mock', { env: {} });
    const roles = deriveHarnessRoles();
    const fixture = await createTempModule();
    const agentRef = fixture.agentPath;
    const sessionPaths = await ensureHarnessSession({
        repoRootPath: repoRoot,
        agentRef,
        profile: 'local-mock',
    });

    await writeHarnessJson(sessionPaths.files.overlay, {});
    await writeHarnessJson(sessionPaths.files.roles, roles);

    let anvilRecord;
    try {
        anvilRecord = await startHarnessAnvil({
            profile: localProfile,
            sessionPaths,
            env: process.env,
        });

        const deployResult = await deployHarnessCommitment({
            repoRootPath: repoRoot,
            agentRef,
            profileName: 'local-mock',
            sessionPaths,
            rpcUrl: anvilRecord.rpcUrl,
            deployerPrivateKey: roles.roles.deployer.privateKey,
            env: process.env,
        });

        assert.equal(deployResult.reused, false);
        assert.match(deployResult.deployment.commitmentSafe, /^0x[0-9a-f]{40}$/i);
        assert.match(deployResult.deployment.ogModule, /^0x[0-9a-f]{40}$/i);
        assert.ok(deployResult.deployment.mockDependencies);

        const reusedResult = await deployHarnessCommitment({
            repoRootPath: repoRoot,
            agentRef,
            profileName: 'local-mock',
            sessionPaths,
            rpcUrl: anvilRecord.rpcUrl,
            deployerPrivateKey: roles.roles.deployer.privateKey,
            env: process.env,
        });
        assert.equal(reusedResult.reused, true);
        assert.equal(reusedResult.deployment.commitmentSafe, deployResult.deployment.commitmentSafe);
        assert.equal(reusedResult.deployment.ogModule, deployResult.deployment.ogModule);

        const overlay = await readHarnessJson(sessionPaths.files.overlay);
        assert.equal(
            overlay.byChain['31337'].commitmentSafe,
            deployResult.deployment.commitmentSafe
        );
        assert.equal(overlay.byChain['31337'].ogModule, deployResult.deployment.ogModule);
        assert.match(overlay.byChain['31337'].defaultDepositAsset, /^0x[0-9a-f]{40}$/i);
        assert.equal(
            overlay.byChain['31337'].harness.deployment.collateral,
            deployResult.deployment.mockDependencies.collateralToken
        );

        const runtimeContext = await resolveHarnessRuntimeContext({
            repoRootPath: repoRoot,
            agentRef,
            profileName: 'local-mock',
            overlayPath: sessionPaths.files.overlay,
            env: process.env,
        });
        assert.equal(runtimeContext.runtimeConfig.commitmentSafe, deployResult.deployment.commitmentSafe);
        assert.equal(
            runtimeContext.runtimeConfig.defaultDepositAmountWei?.toString(),
            '2500000'
        );

        const harnessClients = createHarnessClients({
            rpcUrl: anvilRecord.rpcUrl,
            chainId: localProfile.chainId,
            rolesData: roles,
        });
        const depositorEntry = harnessClients.walletClients.depositor;
        const deployerEntry = harnessClients.walletClients.deployer;
        assert.ok(depositorEntry);
        assert.ok(deployerEntry);

        await mintHarnessErc20({
            walletClient: deployerEntry.walletClient,
            account: deployerEntry.account,
            token: runtimeContext.runtimeConfig.defaultDepositAsset,
            recipient: roles.roles.depositor.address,
            amountWei: 10_000_000n,
            publicClient: harnessClients.publicClient,
        });

        const depositResult = await sendHarnessDeposit({
            runtimeConfig: runtimeContext.runtimeConfig,
            harnessClients,
        });
        assert.equal(depositResult.amountWei, '2500000');

        const publicClient = createPublicClient({
            transport: http(anvilRecord.rpcUrl),
        });
        const safeBalance = await publicClient.readContract({
            address: runtimeContext.runtimeConfig.defaultDepositAsset,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [runtimeContext.runtimeConfig.commitmentSafe],
        });
        assert.equal(safeBalance, 2_500_000n);

        const dryRunMessage = await sendHarnessSignedMessage({
            repoRootPath: repoRoot,
            agentRef,
            profile: localProfile,
            overlayPath: sessionPaths.files.overlay,
            role: roles.roles.depositor,
            text: 'Test signed message from the harness',
            dryRun: true,
        });
        assert.equal(dryRunMessage.endpoint, 'http://127.0.0.1:9911/v1/messages');
        assert.equal(dryRunMessage.signer, roles.roles.depositor.address);
        assert.equal(dryRunMessage.body.auth.address, roles.roles.depositor.address);
        assert.match(dryRunMessage.body.auth.signature, /^0x[0-9a-f]+$/i);
    } finally {
        if (anvilRecord) {
            await stopHarnessAnvil(anvilRecord);
        }
        await resetHarnessSession({
            repoRootPath: repoRoot,
            agentRef,
            profile: 'local-mock',
        });
        await rm(fixture.tempRoot, { recursive: true, force: true });
    }

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
