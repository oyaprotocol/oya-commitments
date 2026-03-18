import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { sendHarnessSignedMessage } from './lib/testnet-harness-actions.mjs';
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
    resetHarnessSession,
    writeHarnessJson,
} from './lib/testnet-harness-session.mjs';

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

async function waitForPattern({
    getOutput,
    pattern,
    timeoutMs = 20_000,
}) {
    return await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            const output = getOutput();
            reject(new Error(`Timed out waiting for runner output matching ${pattern}. Output:\n${output}`));
        }, timeoutMs);
        const interval = setInterval(() => {
            const output = getOutput();
            if (!settled && pattern.test(output)) {
                settled = true;
                clearTimeout(timer);
                clearInterval(interval);
                resolve(output);
            }
        }, 50);
        interval.unref?.();
    });
}

async function stopChild(child) {
    if (!child || child.killed) {
        return;
    }
    child.kill('SIGINT');
    await new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
        }, 3_000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

async function run() {
    const anvilBin = resolveAnvilExecutable(process.env);
    if (!commandAvailable(anvilBin)) {
        console.log('ok (skipped phase 4 harness integration: anvil not found)');
        return;
    }
    if (!commandAvailable(process.env.FORGE_BIN?.trim() || 'forge')) {
        console.log('ok (skipped phase 4 harness integration: forge not found)');
        return;
    }

    const localProfile = resolveHarnessProfile('local-mock', { env: {} });
    const roles = deriveHarnessRoles();
    const messageApiPort = await reserveLocalPort();
    const agentRef = 'signed-message-smoke';
    const sessionPaths = await ensureHarnessSession({
        repoRootPath: repoRoot,
        agentRef,
        profile: 'local-mock',
    });

    await writeHarnessJson(sessionPaths.files.overlay, {
        messageApi: {
            port: messageApiPort,
        },
    });
    await writeHarnessJson(sessionPaths.files.roles, roles);

    let anvilRecord;
    let runner;
    let runnerOutput = '';
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

        runner = spawn('node', ['agent/src/index.js'], {
            cwd: repoRoot,
            env: {
                ...process.env,
                RPC_URL: anvilRecord.rpcUrl,
                SIGNER_TYPE: 'env',
                PRIVATE_KEY: roles.roles.agent.privateKey,
                AGENT_MODULE: agentRef,
                AGENT_CONFIG_OVERLAY_PATH: sessionPaths.files.overlay,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        runner.stdout?.on('data', (chunk) => {
            runnerOutput += String(chunk);
        });
        runner.stderr?.on('data', (chunk) => {
            runnerOutput += String(chunk);
        });

        await waitForPattern({
            getOutput: () => runnerOutput,
            pattern: new RegExp(`Message API listening on http://127\\.0\\.0\\.1:${messageApiPort}`),
        });

        const response = await sendHarnessSignedMessage({
            repoRootPath: repoRoot,
            agentRef,
            profile: localProfile,
            overlayPath: sessionPaths.files.overlay,
            role: roles.roles.depositor,
            text: 'Local mock message API end-to-end test',
        });
        assert.equal(response.status, 202);
        assert.equal(response.ok, true);
        assert.equal(response.response.status, 'queued');

        await waitForPattern({
            getOutput: () => runnerOutput,
            pattern: new RegExp(`Handling queued user message \\(messageId=${response.response.messageId}`),
        });
        const finalOutput = await waitForPattern({
            getOutput: () => runnerOutput,
            pattern: /User message produced no action/,
        });
        assert.match(finalOutput, /Processing 1 queued user message\(s\)/);
    } finally {
        await stopChild(runner);
        if (anvilRecord) {
            await stopHarnessAnvil(anvilRecord);
        }
        await resetHarnessSession({
            repoRootPath: repoRoot,
            agentRef,
            profile: 'local-mock',
        });
    }

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
