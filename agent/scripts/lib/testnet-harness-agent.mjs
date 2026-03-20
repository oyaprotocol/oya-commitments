import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { listDeprecatedConfigEnvVars } from '../../src/lib/config.js';
import { isProcessRunning } from './testnet-harness-anvil.mjs';

const DEFAULT_AGENT_START_TIMEOUT_MS = 20_000;
const DEFAULT_AGENT_STOP_TIMEOUT_MS = 5_000;

function formatMessageApiBaseUrl(host, port) {
    const authorityHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${authorityHost}:${port}`;
}

function resolveNodeExecutable(env = process.env) {
    const candidate = typeof env?.NODE_BIN === 'string' ? env.NODE_BIN.trim() : '';
    return candidate || 'node';
}

function buildHarnessAgentChildEnv({
    env = process.env,
    agentRef,
    rpcUrl,
    signerRole,
    overlayPath,
}) {
    const childEnv = {
        ...env,
    };
    for (const key of listDeprecatedConfigEnvVars({ agentModuleName: agentRef })) {
        childEnv[key] = '';
    }

    childEnv.RPC_URL = rpcUrl;
    childEnv.SIGNER_TYPE = 'env';
    childEnv.PRIVATE_KEY = signerRole.privateKey;
    childEnv.AGENT_MODULE = agentRef;
    childEnv.AGENT_CONFIG_OVERLAY_PATH = overlayPath;

    return childEnv;
}

async function readLogTail(logPath, { maxBytes = 8_192 } = {}) {
    if (!logPath) {
        return '';
    }
    try {
        const raw = await readFile(logPath, 'utf8');
        if (raw.length <= maxBytes) {
            return raw;
        }
        return raw.slice(raw.length - maxBytes);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return '';
        }
        throw error;
    }
}

async function waitForProcessExit(pid, timeoutMs = DEFAULT_AGENT_STOP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (!isProcessRunning(pid)) {
            return true;
        }
        await delay(100);
    }
    return !isProcessRunning(pid);
}

async function pollMessageApiHealth(baseUrl, timeoutMs = 1_500) {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
        const response = await fetch(`${baseUrl}/healthz`, {
            method: 'GET',
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

async function waitForLogPattern({
    logPath,
    pattern,
    timeoutMs = DEFAULT_AGENT_START_TIMEOUT_MS,
    pollIntervalMs = 100,
    pid,
}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (pid && !isProcessRunning(pid)) {
            const tail = await readLogTail(logPath);
            throw new Error(
                `Process ${pid} exited before log matched ${pattern}. Recent log output:\n${tail || '<empty>'}`
            );
        }
        const output = await readLogTail(logPath, { maxBytes: 64_000 });
        if (pattern.test(output)) {
            return output;
        }
        await delay(pollIntervalMs);
    }

    const tail = await readLogTail(logPath);
    throw new Error(`Timed out waiting for log pattern ${pattern}. Recent log output:\n${tail || '<empty>'}`);
}

async function waitForAgentReady({
    record,
    timeoutMs = DEFAULT_AGENT_START_TIMEOUT_MS,
}) {
    const deadline = Date.now() + timeoutMs;
    const runningPattern = /\[agent\] running\.\.\./;

    while (Date.now() <= deadline) {
        if (!isProcessRunning(record.pid)) {
            const tail = await readLogTail(record.logPath);
            throw new Error(
                `Agent exited before readiness checks completed. Recent log output:\n${tail || '<empty>'}`
            );
        }

        const logOutput = await readLogTail(record.logPath, { maxBytes: 64_000 });
        const runnerReady = runningPattern.test(logOutput);
        if (record.messageApi?.enabled && record.messageApi.baseUrl) {
            const health = await pollMessageApiHealth(record.messageApi.baseUrl);
            if (runnerReady && health.ok) {
                return {
                    ready: true,
                    readiness: 'runner+message-api',
                    messageApi: health,
                };
            }
        } else if (runnerReady) {
            return {
                ready: true,
                readiness: 'runner-log',
            };
        }

        await delay(250);
    }

    const tail = await readLogTail(record.logPath);
    throw new Error(`Timed out waiting for agent readiness. Recent log output:\n${tail || '<empty>'}`);
}

async function getAgentRuntimeStatus(record) {
    if (!record?.pid) {
        return {
            running: false,
            pidAlive: false,
            ready: false,
            messageApiReady: false,
            record: record ?? null,
        };
    }

    const pidAlive = isProcessRunning(record.pid);
    let ready = pidAlive;
    let messageApiReady = false;
    let messageApiError;

    if (pidAlive && record.messageApi?.enabled && record.messageApi.baseUrl) {
        const health = await pollMessageApiHealth(record.messageApi.baseUrl);
        messageApiReady = health.ok;
        ready = ready && health.ok;
        messageApiError = health.ok ? undefined : health.error;
    }

    return {
        running: ready,
        pidAlive,
        ready,
        messageApiReady,
        messageApiError,
        record,
    };
}

async function startHarnessAgent({
    repoRootPath,
    agentRef,
    sessionPaths,
    runtimeContext,
    rpcUrl,
    signerRole,
    env = process.env,
    startTimeoutMs = DEFAULT_AGENT_START_TIMEOUT_MS,
}) {
    if (!repoRootPath) {
        throw new Error('startHarnessAgent requires repoRootPath.');
    }
    if (!agentRef) {
        throw new Error('startHarnessAgent requires agentRef.');
    }
    if (!sessionPaths?.files?.agentLog || !sessionPaths?.files?.overlay) {
        throw new Error('startHarnessAgent requires session paths with agent log and overlay files.');
    }
    if (!runtimeContext?.runtimeConfig) {
        throw new Error('startHarnessAgent requires a resolved runtime context.');
    }
    if (!rpcUrl) {
        throw new Error('startHarnessAgent requires rpcUrl.');
    }
    if (!signerRole?.privateKey || !signerRole?.address) {
        throw new Error('startHarnessAgent requires a signer role with address and privateKey.');
    }

    await mkdir(sessionPaths.sessionDir, { recursive: true });
    const nodeCommand = resolveNodeExecutable(env);
    const args = ['agent/src/index.js'];
    const childEnv = buildHarnessAgentChildEnv({
        env,
        agentRef,
        rpcUrl,
        signerRole,
        overlayPath: sessionPaths.files.overlay,
    });

    const logFd = openSync(sessionPaths.files.agentLog, 'a');
    let child;
    try {
        child = spawn(nodeCommand, args, {
            cwd: repoRootPath,
            env: childEnv,
            detached: true,
            stdio: ['ignore', logFd, logFd],
        });
    } finally {
        closeSync(logFd);
    }

    const record = {
        pid: child.pid,
        startedAt: new Date().toISOString(),
        command: nodeCommand,
        args,
        module: agentRef,
        rpcUrl,
        signerRole: signerRole.name,
        signerAddress: signerRole.address,
        overlayPath: sessionPaths.files.overlay,
        logPath: sessionPaths.files.agentLog,
        messageApi: runtimeContext.runtimeConfig.messageApiEnabled
            ? {
                  enabled: true,
                  host: runtimeContext.runtimeConfig.messageApiHost,
                  port: runtimeContext.runtimeConfig.messageApiPort,
                  baseUrl: formatMessageApiBaseUrl(
                      runtimeContext.runtimeConfig.messageApiHost,
                      runtimeContext.runtimeConfig.messageApiPort
                  ),
              }
            : {
                  enabled: false,
              },
    };

    const startupFailure = new Promise((_, reject) => {
        child.once('error', (error) => {
            reject(error);
        });
        child.once('exit', (code, signal) => {
            reject(
                new Error(
                    `Agent exited before it became ready (code=${code ?? 'null'} signal=${signal ?? 'null'}).`
                )
            );
        });
    });

    child.unref();

    try {
        await Promise.race([
            waitForAgentReady({
                record,
                timeoutMs: startTimeoutMs,
            }),
            startupFailure,
        ]);
        return record;
    } catch (error) {
        if (child.pid && isProcessRunning(child.pid)) {
            try {
                process.kill(child.pid, 'SIGINT');
                await waitForProcessExit(child.pid, 1_000);
            } catch {
                // Best-effort cleanup only.
            }
        }
        throw error;
    }
}

async function stopHarnessAgent(record, { timeoutMs = DEFAULT_AGENT_STOP_TIMEOUT_MS } = {}) {
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

    process.kill(record.pid, 'SIGINT');
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
    buildHarnessAgentChildEnv,
    DEFAULT_AGENT_START_TIMEOUT_MS,
    DEFAULT_AGENT_STOP_TIMEOUT_MS,
    formatMessageApiBaseUrl,
    getAgentRuntimeStatus,
    pollMessageApiHealth,
    readLogTail,
    resolveNodeExecutable,
    startHarnessAgent,
    stopHarnessAgent,
    waitForAgentReady,
    waitForLogPattern,
};
