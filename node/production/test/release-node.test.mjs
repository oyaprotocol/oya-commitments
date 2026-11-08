import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkRelease, githubClient, hasSuccessfulCI, imageExists, imageRepository, main, publishRelease, readAssets,
    releaseNotes, releaseVersion, repository, verifyDownloads } from '../scripts/release-node.mjs';

const sha = 'a'.repeat(40);
const pin = `${imageRepository}@sha256:${'b'.repeat(64)}`;
const release = { ...releaseVersion('0.4.1'), sha, previous: 'node-v0.4.0' };
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function apiFixture(overrides = {}) {
    const calls = [];
    const api = async (path, options = {}) => {
        calls.push({ path, ...options });
        if (Object.hasOwn(overrides, path)) {
            if (overrides[path] instanceof Error) throw overrides[path];
            return overrides[path];
        }
        if (path === 'releases/latest') return { tag_name: 'node-v0.4.0' };
        if (path === 'git/ref/heads/main') return { object: { sha } };
        if (options.missing) return null;
        if (path === 'git/tags') return { sha: 'c'.repeat(40) };
        if (path === 'git/refs') return {};
        if (path === 'releases') return { id: 1 };
        if (options.upload) return { size: options.body.length, digest: digest(options.body) };
        if (path === 'releases/1') return { html_url: `https://github.com/${repository}/releases/tag/${release.tag}` };
        throw new Error(`Unexpected API request: ${path}`);
    };
    return { api, calls };
}

const input = api => ({ version: '0.4.1', sha, ref: 'refs/heads/main', api, hasImage: async () => false });

test('release versions reject ambiguous, injected, prerelease, and nonstring inputs', () => {
    for (const value of ['', 'v0.4.1', 'node-v0.4.1', '00.4.1', '0.4', '0.4.1-rc.1', '0.4.1\n', '0.4.1;echo injected', 123, undefined]) {
        assert.throws(() => releaseVersion(value), /stable version/);
    }
    assert.equal(releaseVersion('10.20.30').tag, 'node-v10.20.30');
});

test('preflight accepts an unused newer version and performs only reads', async () => {
    const f = apiFixture();
    assert.deepEqual(await checkRelease(input(f.api)), release);
    assert.ok(f.calls.every(call => !call.method));
    assert.equal((await checkRelease({ ...input(f.api), version: '0.10.0' })).version, '0.10.0');
});

test('CI reuse requires a successful completed push run for the exact source', async () => {
    const good = { head_sha: sha, event: 'push', status: 'completed', conclusion: 'success' };
    for (const change of [{ head_sha: 'd'.repeat(40) }, { event: 'pull_request' }, { status: 'in_progress' },
        { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' }]) {
        assert.equal(await hasSuccessfulCI(sha, async () => ({ workflow_runs: [{ ...good, ...change }] })), false);
    }
    assert.equal(await hasSuccessfulCI(sha, async path => {
        assert.ok(path.startsWith('actions/workflows/test.yml/runs?'));
        return { workflow_runs: [good] };
    }), true);
    assert.equal(await hasSuccessfulCI(sha, async () => ({ workflow_runs: [] })), false);
    await assert.rejects(hasSuccessfulCI(sha, async () => { throw new Error('API unavailable'); }), /API unavailable/);
});

test('preflight rejects reserved versions, stale source, old versions, and off-main publication', async () => {
    for (const path of ['git/ref/tags/node-v0.4.1', 'releases/tags/node-v0.4.1']) {
        const f = apiFixture({ [path]: {} });
        await assert.rejects(checkRelease(input(f.api)), /already/);
        assert.ok(f.calls.every(call => !call.method));
    }
    await assert.rejects(checkRelease({ ...input(apiFixture().api), hasImage: async () => true }), /already exists in GHCR/);
    await assert.rejects(checkRelease(input(apiFixture({ 'git/ref/heads/main': { object: { sha: 'd'.repeat(40) } } }).api)), /Main advanced/);
    for (const version of ['0.3.9', '0.4.0']) await assert.rejects(checkRelease({ ...input(apiFixture().api), version }), /newer/);
    await assert.rejects(checkRelease({ ...input(apiFixture().api), ref: 'refs/heads/feature' }), /Publish from main/);
    await checkRelease({ ...input(apiFixture().api), ref: 'refs/heads/feature', dryRun: true });
});

test('API absence is strictly 404 and errors never disclose credentials or response bodies', async () => {
    for (const status of [401, 403, 429, 500]) {
        const api = githubClient('private-test-token', async (url, options) => {
            assert.equal(options.headers.authorization, 'Bearer private-test-token');
            assert.ok(url.startsWith('https://api.github.com/'));
            return new Response('private-server-content', { status });
        });
        await assert.rejects(api('git/ref/tags/node-v0.4.1', { missing: true }), error => {
            assert.ok(error.message.includes(`HTTP ${status}`));
            assert.ok(!/private-test-token|private-server-content/.test(error.message));
            return true;
        });
    }
    assert.equal(await githubClient('', async () => new Response('', { status: 404 }))('releases/latest', { missing: true }), null);
    await assert.rejects(checkRelease(input(apiFixture({ 'git/ref/tags/node-v0.4.1': new Error('transport failed') }).api)), /transport failed/);
});

test('registry preflight distinguishes missing tags from authentication and transport failures', async () => {
    for (const status of [200, 404, 401, 403, 500]) {
        const transport = async (url, options) => url.includes('/token?') ? Response.json({ token: 'anonymous-pull-token' })
            : (assert.equal(options.method, 'HEAD'), new Response(null, { status }));
        if ([200, 404].includes(status)) assert.equal(await imageExists('0.4.1', transport), status === 200);
        else await assert.rejects(imageExists('0.4.1', transport), /version check failed/);
    }
    await assert.rejects(imageExists('0.4.1', async () => new Response(null, { status: 401 })), /authentication failed/);
});

function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'oya-release-coordinator-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const output = join(directory, 'output');
    const env = { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main',
        GITHUB_TOKEN: 'fixture-token', GITHUB_STEP_SUMMARY: join(directory, 'summary.md') };
    const f = apiFixture();
    const commands = [];
    const generate = () => {
        mkdirSync(output);
        writeFileSync(join(output, 'image.txt'), `${pin}\n`);
        writeFileSync(join(output, 'release.txt'), `Git tag: ${release.tag}\nGit commit: ${sha}\nImage: ${pin}\n`);
        writeFileSync(join(output, release.archive), 'fixture archive');
    };
    const run = (file, args) => {
        commands.push({ file, args });
        if (file === 'git' && args[0] === 'rev-parse') return sha;
        if (file === 'git' && args[0] === 'log') return '- A tested change (abcdef0)';
        if (file === 'git') return '';
        if (file === 'bash') { generate(); return; }
        if (file === 'tar') return pin;
        if (file === 'docker' && args[0] === 'image') return JSON.stringify([{ Os: 'linux', Architecture: 'amd64', Config: { Labels: {
            'org.opencontainers.image.source': `https://github.com/${repository}`,
            'org.opencontainers.image.revision': sha, 'org.opencontainers.image.version': release.imageTag,
        } } }]);
        if (file === 'docker' && args.includes('pull')) return '';
        throw new Error(`Unexpected command: ${file}`);
    };
    let verified = false;
    const deps = { run, api: f.api, hasImage: async () => false, downloads: async () => { verified = true; }, log: () => {} };
    return { ...f, directory, output, env, commands, generate, deps, verified: () => verified };
}

test('preview builds the versioned bundle without any remote mutations', async t => {
    const f = fixture(t);
    await main(['preview', '0.4.1', f.output], { ...f.env, GITHUB_REF: 'refs/heads/feature' }, f.deps);
    assert.ok(f.calls.every(call => !call.method));
    assert.ok(f.commands.find(c => c.file === 'bash').args.includes('--dry-run'));
    assert.ok(!f.commands.some(c => c.file === 'docker' && c.args.includes('pull')));
    assert.equal(f.verified(), false);
    assert.match(readFileSync(join(f.output, 'notes.md'), 'utf8'), /Preview only/);
    assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /no remote tag/);
});

test('publication creates immutable tag, checks image, uploads draft assets, then publishes and verifies', async t => {
    const f = fixture(t);
    await main(['release', '0.4.1', f.output], f.env, f.deps);
    const writes = f.calls.filter(call => call.method);
    assert.deepEqual(writes.map(call => call.method), ['POST', 'POST', 'POST', 'POST', 'POST', 'POST', 'PATCH']);
    assert.equal(writes[0].body.object, sha);
    assert.equal(writes[1].body.ref, `refs/tags/${release.tag}`);
    assert.equal(writes[2].body.draft, true);
    assert.equal(writes.at(-1).body.draft, false);
    assert.equal(f.verified(), true);
    assert.ok(!f.commands.find(c => c.file === 'bash').args.includes('--dry-run'));
    assert.ok(f.commands.some(c => c.file === 'docker' && c.args.includes('pull') && c.args.includes(pin)));
    assert.match(readFileSync(join(f.output, 'notes.md'), 'utf8'), /A tested change/);
});

test('partial build failure preserves reserved tag and stops before creating a release', async t => {
    const f = fixture(t);
    const run = f.deps.run;
    f.deps.run = (file, args) => { if (file === 'bash') throw new Error('push failed'); return run(file, args); };
    await assert.rejects(main(['release', '0.4.1', f.output], f.env, f.deps), /push failed/);
    assert.deepEqual(f.calls.filter(call => call.method).map(call => call.path), ['git/tags', 'git/refs']);
    assert.equal(f.verified(), false);
});

test('wrong image identity stops publication and retains generated recovery artifacts', async t => {
    const f = fixture(t);
    const run = f.deps.run;
    f.deps.run = (file, args) => {
        const value = run(file, args);
        if (file !== 'docker' || args[0] !== 'image') return value;
        const image = JSON.parse(value);
        image[0].Config.Labels['org.opencontainers.image.revision'] = 'd'.repeat(40);
        return JSON.stringify(image);
    };
    await assert.rejects(main(['release', '0.4.1', f.output], f.env, f.deps), /revision mismatch/);
    assert.ok(!f.calls.some(call => call.path === 'releases' && call.method === 'POST'));
    assert.ok(existsSync(join(f.output, 'notes.md')));
    assert.ok(existsSync(join(f.output, release.archive)));
});

test('verification can be repeated without a token or any tag/release mutation', async t => {
    const f = fixture(t); f.generate();
    await main(['verify', '0.4.1', f.output], { ...f.env, GITHUB_TOKEN: undefined }, f.deps);
    assert.equal(f.verified(), true);
    assert.equal(f.calls.length, 0);
    assert.ok(!f.commands.some(c => c.file === 'bash' || c.args.includes('tag')));
});

test('existing output and source mismatch stop before tagging', async t => {
    const f = fixture(t);
    mkdirSync(f.output);
    await assert.rejects(main(['release', '0.4.1', f.output], f.env, f.deps), /output already exists/);
    await assert.rejects(main(['release', '0.4.1', f.output], { ...f.env, GITHUB_SHA: 'd'.repeat(40) }, f.deps), /source/);
    assert.ok(f.calls.every(call => !call.method));
    assert.ok(!f.commands.some(c => c.args.includes('tag')));
});

test('asset validation rejects inconsistent records and generated notes include exact checksum and migration text', t => {
    const f = fixture(t); f.generate();
    const records = readAssets(f.output, release);
    const notes = releaseNotes(release, records, '- Change', 'Back up the database before upgrading.');
    assert.ok(notes.includes(records.checksum));
    assert.ok(notes.includes(sha));
    assert.ok(notes.includes(pin));
    assert.ok(notes.includes('Back up the database before upgrading.'));
    writeFileSync(join(f.output, 'release.txt'), 'wrong source');
    assert.throws(() => readAssets(f.output, release), /record mismatch/);
});

test('failed or corrupt uploads keep a draft and never publish it', async t => {
    const f = fixture(t); f.generate();
    const records = readAssets(f.output, release);
    for (const failure of [new Error('upload failed'), { size: 0, digest: 'sha256:wrong' }]) {
        const api = apiFixture({ 'releases/1/assets?name=image.txt': failure });
        await assert.rejects(publishRelease(release, records, 'notes', api.api));
        assert.ok(!api.calls.some(call => call.method === 'PATCH'));
    }
});

test('anonymous downloads require exact bytes and never carry authorization', async t => {
    const f = fixture(t); f.generate();
    const records = readAssets(f.output, release);
    const transport = async (url, options) => {
        assert.equal(options.headers, undefined);
        assert.ok(url.startsWith(`https://github.com/${repository}/releases/download/${release.tag}/`));
        return new Response(records.assets.find(asset => url.endsWith(`/${asset.name}`)).bytes);
    };
    await verifyDownloads(release, records, transport);
    await assert.rejects(verifyDownloads(release, records, async () => new Response('corrupt')), /differs/);
    await assert.rejects(verifyDownloads(release, records, async () => new Response(null, { status: 404 })), /download failed/);
    assert.ok(existsSync(join(f.output, release.archive)), 'Verification failures preserve original artifacts.');
});
