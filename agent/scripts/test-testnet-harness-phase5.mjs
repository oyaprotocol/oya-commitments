import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listDeprecatedConfigEnvVars } from '../src/lib/config.js';
import { resolveAnvilExecutable } from './lib/testnet-harness-anvil.mjs';

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

function runHarnessCommand(args) {
    const env = {
        ...process.env,
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

    const moduleArgs = ['--module=signed-message-smoke', '--profile=local-mock'];

    try {
        const smokeResult = runHarnessCommand(['smoke', ...moduleArgs]);
        assert.equal(smokeResult.ok, true);
        assert.equal(smokeResult.usedModuleHarness, true);
        assert.equal(smokeResult.definition.scenario, 'signed-message-smoke');
        assert.equal(smokeResult.result.scenario, 'signed-message-smoke');
        assert.equal(smokeResult.result.message.status, 202);
        assert.match(smokeResult.result.message.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/messages$/);

        const statusResult = runHarnessCommand(['status', ...moduleArgs]);
        assert.equal(statusResult.runtime.anvil.running, true);
        assert.equal(statusResult.runtime.agent.running, true);
        assert.equal(typeof statusResult.data.pids.agent.pid, 'number');
        assert.equal(statusResult.files.agentLog.exists, true);
    } finally {
        runHarnessCommand(['down', ...moduleArgs]);
        runHarnessCommand(['reset', ...moduleArgs]);
    }

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
