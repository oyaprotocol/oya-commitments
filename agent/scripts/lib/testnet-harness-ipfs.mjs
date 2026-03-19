import path from 'node:path';
import { closeSync, openSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isProcessRunning } from './testnet-harness-anvil.mjs';

const DEFAULT_IPFS_START_TIMEOUT_MS = 20_000;
const DEFAULT_IPFS_STOP_TIMEOUT_MS = 5_000;

function resolveIpfsExecutable(env = process.env) {
    const candidate = typeof env?.IPFS_BIN === 'string' ? env.IPFS_BIN.trim() : '';
    return candidate || 'ipfs';
}

function normalizeIpfsApiUrl(url) {
    if (typeof url !== 'string' || !url.trim()) {
        throw new Error('IPFS API URL must be a non-empty string.');
    }
    return url.trim().replace(/\/+$/, '');
}

function parseIpfsApiUrl(url) {
    try {
        return new URL(normalizeIpfsApiUrl(url));
    } catch (error) {
        throw new Error(`Invalid IPFS API URL: ${error?.message ?? error}`);
    }
}

function isLoopbackHostname(hostname) {
    const normalized = String(hostname).trim().toLowerCase();
    return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function isManageableLocalIpfsUrl(url) {
    const parsed = parseIpfsApiUrl(url);
    return isLoopbackHostname(parsed.hostname);
}

async function pollIpfsHealth(baseUrl, timeoutMs = 1_500) {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
        const response = await fetch(`${normalizeIpfsApiUrl(baseUrl)}/api/v0/version`, {
            method: 'POST',
            signal: abortController.signal,
        });
        if (!response.ok) {
            return {
                ok: false,
                status: response.status,
                error: `HTTP ${response.status}`,
            };
        }
        return {
            ok: true,
            status: response.status,
        };
    } catch (error) {
        return {
            ok: false,
            error: error?.message ?? String(error),
        };
    } finally {
        clearTimeout(timer);
    }
}

async function waitForProcessExit(pid, timeoutMs = DEFAULT_IPFS_STOP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (!isProcessRunning(pid)) {
            return true;
        }
        await delay(100);
    }
    return !isProcessRunning(pid);
}

function runIpfsCommand({ command, args, env, cwd }) {
    const result = spawnSync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
    });
    if (result.error?.code === 'ENOENT') {
        throw new Error(`IPFS executable "${command}" not found.`);
    }
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed: ${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`
        );
    }
}

async function ensureIpfsRepoInitialized({
    command,
    repoPath,
    env,
    cwd,
}) {
    await mkdir(repoPath, { recursive: true });
    try {
        await access(path.join(repoPath, 'config'));
        return;
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }
    runIpfsCommand({
        command,
        args: ['init', '--profile=test'],
        env: {
            ...env,
            IPFS_PATH: repoPath,
        },
        cwd,
    });
}

async function waitForIpfsReady({
    baseUrl,
    pid,
    timeoutMs = DEFAULT_IPFS_START_TIMEOUT_MS,
}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (pid && !isProcessRunning(pid)) {
            throw new Error(`IPFS daemon process ${pid} exited before it became ready.`);
        }
        const health = await pollIpfsHealth(baseUrl);
        if (health.ok) {
            return health;
        }
        await delay(250);
    }
    throw new Error(`Timed out waiting for IPFS API at ${baseUrl}.`);
}

async function getIpfsRuntimeStatus(record, { runtimeConfig } = {}) {
    const enabled = runtimeConfig?.ipfsEnabled === true;
    const baseUrl = enabled && runtimeConfig?.ipfsApiUrl ? normalizeIpfsApiUrl(runtimeConfig.ipfsApiUrl) : undefined;
    if (!enabled) {
        return {
            enabled: false,
            running: false,
            managed: false,
            ready: false,
            record: record ?? null,
        };
    }

    const pidAlive = record?.pid ? isProcessRunning(record.pid) : false;
    const health = baseUrl ? await pollIpfsHealth(baseUrl) : { ok: false, error: 'missing ipfsApiUrl' };
    return {
        enabled: true,
        running: health.ok,
        ready: health.ok,
        managed: record?.managed === true,
        external: record?.external === true || !record?.pid,
        pidAlive,
        error: health.ok ? undefined : health.error,
        baseUrl,
        record: record ?? null,
    };
}

async function ensureHarnessIpfs({
    sessionPaths,
    runtimeConfig,
    existingRecord,
    env = process.env,
    cwd,
    startTimeoutMs = DEFAULT_IPFS_START_TIMEOUT_MS,
}) {
    if (runtimeConfig?.ipfsEnabled !== true) {
        return null;
    }

    const baseUrl = normalizeIpfsApiUrl(runtimeConfig.ipfsApiUrl);
    const manageable = isManageableLocalIpfsUrl(baseUrl);
    const status = await getIpfsRuntimeStatus(existingRecord, { runtimeConfig });

    if (status.running) {
        return existingRecord ?? {
            managed: false,
            external: true,
            pid: null,
            baseUrl,
            startedAt: new Date().toISOString(),
        };
    }

    if (!manageable) {
        return {
            managed: false,
            external: true,
            pid: null,
            baseUrl,
            startedAt: new Date().toISOString(),
        };
    }

    if (existingRecord?.pid && status.pidAlive) {
        await stopHarnessIpfs(existingRecord);
    }

    const command = resolveIpfsExecutable(env);
    const repoPath = path.join(sessionPaths.sessionDir, 'ipfs-repo');
    const daemonEnv = {
        ...env,
        IPFS_PATH: repoPath,
    };
    await ensureIpfsRepoInitialized({
        command,
        repoPath,
        env,
        cwd,
    });

    await mkdir(sessionPaths.sessionDir, { recursive: true });
    const logFd = openSync(sessionPaths.files.ipfsLog, 'a');
    let child;
    try {
        child = spawn(command, ['daemon'], {
            cwd,
            env: daemonEnv,
            detached: true,
            stdio: ['ignore', logFd, logFd],
        });
    } finally {
        closeSync(logFd);
    }

    const startupFailure = new Promise((_, reject) => {
        child.once('error', (error) => reject(error));
        child.once('exit', (code, signal) => {
            reject(
                new Error(
                    `IPFS daemon exited before it became ready (code=${code ?? 'null'} signal=${signal ?? 'null'}).`
                )
            );
        });
    });

    child.unref();

    try {
        await Promise.race([
            waitForIpfsReady({
                baseUrl,
                pid: child.pid,
                timeoutMs: startTimeoutMs,
            }),
            startupFailure,
        ]);
        return {
            managed: true,
            external: false,
            pid: child.pid,
            command,
            args: ['daemon'],
            baseUrl,
            repoPath,
            startedAt: new Date().toISOString(),
        };
    } catch (error) {
        if (child.pid && isProcessRunning(child.pid)) {
            try {
                process.kill(child.pid, 'SIGTERM');
                await waitForProcessExit(child.pid, 1_000);
            } catch {
                // Best-effort cleanup only.
            }
        }
        throw error;
    }
}

async function stopHarnessIpfs(record, { timeoutMs = DEFAULT_IPFS_STOP_TIMEOUT_MS } = {}) {
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
    DEFAULT_IPFS_START_TIMEOUT_MS,
    DEFAULT_IPFS_STOP_TIMEOUT_MS,
    ensureHarnessIpfs,
    getIpfsRuntimeStatus,
    isManageableLocalIpfsUrl,
    normalizeIpfsApiUrl,
    parseIpfsApiUrl,
    pollIpfsHealth,
    resolveIpfsExecutable,
    stopHarnessIpfs,
};
