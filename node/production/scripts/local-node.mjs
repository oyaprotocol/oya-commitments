import { execFile } from 'node:child_process';
import { lstat, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const production = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: npm --prefix node/production run local -- <setup|check> [--config <path>] [--env-file <path>]';

async function sameFile(left, right) {
    try {
        const [leftFile, rightFile] = await Promise.all([stat(left, { bigint: true }), stat(right, { bigint: true })]);
        return leftFile.dev === rightFile.dev && leftFile.ino === rightFile.ino;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function prepareTemplate(template, destination) {
    const contents = await readFile(join(production, template));
    try {
        await writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
        return 'Created';
    } catch (error) {
        if (error.code === 'EEXIST' && (await lstat(destination)).isFile()) return 'Preserved';
        throw error;
    }
}

export async function main(args, {
    cwd = process.env.INIT_CWD ?? process.cwd(), execute = promisify(execFile), log = console.log,
} = {}) {
    const fail = (message) => {
        log(message);
        return 1;
    };
    const invalidArguments = `Invalid arguments. ${usage}`;
    let parsed;
    try {
        parsed = parseArgs({ args, allowPositionals: true, options: {
            config: { type: 'string' }, 'env-file': { type: 'string' }, help: { type: 'boolean' },
        } });
    } catch {
        return fail(invalidArguments);
    }
    const { values, positionals } = parsed;
    if (values.help) {
        log(`${usage}\nsetup: Install locked dependencies and create missing private config files.\n`
            + 'check: Load settings and check Ethereum, Logger, gas balance, and IPFS without writes.\n'
            + 'Defaults: node/production/config.local.json and node/production/.env.\n'
            + 'Relative overrides use the directory where you invoked the command.\n'
            + 'Existing files are preserved. Exit status: 0 on success, 1 on failure.');
        return 0;
    }
    if (positionals.length !== 1 || !['setup', 'check'].includes(positionals[0])
        || [values.config, values['env-file']].some((value) => value !== undefined && !value.trim())) {
        return fail(invalidArguments);
    }
    const selectPath = (value, fallback) => value === undefined ? join(production, fallback) : resolve(cwd, value);
    const configPath = selectPath(values.config, 'config.local.json');
    const envPath = selectPath(values['env-file'], '.env');
    const destinationConflict = 'Config and environment paths must refer to different files.';
    if (configPath === envPath) return fail(destinationConflict);
    if (Number(process.versions.node.split('.')[0]) < 22) return fail('Local commands require Node.js 22 or newer.');
    try {
        if (await sameFile(configPath, envPath)) return fail(destinationConflict);
    } catch {
        return fail('Could not check config and environment paths. Check directories and file permissions.');
    }

    if (positionals[0] === 'check') {
        try {
            const { checkLocalNode } = await import('./local-check.mjs');
            return await checkLocalNode(configPath, envPath, { log });
        } catch {
            return fail('Check could not run. Run local setup and verify the selected settings.');
        }
    }

    log('Running npm ci');
    try {
        // Capture child output: package manager failures can contain registry credentials.
        await execute('npm', ['ci'], { cwd: production });
    } catch {
        return fail('npm ci failed. Check npm access, then rerun setup.');
    }
    for (const [template, destination] of [
        ['config.example.json', configPath], ['.env.example', envPath],
    ]) {
        try {
            const result = await prepareTemplate(template, destination);
            // Previously missing paths may now resolve to the same newly created file.
            if (await sameFile(configPath, envPath)) return fail(destinationConflict);
            log(`${result} ${destination}`);
        } catch {
            return fail(`Could not prepare ${template}. Check destination directories and file permissions.`);
        }
    }
    log('Setup complete. Configure chainId, loggerContract, allowedSigners, rpcUrl, ipfsUrl, and OYA_NODE_PRIVATE_KEY before starting the node.');
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    process.exitCode = await main(process.argv.slice(2));
}
