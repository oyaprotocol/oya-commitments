import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
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
        'compose.yaml', 'README.md', 'gas-policy.md', 'operator-status.md', 'operator.example.json', 'batch-logging.md', 'deploy-droplet.md', 'deploy-with-agent.md', 'run-locally.md', 'run-direct.md', 'host-inbox.md', 'inbox-api.md', 'release-image.md', 'testnet-ledger.md', 'upgrade-node.md']) {
        cpSync(join(runtime, name), join(source, name), { recursive: true });
    }
    for (const name of ['publish-image.sh', 'deploy-droplet.sh', 'deploy-droplet-remote.sh', 'keychain-worker.py', 'upgrade-node.py', 'peer-directory.mjs', 'gas-policy.mjs', 'operator-balance.mjs', 'operator-node.mjs', 'operator-profile.mjs', 'operator-status.mjs', 'operator-view.mjs']) {
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
    assert.equal(readFileSync(join(bundle, 'peers/receive.md'), 'utf8'), readFileSync(join(runtime, 'peers/receive.md'), 'utf8'));
    assert.equal(readFileSync(join(bundle, 'peers/send.md'), 'utf8'), readFileSync(join(runtime, 'peers/send.md'), 'utf8'));
    assert.equal(readFileSync(join(bundle, 'inbox/compose.peers.yaml'), 'utf8'), readFileSync(join(runtime, 'inbox/compose.peers.yaml'), 'utf8'));
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
    assert.deepEqual(readdirSync(bundle).sort(), ['README.md', 'batch-logging.md', 'compose.yaml', 'deploy-droplet.md', 'deploy-with-agent.md', 'docker', 'gas-policy.md', 'host-inbox.md', 'image.txt',
        'inbox', 'inbox-api.md', 'operator-status.md', 'operator.example.json', 'peers', 'release-image.md', 'run-direct.md', 'run-locally.md', 'scripts', 'src', 'testnet-ledger.md', 'upgrade-node.md']);
    assert.deepEqual(readdirSync(join(bundle, 'inbox')).sort(), ['Caddyfile', 'compose.https.yaml', 'compose.keychain-worker.yaml', 'compose.peers.yaml', 'compose.postgres.yaml',
        'compose.worker.yaml', 'compose.yaml', 'inbox.example.json', 'worker.example.json']);
    assert.deepEqual(readdirSync(join(bundle, 'scripts')).sort(), ['deploy-droplet-remote.sh', 'deploy-droplet.sh', 'gas-policy.mjs', 'keychain-worker.py', 'operator-balance.mjs', 'operator-node.mjs', 'operator-profile.mjs', 'operator-status.mjs', 'operator-view.mjs', 'peer-directory.mjs', 'upgrade-node.py']);
    assert.deepEqual(readdirSync(join(bundle, 'docker')).sort(), ['Caddyfile', 'compose.http.yaml', 'compose.testing.yaml', 'config.example.json', 'runtime.env.example']);
    const directoryBytes = readFileSync(join(bundle, 'peers/testnet-directory.json'));
    assert.deepEqual(directoryBytes, readFileSync(join(f.source, 'peers/testnet-directory.json')));
    assert.deepEqual(readdirSync(join(bundle, 'peers')).sort(), ['README.md', 'receive.md', 'send.md', 'testnet-directory.json']);
    const listed = spawnSync(process.execPath, [join(bundle, 'scripts/peer-directory.mjs')], {
        cwd: f.directory, encoding: 'utf8',
    });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), JSON.parse(directoryBytes));
    assert.equal(statSync(join(bundle, 'peers/testnet-directory.json')).mode & 0o777, 0o644);
    assert.deepEqual(readdirSync(join(bundle, 'src')).sort(), ['defaults.mjs', 'gas-policy.mjs', 'health.mjs', 'public-settings.mjs']);
    assert.equal(existsSync(join(bundle, 'node_modules')), false);
    const gas = spawnSync(process.execPath, [join(bundle, 'scripts/gas-policy.mjs'),
        '--config', join(bundle, 'docker/config.example.json'), '--json'], {
        cwd: f.directory, encoding: 'utf8', env: { PATH: '' },
    });
    assert.equal(gas.status, 0, gas.stderr);
    assert.equal(JSON.parse(gas.stdout).executionGasCeilingWei, '6000000000000000');
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
    for (const name of ['deploy-droplet.sh', 'deploy-droplet-remote.sh', 'keychain-worker.py', 'upgrade-node.py', 'peer-directory.mjs', 'gas-policy.mjs', 'operator-balance.mjs', 'operator-node.mjs', 'operator-profile.mjs', 'operator-status.mjs', 'operator-view.mjs']) {
        assert.equal(readFileSync(join(bundle, 'scripts', name), 'utf8'), readFileSync(join(f.source, 'scripts', name), 'utf8'));
    }
    assert.equal((result.stdout + result.stderr).includes('private-fixture-marker'), false);
    assert.notEqual(f.run().status, 0, 'must not overwrite previous release output');
});

test('runtime image allowlist includes shared public health dependencies', () => {
    const rules = readFileSync(join(runtime, '.dockerignore'), 'utf8').split('\n');
    for (const path of ['src/defaults.mjs', 'src/public-settings.mjs', 'src/health.mjs']) {
        assert.ok(rules.includes(`!${path}`), `${path} must be shipped to the runtime image`);
    }
});

test('extracted operator CLI works with no checkout, npm dependencies, Docker or secrets', async t => {
    const f = fixture(t);
    const published = f.run('', [repository, 'node-v0.1.0', f.output, '--dry-run']);
    assert.equal(published.status, 0, published.stderr);
    const unpacked = join(f.directory, 'standalone');
    mkdirSync(unpacked);
    execFileSync('tar', ['-xzpf', join(f.output, 'oya-node-v0.1.0.tar.gz'), '-C', unpacked]);
    rmSync(f.checkout, { recursive: true, force: true });
    const bundle = join(unpacked, 'node/production');
    assert.equal(existsSync(join(bundle, 'node_modules')), false);
    assert.deepEqual(readdirSync(join(bundle, 'src')).sort(), ['defaults.mjs', 'gas-policy.mjs', 'health.mjs', 'public-settings.mjs']);
    const privateDir = join(f.directory, 'private-profile');
    mkdirSync(privateDir, { mode: 0o700 });
    const nodeAddress = '0x2222222222222222222222222222222222222222';
    const ledgerContract = '0x1111111111111111111111111111111111111111';
    let health;
    const server = createServer((_req, res) => { res.end(JSON.stringify(health)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    for (const role of ['direct', 'worker']) for (const mode of ['ledger', 'ipfs']) {
        const identity = mode === 'ledger' ? { mode, chainId: 31337, ledgerContract, nodeAddress } : { mode };
        health = { ...identity, ...(role === 'worker'
            ? { role, target: 'test', status: 'idle', lastPollAt: new Date().toISOString() } : { status: 'ready', busy: false }) };
        const config = mode === 'ledger' ? { mode, chainId: 31337, ledgerContract } : { mode };
        writeFileSync(join(privateDir, 'node.json'), JSON.stringify(config));
        writeFileSync(join(privateDir, 'worker.json'), JSON.stringify({ target: 'test' }));
        const profile = { version: 1, role, nodeConfig: 'node.json', healthUrl: `http://127.0.0.1:${server.address().port}/healthz`,
            ...(mode === 'ledger' ? { nodeAddress } : {}), ...(role === 'worker' ? { workerConfig: 'worker.json' } : {}) };
        writeFileSync(join(privateDir, 'operator.json'), JSON.stringify(profile), { mode: 0o600 });
        const result = await promisify(execFile)(process.execPath,
            ['--', join(bundle, 'scripts/operator-node.mjs'), 'status', '--json'], {
                cwd: unpacked, env: { PATH: '/nonexistent', OYA_OPERATOR_PROFILE: join(privateDir, 'operator.json') }, timeout: 10000,
            });
        assert.equal(result.stderr, '');
        assert.equal(JSON.parse(result.stdout).healthy, true);
        assert.equal(JSON.parse(result.stdout).verified, true);
        const options = { cwd: unpacked, env: { PATH: '', OYA_OPERATOR_PROFILE: join(privateDir, 'operator.json') } };
        const run = (...args) => execFileSync(process.execPath, args, { ...options, encoding: 'utf8', timeout: 10000 });
        if (mode === 'ipfs') {
            const balance = JSON.parse(run(join(bundle, 'scripts/operator-node.mjs'), 'balance',
                '--profile', join(privateDir, 'operator.json'), '--json'));
            assert.equal(balance.status, 'not_applicable');
            assert.equal(balance.mode, 'ipfs');
            assert.equal(balance.balanceWei, null);
        }
        assert.equal(run(join(bundle, 'scripts/operator-node.mjs'), 'gas-policy', '--json'),
            run(join(bundle, 'scripts/gas-policy.mjs'), '--config', join(privateDir, 'node.json'), '--json'));
    }
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
