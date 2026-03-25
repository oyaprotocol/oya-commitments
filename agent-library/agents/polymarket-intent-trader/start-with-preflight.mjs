#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_MODULE = 'polymarket-intent-trader';
const DEFAULT_GEOBLOCK_URL = 'https://polymarket.com/api/geoblock';
const DEFAULT_TIMEOUT_MS = 10_000;

function parsePositiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function parseArgs(argv) {
    const separatorIndex = argv.indexOf('--');
    const optionArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
    const commandArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
    const options = {
        module:
            (process.env.AGENT_MODULE && process.env.AGENT_MODULE.trim()) || DEFAULT_MODULE,
        url:
            (process.env.POLYMARKET_GEOBLOCK_URL &&
                process.env.POLYMARKET_GEOBLOCK_URL.trim()) ||
            DEFAULT_GEOBLOCK_URL,
        timeoutMs:
            process.env.POLYMARKET_GEOBLOCK_TIMEOUT_MS &&
            process.env.POLYMARKET_GEOBLOCK_TIMEOUT_MS.trim()
                ? parsePositiveInteger(
                      process.env.POLYMARKET_GEOBLOCK_TIMEOUT_MS,
                      'POLYMARKET_GEOBLOCK_TIMEOUT_MS'
                  )
                : DEFAULT_TIMEOUT_MS,
        checkOnly: false,
    };

    for (const arg of optionArgs) {
        if (arg === '--check-only') {
            options.checkOnly = true;
            continue;
        }
        if (arg.startsWith('--module=')) {
            const value = arg.slice('--module='.length).trim();
            if (!value) {
                throw new Error('--module requires a non-empty value.');
            }
            options.module = value;
            continue;
        }
        if (arg.startsWith('--url=')) {
            const value = arg.slice('--url='.length).trim();
            if (!value) {
                throw new Error('--url requires a non-empty value.');
            }
            options.url = value;
            continue;
        }
        if (arg.startsWith('--timeout-ms=')) {
            options.timeoutMs = parsePositiveInteger(
                arg.slice('--timeout-ms='.length),
                '--timeout-ms'
            );
            continue;
        }
        throw new Error(
            `Unsupported argument: ${arg}\nUsage: node agent-library/agents/polymarket-intent-trader/start-with-preflight.mjs [--module=<name>] [--url=<geoblock-url>] [--timeout-ms=<ms>] [--check-only] [-- <command ...>]`
        );
    }

    return { options, commandArgs };
}

async function checkPolymarketGeoblock({ url, timeoutMs }) {
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `Geoblock request failed (${response.status} ${response.statusText}): ${body}`
        );
    }

    const payload = await response.json();
    if (typeof payload?.blocked !== 'boolean') {
        throw new Error(
            `Geoblock response missing boolean "blocked" field: ${JSON.stringify(payload)}`
        );
    }

    return payload;
}

function getDefaultCommand() {
    return [process.execPath, path.join(REPO_ROOT, 'agent/src/index.js')];
}

async function runCommand(commandArgs, env) {
    const [command, ...commandRest] =
        commandArgs.length > 0 ? commandArgs : getDefaultCommand();
    const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(command, commandRest, {
            stdio: 'inherit',
            env,
        });
        child.on('exit', (code, signal) => {
            if (signal) {
                resolve(1);
                return;
            }
            resolve(code ?? 1);
        });
        child.on('error', reject);
    });
    return exitCode;
}

async function main() {
    const { options, commandArgs } = parseArgs(process.argv.slice(2));
    const payload = await checkPolymarketGeoblock({
        url: options.url,
        timeoutMs: options.timeoutMs,
    });

    if (payload.blocked) {
        const message =
            typeof payload?.message === 'string' && payload.message.trim()
                ? payload.message.trim()
                : 'Polymarket reports this connection as geoblocked.';
        console.error(`[preflight] ${message}`);
        process.exitCode = 1;
        return;
    }

    console.log(
        `[preflight] Polymarket geoblock check passed for module ${options.module}.`
    );

    if (options.checkOnly) {
        return;
    }

    const exitCode = await runCommand(commandArgs, {
        ...process.env,
        AGENT_MODULE: options.module,
    });
    process.exitCode = exitCode;
}

main().catch((error) => {
    console.error('[preflight] failed:', error?.message ?? error);
    process.exit(1);
});
