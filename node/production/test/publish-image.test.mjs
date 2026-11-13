import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { imageRepository, readAssets, releaseNotes, releaseVersion } from '../scripts/release-node.mjs';

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
    for (const name of ['src', 'docker', 'inbox', 'peers', 'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json',
        'compose.yaml', 'README.md', 'deploy-droplet.md', 'deploy-with-agent.md', 'run-locally.md', 'run-direct.md', 'host-inbox.md', 'inbox-api.md', 'release-image.md', 'testnet-ledger.md', 'upgrade-node.md']) {
        cpSync(join(runtime, name), join(source, name), { recursive: true });
    }
    for (const name of ['publish-image.sh', 'deploy-droplet.sh', 'deploy-droplet-remote.sh', 'keychain-worker.py', 'upgrade-node.py']) {
        cpSync(join(runtime, 'scripts', name), join(source, 'scripts', name));
    }
    const agent = 'agent-library/agents/hourly-message-test/agent.mjs';
    mkdirSync(join(checkout, 'agent-library/agents/hourly-message-test'), { recursive: true });
    cpSync(join(runtime, '../..', agent), join(checkout, agent));
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

test('stages the source archive before extraction instead of piping git into an early-closing tar', (t) => {
    const f = fixture(t);
    const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(f.directory, 'bin/git'), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
// Reproduce the producer failure when a tar reader closes before git drains.
if (args.includes('archive') && !args.some(arg => arg.startsWith('--output='))) process.exit(141);
const child = spawnSync(${JSON.stringify(git)}, args, { stdio: 'inherit' });
process.exit(child.status ?? 1);
`, { mode: 0o755 });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(f.output, 'oya-node-v0.1.0.tar.gz')));
});

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
    assert.deepEqual(readdirSync(f.output).sort(), ['build.json', 'image.txt', 'oya-node-v0.1.0.tar.gz', 'release.txt']);
    assert.equal(readFileSync(join(f.output, 'image.txt'), 'utf8'), `${repository}@${digest}\n`);
    assert.ok(readFileSync(join(f.output, 'release.txt'), 'utf8').includes(f.git('rev-parse', 'HEAD')));
    const unpacked = join(f.directory, 'unpacked');
    const privateDirectory = join(f.directory, 'operator-private');
    mkdirSync(unpacked);
    // Match the documented extraction command while retaining the operator's private umask.
    execFileSync('sh', ['-ec', `
umask 077
tar -xzpf "$1" -C "$2"
mkdir "$3"
: > "$3/node.env"
`, 'extract-bundle', join(f.output, 'oya-node-v0.1.0.tar.gz'), unpacked, privateDirectory]);
    const bundle = join(unpacked, 'node/production');
    for (const file of ['docker/Caddyfile', 'inbox/Caddyfile']) {
        assert.equal(statSync(join(bundle, file)).mode & 0o777, 0o644,
            'Hardened Caddy must be able to read its configuration after a non-root operator extracts the bundle.');
    }
    for (const path of [unpacked, join(unpacked, 'node'), bundle, join(bundle, 'inbox'), join(bundle, 'docker'),
        join(unpacked, 'agent-library'), join(unpacked, 'agent-library/agents'), join(unpacked, 'agent-library/agents/hourly-message-test')]) {
        assert.equal(statSync(path).mode & 0o777, 0o755, 'Public bundle directories must allow traversal.');
    }
    assert.equal(statSync(f.output).mode & 0o777, 0o700, 'The operator release output directory stays private.');
    assert.equal(statSync(privateDirectory).mode & 0o777, 0o700, 'Subsequent private directories retain the operator umask.');
    assert.equal(statSync(join(privateDirectory, 'node.env')).mode & 0o777, 0o600, 'Subsequent private files retain the operator umask.');
    assert.deepEqual(readdirSync(bundle).sort(), ['README.md', 'compose.yaml', 'deploy-droplet.md', 'deploy-with-agent.md', 'docker', 'host-inbox.md', 'image.txt',
        'inbox', 'inbox-api.md', 'peers', 'release-image.md', 'run-direct.md', 'run-locally.md', 'scripts', 'testnet-ledger.md', 'upgrade-node.md']);
    assert.deepEqual(readdirSync(join(bundle, 'inbox')).sort(), ['Caddyfile', 'compose.https.yaml', 'compose.keychain-worker.yaml', 'compose.postgres.yaml',
        'compose.worker.yaml', 'compose.yaml', 'inbox.example.json', 'worker.example.json']);
    assert.deepEqual(readdirSync(join(bundle, 'scripts')).sort(), ['deploy-droplet-remote.sh', 'deploy-droplet.sh', 'keychain-worker.py', 'upgrade-node.py']);
    assert.deepEqual(readdirSync(join(bundle, 'docker')).sort(), ['Caddyfile', 'compose.http.yaml', 'compose.testing.yaml', 'config.example.json', 'runtime.env.example']);
    const directoryBytes = readFileSync(join(bundle, 'peers/testnet-directory.json'));
    assert.deepEqual(directoryBytes, readFileSync(join(f.source, 'peers/testnet-directory.json')));
    assert.deepEqual(JSON.parse(readFileSync(join(bundle, 'peers/snapshot.json'))), {
        version: 1, sourceCommit: f.git('rev-parse', 'HEAD'),
        directoryRevision: JSON.parse(directoryBytes).revision,
        fileSha256: createHash('sha256').update(directoryBytes).digest('hex'),
    });
    assert.deepEqual(readdirSync(join(bundle, 'peers')).sort(), ['README.md', 'snapshot.json', 'testnet-directory.json']);
    assert.equal(statSync(join(bundle, 'peers/testnet-directory.json')).mode & 0o777, 0o644);
    const nodeDefaults = JSON.parse(readFileSync(join(bundle, 'docker/config.example.json')));
    const inboxDefaults = JSON.parse(readFileSync(join(bundle, 'inbox/inbox.example.json'))).execution;
    for (const config of [nodeDefaults, inboxDefaults]) {
        assert.equal(config.mode, 'ledger');
        assert.equal(config.chainId, 11155111);
        assert.equal(config.ledgerContract, '0xe6DeB4B3c31E15DBeA0f932830e2f20Ba2EddAa3');
    }
    assert.equal(nodeDefaults.rpcUrl, 'https://ethereum-sepolia-rpc.publicnode.com');
    assert.equal(inboxDefaults.nodeAddress, 'REPLACE_WITH_PUBLIC_NODE_ADDRESS');
    for (const name of ['run-locally.md', 'host-inbox.md']) {
        const guide = readFileSync(join(bundle, name), 'utf8');
        assert.ok(guide.includes('export OYA_NODE_RELEASE="node-v0.1.0"'));
        assert.ok(guide.includes('/releases/tag/node-v0.1.0)'));
        assert.ok(!guide.includes('/releases/latest'));
        assert.ok(guide.includes('node-v0.2.0') || guide.includes('v0.2.0'), 'Historical compatibility must be preserved.');
    }
    const agent = 'agent-library/agents/hourly-message-test/agent.mjs';
    assert.equal(statSync(join(unpacked, agent)).mode & 0o777, 0o644, 'The container user must be able to read the mounted agent source.');
    assert.equal(readFileSync(join(unpacked, agent), 'utf8'), readFileSync(join(f.checkout, agent), 'utf8'));
    assert.equal(readFileSync(join(bundle, 'image.txt'), 'utf8'), `${repository}@${digest}\n`);
    for (const name of ['deploy-droplet.sh', 'deploy-droplet-remote.sh', 'keychain-worker.py', 'upgrade-node.py']) {
        assert.equal(readFileSync(join(bundle, 'scripts', name), 'utf8'), readFileSync(join(f.source, 'scripts', name), 'utf8'));
    }
    assert.equal((result.stdout + result.stderr).includes('private-fixture-marker'), false);
    assert.notEqual(f.run().status, 0, 'must not overwrite previous release output');
});

test('dry run loads the image locally, preserves build metadata, and never pushes', (t) => {
    const f = fixture(t);
    const result = f.run('', [repository, 'node-v0.1.0', f.output, '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(join(f.directory, 'commands.json')));
    assert.ok(args.includes('--load'));
    assert.ok(!args.includes('--push'));
    assert.equal(JSON.parse(readFileSync(join(f.output, 'build.json')))['containerimage.digest'], digest);
    assert.ok(result.stdout.includes('no image was pushed'));
});

test('published and dry-run bundles pass the strict upgrade release verifier', async (t) => {
    for (const dryRun of [false, true]) {
        await t.test(dryRun ? 'dry run' : 'publish', (t) => {
            const f = fixture(t);
            const tar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
            writeFileSync(join(f.directory, 'bin/tar'), `#!${process.execPath}
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2);
// Force macOS metadata on a staged public file, without touching the checkout.
if (process.platform === 'darwin' && args.includes('-czf')) {
    execFileSync('xattr', ['-w', 'com.oya.release-test', 'metadata must stay local',
        join(args[args.indexOf('-C') + 1], 'node/production/README.md')]);
}
const child = spawnSync(${JSON.stringify(tar)}, args, { stdio: 'inherit' });
process.exit(child.status ?? 1);
`, { mode: 0o755 });
            const result = f.run('', [imageRepository, 'node-v0.1.0', f.output, ...(dryRun ? ['--dry-run'] : [])]);
            assert.equal(result.status, 0, result.stderr);
            const release = { ...releaseVersion('0.1.0'), sha: f.git('rev-parse', 'HEAD') };
            const records = readAssets(f.output, release);
            const metadata = {
                tag_name: release.tag, draft: false, prerelease: false,
                body: releaseNotes(release, records, 'Fixture changes.', '', dryRun),
                assets: records.assets.map(asset => ({
                    name: asset.name, size: asset.bytes.length, digest: asset.digest,
                    browser_download_url: `https://github.com/oyaprotocol/oya-commitments/releases/download/${release.tag}/${asset.name}`,
                })),
            };
            const responseFile = join(f.directory, 'release-responses.json');
            writeFileSync(responseFile, JSON.stringify({
                metadata, commit: release.sha, tagObject: f.git('rev-parse', `refs/tags/${release.tag}`),
            }));
            // Only network responses are substituted; verify actual publisher bytes,
            // generated notes, annotated-tag binding, extraction and packaged assets.
            const checked = spawnSync('python3', ['-B', '-c', `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('upgrade', sys.argv[1])
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)
output, response_file, destination = map(Path, sys.argv[2:])
fixture = json.loads(response_file.read_text())
metadata = fixture['metadata']
tag = metadata['tag_name']
api = 'https://api.github.com/repos/' + upgrade.REPOSITORY
responses = {
    api + '/releases/tags/' + tag: json.dumps(metadata).encode(),
    api + '/git/ref/tags/' + tag: json.dumps({'ref': 'refs/tags/' + tag,
        'object': {'type': 'tag', 'sha': fixture['tagObject']}}).encode(),
    api + '/git/tags/' + fixture['tagObject']: json.dumps({'sha': fixture['tagObject'],
        'object': {'type': 'commit', 'sha': fixture['commit']}}).encode(),
}
responses.update({asset['browser_download_url']: (output / asset['name']).read_bytes()
                  for asset in metadata['assets']})
def fetch(url, limit, headers=None):
    data = responses[url]
    assert len(data) <= limit
    return data
upgrade.fetch = fetch
destination.mkdir()
release = upgrade.release_assets(tag, destination)
assert release['tag'] == tag and release['commit'] == fixture['commit']
assert release['image'] == (output / 'image.txt').read_text().strip()
bundle = Path(release['bundle'])
files = {p.relative_to(bundle).as_posix() for p in bundle.rglob('*') if p.is_file()}
assert files == set(upgrade.PUBLIC_FILES), files
assert (bundle / 'node/production/scripts/upgrade-node.py').read_bytes() == Path(sys.argv[1]).read_bytes()
`, join(f.source, 'scripts/upgrade-node.py'), f.output, responseFile, join(f.directory, 'verified')], {
                encoding: 'utf8', timeout: 20_000,
            });
            assert.equal(checked.status, 0, checked.stderr);
        });
    }
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
            assert.deepEqual(readdirSync(f.output), mode === 'build' ? [] : ['build.json']);
        });
    }
});
