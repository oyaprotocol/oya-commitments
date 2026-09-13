import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const production = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: npm --prefix node/production run local -- setup [--config <path>] [--env-file <path>]';

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
        log(`${usage}\nInstall locked dependencies and create missing private config files.\n`
            + 'Defaults: node/production/config.local.json and node/production/.env.\n'
            + 'Relative overrides use the directory where you invoked the command.\n'
            + 'Existing files are preserved. Exit status: 0 on success, 1 on failure.');
        return 0;
    }
    if (positionals.length !== 1 || positionals[0] !== 'setup'
        || [values.config, values['env-file']].some((value) => value !== undefined && !value.trim())) {
        return fail(invalidArguments);
    }
    const selectPath = (value, fallback) => value === undefined ? join(production, fallback) : resolve(cwd, value);
    const configPath = selectPath(values.config, 'config.local.json');
    const envPath = selectPath(values['env-file'], '.env');
    if (configPath === envPath) return fail(invalidArguments);
    if (Number(process.versions.node.split('.')[0]) < 22) return fail('Setup requires Node.js 22 or newer.');

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
