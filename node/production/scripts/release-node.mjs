import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repository = 'oyaprotocol/oya-commitments';
export const imageRepository = 'ghcr.io/oyaprotocol/oya-node';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function releaseVersion(version) {
    if (typeof version !== 'string' || version.trim() !== version || version.length > 32 ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error('Use an unused stable version such as 0.4.1.');
    }
    return { version, tag: `node-v${version}`, imageTag: `v${version}`, archive: `oya-node-v${version}.tar.gz` };
}

export function githubClient(token, transport = fetch) {
    return async (path, { method = 'GET', body, missing = false, upload = false } = {}) => {
        const origin = upload ? 'https://uploads.github.com' : 'https://api.github.com';
        const response = await transport(`${origin}/repos/${repository}/${path}`, {
            method, signal: AbortSignal.timeout(60_000),
            headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(body === undefined ? {} : { 'content-type': upload ? 'application/octet-stream' : 'application/json' }) },
            ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) }),
        });
        if (missing && response.status === 404) return null;
        if (!response.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} failed (HTTP ${response.status}).`);
        return response.json();
    };
}

export async function imageExists(version, transport = fetch) {
    const tokenResponse = await transport('https://ghcr.io/token?service=ghcr.io&scope=repository:oyaprotocol/oya-node:pull',
        { signal: AbortSignal.timeout(30_000) });
    if (!tokenResponse.ok) throw new Error(`Anonymous GHCR authentication failed (HTTP ${tokenResponse.status}).`);
    const { token } = await tokenResponse.json();
    if (typeof token !== 'string' || !token) throw new Error('GHCR returned no pull token.');
    const response = await transport(`https://ghcr.io/v2/oyaprotocol/oya-node/manifests/${releaseVersion(version).imageTag}`, {
        method: 'HEAD', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`,
            accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' },
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`GHCR version check failed (HTTP ${response.status}).`);
    return true;
}

export async function checkRelease({ version, sha, ref, dryRun = false, api, hasImage = imageExists }) {
    const release = releaseVersion(version);
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('A full source commit is required.');
    if (!dryRun && ref !== 'refs/heads/main') throw new Error('Publish from main; use dry_run for other branches.');
    if (await api(`git/ref/tags/${release.tag}`, { missing: true })) throw new Error(`${release.tag} already exists; inspect the prior run instead of rebuilding.`);
    if (await api(`releases/tags/${release.tag}`, { missing: true })) throw new Error(`${release.tag} already has a release.`);
    if (await hasImage(version)) throw new Error(`${release.imageTag} already exists in GHCR; retain its original digest and artifacts.`);
    const previous = await api('releases/latest', { missing: true });
    if (previous) {
        if (!previous.tag_name?.startsWith('node-v')) throw new Error('Latest release is not a node version; inspect release selection.');
        const old = releaseVersion(previous.tag_name?.replace(/^node-v/, '')).version.split('.').map(BigInt);
        const next = version.split('.').map(BigInt);
        const index = next.findIndex((part, i) => part !== old[i]);
        if (index < 0 || next[index] < old[index]) throw new Error(`Version must be newer than ${previous.tag_name}.`);
    }
    if (!dryRun) {
        const main = await api('git/ref/heads/main');
        if (main.object?.sha !== sha) throw new Error('Main advanced during validation; dispatch a new run for the latest source.');
    }
    return { ...release, sha, previous: previous?.tag_name };
}

export async function hasSuccessfulCI(sha, api) {
    const result = await api(`actions/workflows/test.yml/runs?head_sha=${sha}&event=push&status=completed&per_page=100`);
    return result.workflow_runs?.some(run => run.head_sha === sha && run.event === 'push' &&
        run.status === 'completed' && run.conclusion === 'success') === true;
}

export function readAssets(directory, release) {
    const image = readFileSync(join(directory, 'image.txt'), 'utf8').trim();
    if (!image.startsWith(`${imageRepository}@sha256:`) || !/^[0-9a-f]{64}$/.test(image.slice(`${imageRepository}@sha256:`.length))) {
        throw new Error('Invalid release image pin.');
    }
    const expected = `Git tag: ${release.tag}\nGit commit: ${release.sha}\nImage: ${image}\n`;
    assert.equal(readFileSync(join(directory, 'release.txt'), 'utf8'), expected, 'Release source/image record mismatch.');
    const assets = ['image.txt', 'release.txt', release.archive].map(name => {
        const bytes = readFileSync(join(directory, name));
        return { name, bytes, digest: `sha256:${hash(bytes)}` };
    });
    return { image, assets, checksum: assets[2].digest.slice(7) };
}

export function releaseNotes(release, records, changes, notes = '', dryRun = false) {
    return `${dryRun ? 'Preview only — no release was published.\n\n' : ''}Oya node ${release.imageTag}: Linux amd64 image and matching deployment bundle.

${notes.trim() ? `${notes.trim()}\n\n` : ''}## Changes

${changes.trim() || 'Rebuild of the selected source.'}

## Deployment

Use the matching image and bundle. Review configuration and migration changes before upgrading. Preserve existing keys, execution identities, database/IPFS volumes, and targets. Follow the [verified inbox and worker upgrade guide](https://github.com/${repository}/blob/${release.tag}/node/production/upgrade-node.md) for supported Compose installations, and the [database recovery](https://github.com/${repository}/blob/${release.tag}/node/production/host-inbox.md#retention-recovery-and-migration) guide. ARM hosts require the documented amd64 platform override and emulation.

\`\`\`text
Git tag: ${release.tag}
Git commit: ${release.sha}
Image: ${records.image}
\`\`\`

Archive SHA-256 (\`${release.archive}\`):

\`\`\`text
${records.checksum}
\`\`\`

Verify the checksum before extracting with \`tar -xzpf\`. Deploy using the immutable reference in \`image.txt\`.
${release.previous ? `\n[Full changes](https://github.com/${repository}/compare/${release.previous}...${release.tag})\n` : ''}`;
}

export async function publishRelease(release, records, notes, api) {
    const draft = await api('releases', { method: 'POST', body: {
        tag_name: release.tag, target_commitish: release.sha, name: `Oya node ${release.imageTag}`, body: notes, draft: true,
    } });
    for (const asset of records.assets) {
        const uploaded = await api(`releases/${draft.id}/assets?name=${encodeURIComponent(asset.name)}`,
            { method: 'POST', body: asset.bytes, upload: true });
        if (uploaded.size !== asset.bytes.length || uploaded.digest !== asset.digest) {
            throw new Error(`Uploaded ${asset.name} does not match; retained draft release ${draft.id}.`);
        }
    }
    return api(`releases/${draft.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
}

export async function verifyDownloads(release, records, transport = fetch) {
    for (const asset of records.assets) {
        const url = `https://github.com/${repository}/releases/download/${release.tag}/${asset.name}`;
        const response = await transport(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`Public ${asset.name} download failed (HTTP ${response.status}).`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.equals(asset.bytes)) throw new Error(`Public ${asset.name} differs from the generated asset.`);
    }
}

const execute = (file, args, { inherit = false, ...options } = {}) => execFileSync(file, args, {
    cwd: root, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', ...options,
})?.trim();

function verifyImage(release, image, dryRun, run = execute) {
    if (!dryRun) {
        const config = mkdtempSync(join(tmpdir(), 'oya-release-anonymous-'));
        // The hosted runner uses the default Docker socket; no credentials are copied.
        try {
            run('docker', ['--config', config, '--host', 'unix:///var/run/docker.sock', 'pull', '--platform', 'linux/amd64', image], { inherit: true });
        } finally { rmSync(config, { recursive: true, force: true }); }
    }
    const [inspection] = JSON.parse(run('docker', ['image', 'inspect', dryRun ? `${imageRepository}:${release.imageTag}` : image]));
    assert.equal(inspection.Os, 'linux');
    assert.equal(inspection.Architecture, 'amd64');
    for (const [key, value] of Object.entries({ source: `https://github.com/${repository}`, revision: release.sha, version: release.imageTag })) {
        assert.equal(inspection.Config.Labels[`org.opencontainers.image.${key}`], value, `Image ${key} mismatch.`);
    }
}

export async function main(args = process.argv.slice(2), env = process.env, {
    run = execute, api = githubClient(env.GITHUB_TOKEN), hasImage = imageExists, downloads = verifyDownloads, log = console.log,
} = {}) {
    const [command, version, output] = args;
    if (!['check', 'preview', 'release', 'verify'].includes(command) || args.length !== (command === 'check' ? 2 : 3)) {
        throw new Error('Usage: node release-node.mjs check VERSION | preview|release|verify VERSION OUTPUT_DIRECTORY');
    }
    if (env.GITHUB_REPOSITORY !== repository) throw new Error(`Run this workflow in ${repository}.`);
    const dryRun = command === 'preview' || (command === 'check' && env.RELEASE_DRY_RUN === 'true');
    const sha = run('git', ['rev-parse', 'HEAD']);
    if (sha !== env.GITHUB_SHA) throw new Error('Checkout does not match the workflow source.');
    if (command === 'verify') {
        const release = { ...releaseVersion(version), sha };
        const records = readAssets(output, release);
        verifyImage(release, records.image, false, run);
        await downloads(release, records);
        log(`Verified https://github.com/${repository}/releases/tag/${release.tag}`);
        return;
    }
    const release = await checkRelease({ version, sha, ref: env.GITHUB_REF, dryRun, api, hasImage });
    if (command === 'check') {
        const tested = await hasSuccessfulCI(sha, api);
        if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `ci_passed=${tested}\n`);
        log(`Validated unused version ${release.tag} at ${sha}. ${tested ? 'Existing CI passed for this exact source.' : 'Full CI is required.'}`);
        return;
    }
    if (!env.GITHUB_TOKEN) throw new Error('The workflow repository token is required.');
    const directory = resolve(realpathSync(dirname(resolve(output))), resolve(output).split(sep).at(-1));
    if (directory === root.slice(0, -1) || directory.startsWith(root)) throw new Error('Release output must be outside the checkout.');
    if (existsSync(directory)) throw new Error('Release output already exists; preserve it and inspect the prior attempt.');
    if (run('git', ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Release source must be clean.');
    run('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'tag', '-a', release.tag, '-m', `Production node ${release.imageTag}`, sha]);
    if (!dryRun) {
        const tag = await api('git/tags', { method: 'POST', body: {
            tag: release.tag, message: `Production node ${release.imageTag}`, object: sha, type: 'commit',
        } });
        await api('git/refs', { method: 'POST', body: { ref: `refs/tags/${release.tag}`, sha: tag.sha } });
    }
    run('bash', ['node/production/scripts/publish-image.sh', imageRepository, release.tag, directory,
        ...(dryRun ? ['--dry-run'] : [])], { inherit: true });
    const records = readAssets(directory, release);
    const bundledImage = run('tar', ['-xzOf', join(directory, release.archive), './node/production/image.txt']);
    assert.equal(bundledImage, records.image, 'Bundle image pin mismatch.');
    const changes = run('git', ['log', '--first-parent', '--format=- %s (%h)', release.previous ? `${release.previous}..${sha}` : sha]);
    const notes = releaseNotes(release, records, changes, env.RELEASE_NOTES, dryRun);
    writeFileSync(join(directory, 'notes.md'), notes);
    verifyImage(release, records.image, dryRun, run);
    if (!dryRun) {
        await publishRelease(release, records, notes, api);
        await downloads(release, records);
    }
    const summary = dryRun ? `Preview for ${release.tag} passed; no remote tag, image, or release was published.`
        : `Published and verified https://github.com/${repository}/releases/tag/${release.tag}`;
    log(summary);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n\n${notes}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
