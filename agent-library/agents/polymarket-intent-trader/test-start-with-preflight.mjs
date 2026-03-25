import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.join(__dirname, 'start-with-preflight.mjs');

function buildDataUrl(payload) {
    return `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`;
}

async function runScript(args, env = {}) {
    return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
            env: {
                ...process.env,
                ...env,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            resolve({
                code,
                stdout,
                stderr,
            });
        });
    });
}

async function run() {
    {
        const result = await runScript([
            '--check-only',
            `--url=${buildDataUrl({ blocked: false })}`,
        ]);
        assert.equal(result.code, 0);
        assert.match(result.stdout, /geoblock check passed/i);
    }

    {
        const result = await runScript([
            '--check-only',
            `--url=${buildDataUrl({ blocked: true, message: 'Blocked for test coverage.' })}`,
        ]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /blocked for test coverage/i);
    }

    {
        const result = await runScript([
            `--url=${buildDataUrl({ blocked: false })}`,
            '--',
            process.execPath,
            '-e',
            'process.stdout.write(process.env.AGENT_MODULE || "")',
        ]);
        assert.equal(result.code, 0);
        assert.match(result.stdout, /polymarket-intent-trader/);
    }

    console.log('[test] polymarket preflight wrapper OK');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
