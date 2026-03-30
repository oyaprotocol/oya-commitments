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
import { deployHarnessCommitment, parseDeploymentConfig } from './lib/testnet-harness-deploy.mjs';
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
const harnessSafeAbi = [
    {
        type: 'function',
        name: 'getOwners',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'address[]' }],
    },
    {
        type: 'function',
        name: 'getThreshold',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    },
];

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

async function createTempModule({
    config = {},
    commitmentText = 'The agent watching this commitment should log and monitor deposits for testing.\n',
} = {}) {
    const tempRoot = await mkdtemp(path.join(repoRoot, 'agent/.state/harness-phase3-module-'));
    const moduleDir = path.join(tempRoot, 'fixture-agent');
    await mkdir(moduleDir, { recursive: true });
    await writeFile(path.join(moduleDir, 'agent.js'), 'export {};\n', 'utf8');
    await writeFile(path.join(moduleDir, 'commitment.txt'), commitmentText, 'utf8');
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
                ...config,
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

    assert.equal(
        parseDeploymentConfig({
            runtimeConfig: {
                agentConfig: {
                    harness: {
                        deployment: {
                            owners: [roles.roles.deployer.address, roles.roles.agent.address],
                        },
                    },
                },
            },
        }).owners,
        `${roles.roles.deployer.address},${roles.roles.agent.address}`
    );
    assert.equal(
        parseDeploymentConfig({
            runtimeConfig: {
                agentConfig: {
                    harness: {
                        deployment: {
                            owners: '0x',
                        },
                    },
                },
            },
        }).owners,
        '0x'
    );
    assert.throws(
        () =>
            parseDeploymentConfig({
                runtimeConfig: {
                    agentConfig: {
                        harness: {
                            deployment: {
                                owners: [],
                            },
                        },
                    },
                },
            }),
        /must contain at least one owner/
    );
    assert.throws(
        () =>
            parseDeploymentConfig({
                runtimeConfig: {
                    agentConfig: {
                        harness: {
                            deployment: {
                                owners: '   ',
                            },
                        },
                    },
                },
            }),
        /must not be empty/
    );

    const fixture = await createTempModule();
    const agentRef = fixture.agentPath;
    const sessionPaths = await ensureHarnessSession({
        repoRootPath: repoRoot,
        agentRef,
        profile: 'local-mock',
    });

    await writeHarnessJson(sessionPaths.files.overlay, {});
    await writeHarnessJson(sessionPaths.files.roles, roles);
    const contaminatedHarnessEnv = {
        ...process.env,
        SAFE_OWNERS: roles.roles.agent.address,
    };

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
            env: contaminatedHarnessEnv,
        });

        assert.equal(deployResult.reused, false);
        assert.match(deployResult.deployment.commitmentSafe, /^0x[0-9a-f]{40}$/i);
        assert.match(deployResult.deployment.ogModule, /^0x[0-9a-f]{40}$/i);
        assert.ok(deployResult.deployment.mockDependencies);
        assert.equal(deployResult.deployment.deploymentConfig.bondAmount, '1');

        const reusedResult = await deployHarnessCommitment({
            repoRootPath: repoRoot,
            agentRef,
            profileName: 'local-mock',
            sessionPaths,
            rpcUrl: anvilRecord.rpcUrl,
            deployerPrivateKey: roles.roles.deployer.privateKey,
            env: contaminatedHarnessEnv,
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
        const safeOwners = await harnessClients.publicClient.readContract({
            address: runtimeContext.runtimeConfig.commitmentSafe,
            abi: harnessSafeAbi,
            functionName: 'getOwners',
        });
        const safeThreshold = await harnessClients.publicClient.readContract({
            address: runtimeContext.runtimeConfig.commitmentSafe,
            abi: harnessSafeAbi,
            functionName: 'getThreshold',
        });
        assert.deepEqual(safeOwners, [roles.roles.deployer.address]);
        assert.equal(safeThreshold, 1n);

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

    const customCollateralFixture = await createTempModule({
        config: {
            harness: {
                deployment: {
                    collateral: '0x1234567890123456789012345678901234567890',
                },
            },
        },
    });
    const customAgentRef = customCollateralFixture.agentPath;
    const customSessionPaths = await ensureHarnessSession({
        repoRootPath: repoRoot,
        agentRef: customAgentRef,
        profile: 'local-mock',
    });

    await writeHarnessJson(customSessionPaths.files.overlay, {});
    await writeHarnessJson(customSessionPaths.files.roles, roles);

    let customAnvilRecord;
    try {
        customAnvilRecord = await startHarnessAnvil({
            profile: localProfile,
            sessionPaths: customSessionPaths,
            env: process.env,
        });

        const customDeployResult = await deployHarnessCommitment({
            repoRootPath: repoRoot,
            agentRef: customAgentRef,
            profileName: 'local-mock',
            sessionPaths: customSessionPaths,
            rpcUrl: customAnvilRecord.rpcUrl,
            deployerPrivateKey: roles.roles.deployer.privateKey,
            env: process.env,
        });

        assert.equal(
            customDeployResult.deployment.deploymentConfig.collateral,
            '0x1234567890123456789012345678901234567890'
        );
        assert.equal(customDeployResult.deployment.deploymentConfig.bondAmount, '1');
        assert.notEqual(
            customDeployResult.deployment.mockDependencies?.collateralToken,
            '0x1234567890123456789012345678901234567890'
        );

        const customOverlay = await readHarnessJson(customSessionPaths.files.overlay);
        assert.equal(
            customOverlay.byChain['31337'].defaultDepositAsset,
            '0x1234567890123456789012345678901234567890'
        );
        assert.equal(
            customOverlay.byChain['31337'].harness.deployment.collateral,
            '0x1234567890123456789012345678901234567890'
        );
    } finally {
        if (customAnvilRecord) {
            await stopHarnessAnvil(customAnvilRecord);
        }
        await resetHarnessSession({
            repoRootPath: repoRoot,
            agentRef: customAgentRef,
            profile: 'local-mock',
        });
        await rm(customCollateralFixture.tempRoot, { recursive: true, force: true });
    }

    const staleDefaultFixture = await createTempModule({
        config: {
            defaultDepositAsset: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        },
    });
    const staleDefaultAgentRef = staleDefaultFixture.agentPath;
    const staleDefaultSessionPaths = await ensureHarnessSession({
        repoRootPath: repoRoot,
        agentRef: staleDefaultAgentRef,
        profile: 'local-mock',
    });

    await writeHarnessJson(staleDefaultSessionPaths.files.overlay, {});
    await writeHarnessJson(staleDefaultSessionPaths.files.roles, roles);

    let staleDefaultAnvilRecord;
    try {
        staleDefaultAnvilRecord = await startHarnessAnvil({
            profile: localProfile,
            sessionPaths: staleDefaultSessionPaths,
            env: process.env,
        });

        const staleDefaultDeployResult = await deployHarnessCommitment({
            repoRootPath: repoRoot,
            agentRef: staleDefaultAgentRef,
            profileName: 'local-mock',
            sessionPaths: staleDefaultSessionPaths,
            rpcUrl: staleDefaultAnvilRecord.rpcUrl,
            deployerPrivateKey: roles.roles.deployer.privateKey,
            env: process.env,
        });

        const staleDefaultOverlay = await readHarnessJson(staleDefaultSessionPaths.files.overlay);
        assert.equal(
            staleDefaultOverlay.byChain['31337'].defaultDepositAsset,
            staleDefaultDeployResult.deployment.mockDependencies.collateralToken
        );
    } finally {
        if (staleDefaultAnvilRecord) {
            await stopHarnessAnvil(staleDefaultAnvilRecord);
        }
        await resetHarnessSession({
            repoRootPath: repoRoot,
            agentRef: staleDefaultAgentRef,
            profile: 'local-mock',
        });
        await rm(staleDefaultFixture.tempRoot, { recursive: true, force: true });
    }

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
