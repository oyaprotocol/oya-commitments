import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { main } from '../scripts/local-node.mjs';

const script = fileURLToPath(new URL('../scripts/local-node.mjs', import.meta.url));
const production = fileURLToPath(new URL('../', import.meta.url));

async function directory(t) {
    const path = await mkdtemp(join(tmpdir(), 'oya-local-setup-'));
    t.after(() => rm(path, { recursive: true, force: true }));
    return path;
}

test('setup creates private templates relative to the caller and preserves edits on repetition', async (t) => {
    const cwd = await directory(t);
    const commands = [];
    const output = [];
    const options = { cwd, log: (line) => output.push(line), execute: async (command, args, settings) => {
        commands.push([command, args]);
        assert.equal(settings.cwd, fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, ''));
    } };
    const args = ['setup', '--config', 'config.json', '--env-file', 'node.env'];
    assert.equal(await main(args, options), 0);
    assert.deepEqual(commands, [
        ['npm', ['--prefix', 'node/production', 'ci']],
    ]);
    for (const [name, template] of [['config.json', 'config.example.json'], ['node.env', '.env.example']]) {
        const path = join(cwd, name);
        assert.equal(await readFile(path, 'utf8'), await readFile(join(production, template), 'utf8'));
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        await writeFile(path, `operator-edited-${name}`);
        await chmod(path, 0o400);
    }
    assert.equal(await main(args, options), 0);
    for (const name of ['config.json', 'node.env']) {
        const path = join(cwd, name);
        assert.equal(await readFile(path, 'utf8'), `operator-edited-${name}`);
        assert.equal((await stat(path)).mode & 0o777, 0o400);
    }
    assert.equal(output.some((line) => line.includes('operator-edited')), false);
});

test('setup stops on installation failure without exposing child output or creating files', async (t) => {
    const cwd = await directory(t);
    const output = [];
    let calls = 0;
    const result = await main(['setup', '--config', 'config.json', '--env-file', 'node.env'], {
        cwd, log: (line) => output.push(line), execute: async () => {
            calls += 1;
            throw new Error('https://registry.invalid/secret-marker');
        },
    });
    assert.equal(result, 1);
    assert.equal(calls, 1);
    assert.match(output.at(-1), /npm --prefix node\/production ci failed/);
    assert.equal(output.some((line) => line.includes('secret-marker')), false);
    for (const name of ['config.json', 'node.env']) {
        await assert.rejects(stat(join(cwd, name)), { code: 'ENOENT' });
    }
});

test('CLI help works from another directory and invalid arguments fail without echoing values', async (t) => {
    const cwd = await directory(t);
    const execute = promisify(execFile);
    // The separator in the npm entry prevents Node from consuming our --env-file option.
    const { stdout } = await execute('npm', [
        '--prefix', production, 'run', 'local', '--', '--help', '--env-file', 'missing.env',
    ], { cwd });
    assert.match(stdout, /Existing files are preserved/);
    await assert.rejects(execute(process.execPath, ['--', script, 'setup', '--secret-marker'], { cwd }), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /Invalid arguments/);
        assert.equal(`${error.stdout}${error.stderr}`.includes('secret-marker'), false);
        return true;
    });
});
