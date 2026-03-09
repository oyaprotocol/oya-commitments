import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
    const include = [];
    const exclude = [];

    for (const arg of argv) {
        if (arg.startsWith('--include=')) {
            include.push(arg.slice('--include='.length));
            continue;
        }
        if (arg.startsWith('--exclude=')) {
            exclude.push(arg.slice('--exclude='.length));
            continue;
        }
        throw new Error(`Unsupported argument: ${arg}`);
    }

    return { include, exclude };
}

function matchesFilters(fileName, { include, exclude }) {
    if (include.length > 0 && !include.some((pattern) => fileName.includes(pattern))) {
        return false;
    }
    if (exclude.some((pattern) => fileName.includes(pattern))) {
        return false;
    }
    return true;
}

async function listTestScripts(filters) {
    const entries = await readdir(__dirname, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && /^test-.*\.mjs$/.test(entry.name))
        .map((entry) => entry.name)
        .filter((name) => matchesFilters(name, filters))
        .sort();
}

async function runScript(scriptName) {
    const scriptPath = path.join(__dirname, scriptName);
    process.stdout.write(`== agent/scripts/${scriptName} ==\n`);

    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath], {
            stdio: 'inherit',
            env: process.env,
        });
        child.on('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    signal
                        ? `${scriptName} terminated by signal ${signal}`
                        : `${scriptName} exited with code ${code}`
                )
            );
        });
        child.on('error', reject);
    });

    process.stdout.write('\n');
}

async function main() {
    const filters = parseArgs(process.argv.slice(2));
    const scripts = await listTestScripts(filters);

    if (scripts.length === 0) {
        throw new Error('No matching test scripts found.');
    }

    for (const scriptName of scripts) {
        await runScript(scriptName);
    }

    console.log(`[test] local agent scripts OK (${scripts.length} scripts)`);
}

main().catch((error) => {
    console.error('[test] local agent scripts failed:', error?.message ?? error);
    process.exit(1);
});
