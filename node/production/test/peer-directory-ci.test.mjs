import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runtime = fileURLToPath(new URL('../', import.meta.url));
const registry = 'node/production/peers/testnet-directory.json';
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'oya-directory-git-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const local = join(root, 'node/production');
    for (const dir of ['scripts', 'src/peers', 'peers']) mkdirSync(join(local, dir), { recursive: true });
    for (const file of ['scripts/check-peer-directory.mjs', 'src/peers/directory.mjs']) cpSync(join(runtime, file), join(local, file));
    symlinkSync(join(runtime, 'node_modules'), join(local, 'node_modules'));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet'); git('config', 'user.name', 'Directory test'); git('config', 'user.email', 'directory-test@example.com');
    git('config', 'core.hooksPath', '/dev/null');
    const commit = () => { git('add', registry); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Snapshot'); return git('rev-parse', 'HEAD'); };
    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Empty base');
    const absent = git('rev-parse', 'HEAD');
    const raw = JSON.parse(readFileSync(join(runtime, 'peers/testnet-directory.json')));
    const write = value => writeFileSync(join(root, registry), typeof value === 'string' ? value : JSON.stringify(value));
    write(raw);
    const run = (...args) => spawnSync(process.execPath, [join(local, 'scripts/check-peer-directory.mjs'), ...args], {
        cwd: root, encoding: 'utf8', timeout: 5000,
    });
    return { root, raw, write, commit, absent, run, git };
}

test('release fallback passes a pinned parent base and rejects stale directory content', t => {
    const release = readFileSync(new URL('../../../.github/workflows/release-node.yml', import.meta.url), 'utf8');
    const workflow = readFileSync(new URL('../../../.github/workflows/test.yml', import.meta.url), 'utf8');
    assert.match(release, /directory_base: \$\{\{ steps\.directory-base\.outputs\.sha \}\}/);
    assert.match(release, /directory_base: \$\{\{ needs\.preflight\.outputs\.directory_base \}\}/);
    assert.match(workflow, /workflow_call:\n    inputs:\n      directory_base:\n        required: true\n        type: string/);
    assert.match(workflow, /DIRECTORY_BASE: \$\{\{ inputs\.directory_base \|\| github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/);
    const resolver = release.match(/id: directory-base\n        run: \|\n((?:          .*\n)+)/)?.[1].replace(/^          /gm, '');
    assert.ok(resolver, 'release preflight must resolve a full parent commit');
    const check = workflow.match(/DIRECTORY_BASE:.*\n        run: \|\n((?:          .*\n)+)/)?.[1].replace(/^          /gm, '');
    assert.ok(check);
    const f = fixture(t), base = f.commit();
    const candidate = { ...f.raw, nodes: [{ nodeAddress: '0x1111111111111111111111111111111111111111',
        receiveUrl: 'https://a.example/v1/jobs', target: 'a' }] };
    f.write(candidate); f.commit();
    const output = join(f.root, 'output');
    const resolved = spawnSync('bash', ['-e', '-c', resolver], { cwd: f.root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(readFileSync(output, 'utf8'), `sha=${base}\n`);
    const run = value => spawnSync('bash', ['-e', '-c', check], { cwd: f.root, encoding: 'utf8',
        env: { ...process.env, DIRECTORY_BASE: value } });
    assert.equal(run('').status, 0, 'manual schema-only validation alone misses stale content');
    const rejected = run(base);
    assert.equal(rejected.status, 1);
    assert.deepEqual(JSON.parse(rejected.stderr), { error: 'directory_revision_not_advanced' });
    candidate.revision = 2; f.write(candidate);
    assert.equal(run(base).status, 0);
    assert.equal(run('f'.repeat(40)).status, 1, 'unavailable base fails closed');
    f.git('checkout', '--', registry);
    f.git('checkout', '--detach', f.absent);
    assert.notEqual(spawnSync('bash', ['-e', '-c', resolver], { cwd: f.root,
        env: { ...process.env, GITHUB_OUTPUT: output } }).status, 0, 'missing parent fails preflight');
});

test('CI verifies first introduction and never treats missing/unavailable base as an empty registry', t => {
    const f = fixture(t);
    const result = f.run(f.absent);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).comparison, { initialDirectory: true });
    f.write({ ...f.raw, revision: 2 });
    assert.equal(f.run(f.absent).status, 1);
    f.write({ ...f.raw, nodes: [{ nodeAddress: '0x1111111111111111111111111111111111111111',
        receiveUrl: 'https://a.example/v1/jobs', target: 'a' }] });
    assert.equal(f.run(f.absent).status, 1);
    f.write(f.raw);
    const unavailable = f.run('f'.repeat(40));
    assert.equal(unavailable.status, 1);
    assert.deepEqual(JSON.parse(unavailable.stderr), { error: 'directory_base_unavailable' });
    assert.equal(unavailable.stdout, '');
    for (const bad of ['HEAD', '--help', 'a'.repeat(40) + '\n', 'a'.repeat(39), '$(touch nope)']) {
        assert.equal(f.run(bad).status, 2);
    }
    assert.equal(f.run(f.absent, f.absent).status, 2);
    assert.equal(f.run().status, 0); // Manual schema-only invocation is explicit.
});

test('CI rejects unbumped membership and deletion, then accepts a corrected higher revision', t => {
    const f = fixture(t), base = f.commit();
    assert.equal(f.run(base).status, 0);
    const candidate = { ...f.raw, nodes: [{ nodeAddress: '0x1111111111111111111111111111111111111111',
        receiveUrl: 'https://a.example/v1/jobs', target: 'a' }] };
    f.write(candidate);
    const rejected = f.run(base);
    assert.equal(rejected.status, 1);
    assert.deepEqual(JSON.parse(rejected.stderr), { error: 'directory_revision_not_advanced' });
    candidate.revision = 2; f.write(candidate);
    const accepted = f.run(base);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).comparison.added.length, 1);
    const enrolled = f.commit();
    f.write({ ...f.raw, revision: 2 });
    assert.equal(f.run(enrolled).status, 1, 'removal needs another revision');
    f.write({ ...f.raw, revision: 3 });
    assert.equal(f.run(enrolled).status, 0);
    rmSync(join(f.root, registry));
    assert.equal(f.run(base).status, 1, 'deleting the registry must fail');
    f.write(f.raw);
    assert.equal(f.run(base).status, 0, 'restored valid snapshot recovers');
});

test('CI rejects corrupt, oversized and symlink base data instead of bypassing revision checks', t => {
    const f = fixture(t);
    for (const bad of ['{"private-marker":', ' '.repeat(256 * 1024 + 1),
        JSON.stringify(f.raw).replace('"revision":1', '"revision":"private-marker","revision":1')]) {
        f.write(bad); const base = f.commit(); f.write(f.raw);
        const result = f.run(base);
        assert.equal(result.status, 1); assert.equal(result.stdout, '');
        assert.ok(!result.stderr.includes('private-marker'));
    }
    rmSync(join(f.root, registry)); symlinkSync('some-other-file', join(f.root, registry));
    const base = f.commit(); rmSync(join(f.root, registry)); f.write(f.raw);
    const result = f.run(base);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), { error: 'invalid_base_directory_mode' });
});
