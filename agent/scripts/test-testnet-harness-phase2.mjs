import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createPublicClient, http } from 'viem';
import {
    getAnvilRuntimeStatus,
    resolveAnvilExecutable,
    startHarnessAnvil,
    stopHarnessAnvil,
} from './lib/testnet-harness-anvil.mjs';
import { resolveHarnessProfile } from './lib/testnet-harness-profiles.mjs';
import { deriveHarnessRoles } from './lib/testnet-harness-roles.mjs';
import { ensureHarnessSession } from './lib/testnet-harness-session.mjs';

const EXPECTED_DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const EXPECTED_AGENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const EXPECTED_DEPOSITOR = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

async function run() {
    const localProfile = resolveHarnessProfile('local-mock', { env: {} });
    assert.equal(localProfile.name, 'local-mock');
    assert.equal(localProfile.mode, 'local');
    assert.equal(localProfile.chainId, 31337);
    assert.equal(localProfile.forkConfigured, false);

    assert.throws(
        () => resolveHarnessProfile('fork-sepolia', { env: {} }),
        /SEPOLIA_RPC_URL/
    );

    const forkProfile = resolveHarnessProfile('fork-sepolia', {
        env: {
            SEPOLIA_RPC_URL: 'https://example.invalid',
        },
    });
    assert.equal(forkProfile.forkConfigured, true);
    assert.equal(forkProfile.forkRpcEnv, 'SEPOLIA_RPC_URL');

    const roles = deriveHarnessRoles();
    assert.equal(roles.roles.deployer.address, EXPECTED_DEPLOYER);
    assert.equal(roles.roles.agent.address, EXPECTED_AGENT);
    assert.equal(roles.roles.depositor.address, EXPECTED_DEPOSITOR);
    assert.match(roles.roles.deployer.privateKey, /^0x[0-9a-f]{64}$/i);

    const anvilBin = resolveAnvilExecutable(process.env);
    const version = spawnSync(anvilBin, ['--version'], {
        encoding: 'utf8',
    });
    if (version.error?.code === 'ENOENT') {
        console.log('ok (skipped anvil integration: executable not found)');
        return;
    }
    if (version.status !== 0) {
        throw new Error(
            `Anvil version check failed: ${version.stderr?.trim() || version.stdout?.trim() || 'unknown error'}`
        );
    }

    const repoRootPath = await mkdtemp(path.join(os.tmpdir(), 'testnet-harness-phase2-'));
    const sessionPaths = await ensureHarnessSession({
        repoRootPath,
        agentRef: 'default',
        profile: 'local-mock',
    });

    let anvilRecord;
    try {
        anvilRecord = await startHarnessAnvil({
            profile: localProfile,
            sessionPaths,
            env: process.env,
        });

        const runtimeStatus = await getAnvilRuntimeStatus(anvilRecord);
        assert.equal(runtimeStatus.running, true);
        assert.equal(runtimeStatus.chainId, 31337);

        const publicClient = createPublicClient({
            transport: http(anvilRecord.rpcUrl),
        });
        assert.equal(await publicClient.getChainId(), 31337);

        const deployerBalance = await publicClient.getBalance({
            address: roles.roles.deployer.address,
        });
        const agentBalance = await publicClient.getBalance({
            address: roles.roles.agent.address,
        });
        assert.ok(deployerBalance > 0n);
        assert.ok(agentBalance > 0n);
    } finally {
        if (anvilRecord) {
            await stopHarnessAnvil(anvilRecord);
            const stoppedStatus = await getAnvilRuntimeStatus(anvilRecord);
            assert.equal(stoppedStatus.running, false);
        }
    }

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
