import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const production = join(root, 'node/production');
const usage = 'Usage: npm --prefix node/production run local -- setup [--config <path>] [--env-file <path>]';

export async function main(args, {
    cwd = process.env.INIT_CWD ?? process.cwd(), execute = promisify(execFile), log = console.log,
} = {}) {
    let failure = `Invalid arguments. ${usage}`;
    try {
        const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
            config: { type: 'string' }, 'env-file': { type: 'string' }, help: { type: 'boolean' },
        } });
        if (values.help) {
            log(`${usage}\nInstall locked dependencies and create missing private config files.\n`
                + 'Defaults: node/production/config.local.json and node/production/.env.\n'
                + 'Relative overrides use the directory where you invoked the command.\n'
                + 'Existing files are preserved. Exit status: 0 on success, 1 on failure.');
            return 0;
        }
        if (positionals.length !== 1 || positionals[0] !== 'setup') throw new Error();
        const selectPath = (value, fallback) => {
            if (value !== undefined && !value.trim()) throw new Error();
            return value === undefined ? join(production, fallback) : resolve(cwd, value);
        };
        const configPath = selectPath(values.config, 'config.local.json');
        const envPath = selectPath(values['env-file'], '.env');
        if (configPath === envPath) throw new Error();

        failure = 'Setup requires Node.js 22 or newer.';
        if (Number(process.versions.node.split('.')[0]) < 22) throw new Error();
        const command = ['--prefix', 'node/production', 'ci'];
        const label = `npm ${command.join(' ')}`;
        failure = `${label} failed. Check npm access, then rerun setup.`;
        log(`Running ${label}`);
        // Capture child output: package manager failures can contain registry credentials.
        await execute('npm', command, { cwd: root });
        for (const [template, destination] of [
            ['config.example.json', configPath], ['.env.example', envPath],
        ]) {
            failure = `Could not prepare ${template}. Check destination directories and file permissions.`;
            const contents = await readFile(join(production, template));
            let created = false;
            try {
                await writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
                created = true;
            } catch (error) {
                if (error.code !== 'EEXIST' || !(await lstat(destination)).isFile()) throw error;
            }
            log(`${created ? 'Created' : 'Preserved'} ${destination}`);
        }
        log('Setup complete. Configure chainId, loggerContract, allowedSigners, rpcUrl, ipfsUrl, and OYA_NODE_PRIVATE_KEY before starting the node.');
        return 0;
    } catch {
        // Never print raw filesystem, argument-parser, or package manager errors.
        log(failure);
        return 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    process.exitCode = await main(process.argv.slice(2));
}
