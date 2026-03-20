import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHarnessClients, mintHarnessErc20 } from './lib/testnet-harness-actions.mjs';
import { deployHarnessCommitment } from './lib/testnet-harness-deploy.mjs';
import {
    resolveAnvilExecutable,
    startHarnessAnvil,
    stopHarnessAnvil,
} from './lib/testnet-harness-anvil.mjs';
import {
    startHarnessAgent,
    stopHarnessAgent,
} from './lib/testnet-harness-agent.mjs';
import { resolveHarnessProfile } from './lib/testnet-harness-profiles.mjs';
import { deriveHarnessRoles } from './lib/testnet-harness-roles.mjs';
import {
    ensureHarnessSession,
    resetHarnessSession,
    writeHarnessJson,
} from './lib/testnet-harness-session.mjs';
import { resolveHarnessRuntimeContext } from './lib/testnet-harness-runtime.mjs';
import { optimisticGovernorAbi } from '../src/lib/og.js';
import { executeToolCalls } from '../src/lib/tools.js';

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

async function reserveLocalPort(host = '127.0.0.1') {
    return await new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, host, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Failed to reserve a local port.')));
                return;
            }
            const { port } = address;
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(port);
            });
        });
    });
}

async function createTempModule({ localMessageApiPort }) {
    const tempRoot = await mkdtemp(path.join(repoRoot, 'agent/.state/harness-phase8-module-'));
    const moduleDir = path.join(tempRoot, 'fixture-agent');
    await mkdir(moduleDir, { recursive: true });
    await writeFile(
        path.join(moduleDir, 'agent.js'),
        'export function getDeterministicToolCalls() { return []; }\n',
        'utf8'
    );
    await writeFile(
        path.join(moduleDir, 'commitment.txt'),
        'Harness local-mock proposal smoke test.\n',
        'utf8'
    );
    await writeFile(
        path.join(moduleDir, 'config.json'),
        `${JSON.stringify(
            {
                byChain: {
                    '31337': {
                        messageApi: {
                            enabled: true,
                            host: '127.0.0.1',
                            port: localMessageApiPort,
                            requireSignerAllowlist: false,
                        },
                    },
                    '11155111': {
                        messageApi: {
                            enabled: true,
                            host: '127.0.0.1',
                            port: 9919,
                            requireSignerAllowlist: false,
                        },
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
        console.log('ok (skipped phase 8 harness integration: anvil not found)');
        return;
    }
    if (!commandAvailable(process.env.FORGE_BIN?.trim() || 'forge')) {
        console.log('ok (skipped phase 8 harness integration: forge not found)');
        return;
    }

    const localProfile = resolveHarnessProfile('local-mock', { env: {} });
    const roles = deriveHarnessRoles();
    const messageApiPort = await reserveLocalPort();
    const fixture = await createTempModule({
        localMessageApiPort: messageApiPort,
    });
    const agentRef = fixture.agentPath;
    const sessionPaths = await ensureHarnessSession({
        repoRootPath: repoRoot,
        agentRef,
        profile: 'local-mock',
    });

    await writeHarnessJson(sessionPaths.files.overlay, {
        chainId: localProfile.chainId,
    });
    await writeHarnessJson(sessionPaths.files.roles, roles);

    let anvilRecord;
    let runnerRecord;
    try {
        anvilRecord = await startHarnessAnvil({
            profile: localProfile,
            sessionPaths,
            env: process.env,
        });

        await deployHarnessCommitment({
            repoRootPath: repoRoot,
            agentRef,
            profileName: 'local-mock',
            sessionPaths,
            rpcUrl: anvilRecord.rpcUrl,
            deployerPrivateKey: roles.roles.deployer.privateKey,
            env: process.env,
        });

        const runtimeContext = await resolveHarnessRuntimeContext({
            repoRootPath: repoRoot,
            agentRef,
            profileName: 'local-mock',
            overlayPath: sessionPaths.files.overlay,
            env: {
                ...process.env,
                RPC_URL: anvilRecord.rpcUrl,
            },
        });
        assert.equal(runtimeContext.runtimeConfig.chainId, 31337);
        assert.equal(runtimeContext.runtimeConfig.messageApiPort, messageApiPort);

        runnerRecord = await startHarnessAgent({
            repoRootPath: repoRoot,
            agentRef,
            sessionPaths,
            runtimeContext,
            rpcUrl: anvilRecord.rpcUrl,
            signerRole: roles.roles.agent,
            env: process.env,
        });
        assert.equal(runnerRecord.messageApi.enabled, true);
        assert.equal(runnerRecord.messageApi.port, messageApiPort);

        const harnessClients = createHarnessClients({
            rpcUrl: anvilRecord.rpcUrl,
            chainId: localProfile.chainId,
            rolesData: roles,
        });
        const deployerEntry = harnessClients.walletClients.deployer;
        const agentEntry = harnessClients.walletClients.agent;
        assert.ok(deployerEntry);
        assert.ok(agentEntry);

        await mintHarnessErc20({
            walletClient: deployerEntry.walletClient,
            account: deployerEntry.account,
            token: runtimeContext.runtimeConfig.defaultDepositAsset,
            recipient: roles.roles.agent.address,
            amountWei: 10n,
            publicClient: harnessClients.publicClient,
        });

        const proposalOutputs = await executeToolCalls({
            toolCalls: [
                {
                    callId: 'proposal-smoke',
                    name: 'post_bond_and_propose',
                    arguments: {
                        transactions: [
                            {
                                to: runtimeContext.runtimeConfig.commitmentSafe,
                                value: '0',
                                data: '0x',
                                operation: 0,
                            },
                        ],
                        explanation: 'local-mock proposal smoke test',
                    },
                },
            ],
            publicClient: harnessClients.publicClient,
            walletClient: agentEntry.walletClient,
            account: agentEntry.account,
            config: {
                ...runtimeContext.runtimeConfig,
                proposeEnabled: true,
            },
            ogContext: null,
        });

        assert.equal(proposalOutputs.length, 1);
        const parsed = JSON.parse(proposalOutputs[0].output);
        assert.equal(parsed.status, 'submitted');
        assert.match(parsed.transactionHash, /^0x[0-9a-f]{64}$/i);
        assert.match(parsed.ogProposalHash, /^0x[0-9a-f]{64}$/i);

        const assertionId = await harnessClients.publicClient.readContract({
            address: runtimeContext.runtimeConfig.ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'assertionIds',
            args: [parsed.ogProposalHash],
        });
        assert.match(assertionId, /^0x[0-9a-f]{64}$/i);
        assert.notEqual(
            assertionId,
            '0x0000000000000000000000000000000000000000000000000000000000000000'
        );
    } finally {
        if (runnerRecord) {
            await stopHarnessAgent(runnerRecord);
        }
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
