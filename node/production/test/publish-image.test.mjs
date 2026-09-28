import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runtime = fileURLToPath(new URL('../', import.meta.url));
const digest = `sha256:${'b'.repeat(64)}`;
const repository = 'ghcr.io/example/oya-node';

function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'oya-release-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const checkout = join(directory, 'checkout');
    const source = join(checkout, 'node/production');
    const output = join(directory, 'release output');
    const bin = join(directory, 'bin');
    mkdirSync(join(source, 'scripts'), { recursive: true });
    mkdirSync(bin);
    for (const name of ['src', 'docker', 'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json',
        'compose.yaml', 'README.md', 'deploy-droplet.md', 'release-image.md']) {
        cpSync(join(runtime, name), join(source, name), { recursive: true });
    }
    for (const name of ['publish-image.sh', 'deploy-droplet.sh', 'deploy-droplet-remote.sh']) {
        cpSync(join(runtime, 'scripts', name), join(source, 'scripts', name));
    }
    writeFileSync(join(checkout, '.gitignore'), 'node.env\nnode.json\n');
    const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'Release test');
    git('config', 'user.email', 'release-test@example.com');
    git('config', 'core.hooksPath', '/dev/null');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture release');
    git('-c', 'tag.gpgsign=false', 'tag', '-a', 'node-v0.1.0', '-m', 'Fixture version');
    writeFileSync(join(source, 'node.env'), 'private-fixture-marker');
    writeFileSync(join(source, 'node.json'), '{}');
    writeFileSync(join(bin, 'docker'), `#!${process.execPath}
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] !== 'buildx' || args[1] !== 'build') throw new Error('Unexpected Docker command');
writeFileSync(process.env.TEST_LOG, JSON.stringify(args));
const source = args.at(-1);
if (existsSync(join(source, 'node.env')) || existsSync(join(source, 'node.json'))) throw new Error('Private input entered build context');
for (const name of ['package.json', 'src/main.mjs']) {
    if ((statSync(join(source, name)).mode & 0o777) !== 0o644) throw new Error('Image source must remain readable by the non-root runtime');
}
writeFileSync(process.env.TEST_SOURCE, readFileSync(join(source, 'src/main.mjs')));
if (process.env.TEST_MODE === 'build') process.exit(1);
const digest = process.env.TEST_MODE === 'bad-digest' ? 'sha256:bad' : ${JSON.stringify(digest)};
const metadata = process.env.TEST_MODE === 'missing-digest' ? {} : { 'containerimage.digest': digest };
writeFileSync(args[args.indexOf('--metadata-file') + 1], JSON.stringify(metadata));
`, { mode: 0o755 });
    const run = (mode = '', args = [repository, 'node-v0.1.0', output]) => spawnSync('bash', [join(source, 'scripts/publish-image.sh'), ...args], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_MODE: mode,
            TEST_LOG: join(directory, 'commands.json'), TEST_SOURCE: join(directory, 'build-source.mjs') },
        encoding: 'utf8', timeout: 20_000,
    });
    return { directory, checkout, source, output, git, run };
}

test('publishes committed source and bundles matching scripts with this build’s digest', (t) => {
    const f = fixture(t);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(join(f.directory, 'commands.json')));
    assert.ok(args.includes('--push'));
    assert.equal(args[args.indexOf('--platform') + 1], 'linux/amd64');
    assert.equal(args[args.indexOf('--tag') + 1], `${repository}:v0.1.0`);
    assert.ok(args.includes(`org.opencontainers.image.revision=${f.git('rev-parse', 'HEAD')}`));
    assert.equal(readFileSync(join(f.directory, 'build-source.mjs'), 'utf8'), readFileSync(join(runtime, 'src/main.mjs'), 'utf8'));
    assert.deepEqual(readdirSync(f.output).sort(), ['image.txt', 'oya-node-v0.1.0.tar.gz', 'release.txt']);
    assert.equal(readFileSync(join(f.output, 'image.txt'), 'utf8'), `${repository}@${digest}\n`);
    assert.ok(readFileSync(join(f.output, 'release.txt'), 'utf8').includes(f.git('rev-parse', 'HEAD')));
    const unpacked = join(f.directory, 'unpacked');
    mkdirSync(unpacked);
    execFileSync('tar', ['-xzf', join(f.output, 'oya-node-v0.1.0.tar.gz'), '-C', unpacked]);
    const bundle = join(unpacked, 'node/production');
    assert.deepEqual(readdirSync(bundle).sort(), ['README.md', 'compose.yaml', 'deploy-droplet.md', 'docker', 'image.txt', 'release-image.md', 'scripts']);
    assert.deepEqual(readdirSync(join(bundle, 'scripts')).sort(), ['deploy-droplet-remote.sh', 'deploy-droplet.sh']);
    assert.deepEqual(readdirSync(join(bundle, 'docker')).sort(), ['Caddyfile', 'compose.http.yaml', 'config.example.json', 'runtime.env.example']);
    assert.equal(readFileSync(join(bundle, 'image.txt'), 'utf8'), `${repository}@${digest}\n`);
    for (const name of ['deploy-droplet.sh', 'deploy-droplet-remote.sh']) {
        assert.equal(readFileSync(join(bundle, 'scripts', name), 'utf8'), readFileSync(join(f.source, 'scripts', name), 'utf8'));
    }
    assert.equal((result.stdout + result.stderr).includes('private-fixture-marker'), false);
    assert.notEqual(f.run().status, 0, 'must not overwrite previous release output');
});

test('rejects dirty source, mismatched or missing tags, and unsafe publication arguments before Docker', async (t) => {
    for (const mode of ['tracked', 'untracked', 'tag-mismatch', 'missing-tag', 'repository', 'version', 'inside-checkout']) {
        await t.test(mode, (t) => {
            const f = fixture(t);
            const args = [repository, 'node-v0.1.0', f.output];
            if (mode === 'tracked') writeFileSync(join(f.source, 'src/main.mjs'), '// pending edit\n');
            if (mode === 'untracked') writeFileSync(join(f.checkout, 'notes.txt'), 'pending review');
            if (mode === 'tag-mismatch') f.git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'Later commit');
            if (mode === 'missing-tag') args[1] = 'node-v0.2.0';
            if (mode === 'repository') args[0] = `${repository};exit`;
            if (mode === 'version') args[1] = 'latest';
            if (mode === 'inside-checkout') args[2] = join(f.checkout, 'release');
            assert.notEqual(f.run('', args).status, 0);
            assert.equal(existsSync(join(f.directory, 'commands.json')), false);
        });
    }
});

test('failed push or invalid metadata leaves no deployment bundle', async (t) => {
    for (const mode of ['build', 'bad-digest', 'missing-digest']) {
        await t.test(mode, (t) => {
            const f = fixture(t);
            assert.notEqual(f.run(mode).status, 0);
            assert.deepEqual(readdirSync(f.output), []);
        });
    }
});
