import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { listDeprecatedConfigEnvVars } from '../src/lib/config.js';
import { resolveAnvilExecutable } from './lib/testnet-harness-anvil.mjs';
import { buildHarnessRuntimeEnv } from './lib/testnet-harness-context.mjs';

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

function runHarnessCommand(args, { extraEnv = {} } = {}) {
    const env = {
        ...process.env,
        ...extraEnv,
    };
    for (const key of listDeprecatedConfigEnvVars({
        agentModuleName: 'signed-message-smoke',
    })) {
        env[key] = '';
    }
    const result = spawnSync('node', ['agent/scripts/testnet-harness.mjs', ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        env,
    });
    if (result.status !== 0) {
        throw new Error(
            `Harness command failed: node agent/scripts/testnet-harness.mjs ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
        );
    }
    return JSON.parse(result.stdout);
}

async function run() {
    const anvilBin = resolveAnvilExecutable(process.env);
    if (!commandAvailable(anvilBin)) {
        console.log('ok (skipped phase 5 harness integration: anvil not found)');
        return;
    }
    if (!commandAvailable(process.env.FORGE_BIN?.trim() || 'forge')) {
        console.log('ok (skipped phase 5 harness integration: forge not found)');
        return;
    }

    const runtimeEnv = buildHarnessRuntimeEnv({
        env: {
            AGENT_CONFIG_OVERLAY_PATH: '/tmp/legacy-overlay.json',
            AGENT_CONFIG_OVERLAY_PATHS: '/tmp/legacy-overlay-a.json,/tmp/legacy-overlay-b.json',
        },
        profile: { rpcUrl: 'http://127.0.0.1:8545' },
    });
    assert.equal(runtimeEnv.AGENT_CONFIG_OVERLAY_PATH, '');
    assert.equal(runtimeEnv.AGENT_CONFIG_OVERLAY_PATHS, '');
    assert.equal(runtimeEnv.RPC_URL, 'http://127.0.0.1:8545');

    const moduleArgs = ['--module=signed-message-smoke', '--profile=local-mock'];
    const conflictingOverlayDir = await mkdtemp(path.join(os.tmpdir(), 'harness-phase5-overlay-'));
    const conflictingOverlayPath = path.join(conflictingOverlayDir, 'overlay.json');
    await writeFile(
        conflictingOverlayPath,
        JSON.stringify(
            {
                chainId: 11155111,
            },
            null,
            2
        ),
        'utf8'
    );

    try {
        runHarnessCommand(['reset', ...moduleArgs], {
            extraEnv: {
                AGENT_CONFIG_OVERLAY_PATH: conflictingOverlayPath,
            },
        });
        const freshStatus = runHarnessCommand(['status', ...moduleArgs], {
            extraEnv: {
                AGENT_CONFIG_OVERLAY_PATH: conflictingOverlayPath,
            },
        });
        assert.equal(freshStatus.runtime.rpc.chainId, 31337);
        assert.equal(freshStatus.data.overlay.chainId, 31337);

        runHarnessCommand(['reset', ...moduleArgs], {
            extraEnv: {
                AGENT_CONFIG_OVERLAY_PATH: conflictingOverlayPath,
            },
        });
        const initResult = runHarnessCommand(['init', ...moduleArgs], {
            extraEnv: {
                AGENT_CONFIG_OVERLAY_PATH: conflictingOverlayPath,
            },
        });
        assert.equal(initResult.runtime.rpc.chainId, 31337);
        assert.equal(initResult.data.overlay.chainId, 31337);

        const smokeResult = runHarnessCommand(['smoke', ...moduleArgs], {
            extraEnv: {
                AGENT_CONFIG_OVERLAY_PATH: conflictingOverlayPath,
            },
        });
        assert.equal(smokeResult.ok, true);
        assert.equal(smokeResult.usedModuleHarness, true);
        assert.equal(smokeResult.definition.scenario, 'signed-message-smoke');
        assert.equal(smokeResult.result.scenario, 'signed-message-smoke');
        assert.equal(smokeResult.result.message.status, 202);
        assert.match(smokeResult.result.message.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/messages$/);

        const statusResult = runHarnessCommand(['status', ...moduleArgs], {
            extraEnv: {
                AGENT_CONFIG_OVERLAY_PATH: conflictingOverlayPath,
            },
        });
        assert.equal(statusResult.runtime.anvil.running, true);
        assert.equal(statusResult.runtime.agent.running, true);
        assert.equal(typeof statusResult.data.pids.agent.pid, 'number');
        assert.equal(statusResult.files.agentLog.exists, true);
    } finally {
        runHarnessCommand(['down', ...moduleArgs], {
            extraEnv: {
                AGENT_CONFIG_OVERLAY_PATH: conflictingOverlayPath,
            },
        });
        runHarnessCommand(['reset', ...moduleArgs], {
            extraEnv: {
                AGENT_CONFIG_OVERLAY_PATH: conflictingOverlayPath,
            },
        });
    }

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
