import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, http } from 'viem';
import { DEFAULT_HARNESS_MNEMONIC } from './testnet-harness-roles.mjs';

const DEFAULT_ANVIL_HOST = '127.0.0.1';
const DEFAULT_ANVIL_START_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

function resolveAnvilExecutable(env = process.env) {
    const candidate = typeof env?.ANVIL_BIN === 'string' ? env.ANVIL_BIN.trim() : '';
    return candidate || 'anvil';
}

async function reserveLocalPort(host = DEFAULT_ANVIL_HOST) {
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

function buildAnvilArgs({ profile, host, port, mnemonic }) {
    const args = [
        '--host',
        host,
        '--port',
        String(port),
        '--chain-id',
        String(profile.chainId),
        '--mnemonic',
        mnemonic,
    ];

    if (profile.forkUrl) {
        args.push('--fork-url', profile.forkUrl);
    }

    return args;
}

function redactAnvilArgs(args, forkUrl) {
    const redactedArgs = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--mnemonic') {
            redactedArgs.push(arg);
            redactedArgs.push('<redacted-mnemonic>');
            index += 1;
            continue;
        }
        redactedArgs.push(arg === forkUrl ? '<redacted-fork-url>' : arg);
    }
    return redactedArgs;
}

function isProcessRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') {
            return false;
        }
        if (error?.code === 'EPERM') {
            return true;
        }
        throw error;
    }
}

async function waitForProcessExit(pid, timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (!isProcessRunning(pid)) {
            return true;
        }
        await delay(100);
    }
    return !isProcessRunning(pid);
}

async function waitForRpcReady({
    rpcUrl,
    expectedChainId,
    timeoutMs = DEFAULT_ANVIL_START_TIMEOUT_MS,
}) {
    const client = createPublicClient({
        transport: http(rpcUrl, {
            retryCount: 0,
        }),
    });
    const deadline = Date.now() + timeoutMs;
    let lastError = null;

    while (Date.now() <= deadline) {
        try {
            const chainId = await client.getChainId();
            if (expectedChainId !== undefined && chainId !== expectedChainId) {
                throw new Error(
                    `Unexpected chain ID ${chainId}; expected ${expectedChainId}.`
                );
            }
            return {
                chainId,
            };
        } catch (error) {
            lastError = error;
            await delay(250);
        }
    }

    throw new Error(
        `Timed out waiting for Anvil RPC at ${rpcUrl}: ${lastError?.message ?? 'unknown error'}`
    );
}

async function getAnvilRuntimeStatus(record) {
    if (!record?.pid) {
        return {
            running: false,
            pidAlive: false,
            rpcReady: false,
            record: record ?? null,
        };
    }

    const pidAlive = isProcessRunning(record.pid);
    let rpcReady = false;
    let chainId = record.chainId ?? null;
    let rpcError;

    if (pidAlive && record.rpcUrl) {
        try {
            const ready = await waitForRpcReady({
                rpcUrl: record.rpcUrl,
                expectedChainId: record.chainId,
                timeoutMs: 1_500,
            });
            rpcReady = true;
            chainId = ready.chainId;
        } catch (error) {
            rpcError = error?.message ?? String(error);
        }
    }

    return {
        running: pidAlive && rpcReady,
        pidAlive,
        rpcReady,
        chainId,
        rpcError,
        record,
    };
}

async function startHarnessAnvil({
    profile,
    sessionPaths,
    env = process.env,
    host = DEFAULT_ANVIL_HOST,
    port,
    mnemonic = DEFAULT_HARNESS_MNEMONIC,
    startTimeoutMs = DEFAULT_ANVIL_START_TIMEOUT_MS,
}) {
    if (!profile || typeof profile !== 'object') {
        throw new Error('startHarnessAnvil requires a resolved profile.');
    }
    if (!sessionPaths?.files?.anvilLog) {
        throw new Error('startHarnessAnvil requires session paths with an anvil log file.');
    }

    const resolvedPort = port ?? (await reserveLocalPort(host));
    const rpcUrl = `http://${host}:${resolvedPort}`;
    const command = resolveAnvilExecutable(env);
    const args = buildAnvilArgs({
        profile,
        host,
        port: resolvedPort,
        mnemonic,
    });

    await mkdir(sessionPaths.sessionDir, { recursive: true });
    const logFd = openSync(sessionPaths.files.anvilLog, 'a');
    let child;
    try {
        child = spawn(command, args, {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env,
        });
    } finally {
        closeSync(logFd);
    }

    const startupFailure = new Promise((_, reject) => {
        child.once('error', (error) => {
            reject(error);
        });
        child.once('exit', (code, signal) => {
            reject(
                new Error(
                    `Anvil exited before it became ready (code=${code ?? 'null'} signal=${signal ?? 'null'}).`
                )
            );
        });
    });

    child.unref();

    try {
        const ready = await Promise.race([
            waitForRpcReady({
                rpcUrl,
                expectedChainId: profile.chainId,
                timeoutMs: startTimeoutMs,
            }),
            startupFailure,
        ]);

        return {
            pid: child.pid,
            host,
            port: resolvedPort,
            rpcUrl,
            chainId: ready.chainId,
            profile: profile.name,
            mode: profile.mode,
            forkRpcEnv: profile.forkRpcEnv,
            startedAt: new Date().toISOString(),
            command,
            args: redactAnvilArgs(args, profile.forkUrl),
        };
    } catch (error) {
        if (child.pid && isProcessRunning(child.pid)) {
            try {
                process.kill(child.pid, 'SIGTERM');
                await waitForProcessExit(child.pid, 1_000);
            } catch (stopError) {
                // Best effort cleanup only.
            }
        }
        throw error;
    }
}

async function stopHarnessAnvil(record, { timeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) {
    if (!record?.pid) {
        return {
            stopped: false,
            alreadyStopped: true,
        };
    }

    if (!isProcessRunning(record.pid)) {
        return {
            stopped: false,
            alreadyStopped: true,
        };
    }

    process.kill(record.pid, 'SIGTERM');
    const terminated = await waitForProcessExit(record.pid, timeoutMs);
    if (!terminated) {
        process.kill(record.pid, 'SIGKILL');
        await waitForProcessExit(record.pid, 2_000);
    }

    return {
        stopped: true,
        pid: record.pid,
    };
}

export {
    DEFAULT_ANVIL_HOST,
    DEFAULT_ANVIL_START_TIMEOUT_MS,
    buildAnvilArgs,
    getAnvilRuntimeStatus,
    isProcessRunning,
    reserveLocalPort,
    resolveAnvilExecutable,
    startHarnessAnvil,
    stopHarnessAnvil,
    waitForRpcReady,
};
