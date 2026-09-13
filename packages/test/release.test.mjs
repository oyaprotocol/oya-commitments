import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packages = fileURLToPath(new URL('../', import.meta.url));
const names = ['utils', 'ethereum', 'ipfs', 'messages'];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function listFiles(directory, prefix = '') {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory()) return listFiles(join(directory, entry.name), `${path}/`);
        assert.ok(entry.isFile(), `Expected a regular file: ${path}`);
        return [path];
    }).sort();
}

test('released kernels work in an independent consumer', () => {
    assert.ok(process.env.npm_execpath, 'Run npm --prefix packages run test:release');
    const source = process.env.OYA_RELEASE_SOURCE ?? 'archives';
    assert.ok(['archives', 'registry'].includes(source), 'OYA_RELEASE_SOURCE must be archives or registry');
    let reviewed;
    let referencePath;
    if (source === 'registry') {
        assert.ok(process.env.OYA_RELEASE_INVENTORY, 'Registry verification requires OYA_RELEASE_INVENTORY');
        referencePath = resolve(process.env.OYA_RELEASE_INVENTORY);
        reviewed = readJson(referencePath);
        assert.equal(reviewed.validation, 'passed', 'The reference inventory must have passed validation');
        assert.ok(Array.isArray(reviewed.archives), 'The reference inventory must list its archives');
    }
    const artifacts = realpathSync(mkdtempSync(join(tmpdir(), 'oya-kernel-release-')));
    assert.ok(!artifacts.startsWith(`${resolve(packages, '..')}${sep}`), 'Use a temporary directory outside the checkout');
    console.log(`Release artifacts: ${artifacts}`);
    const consumer = join(artifacts, 'consumer');
    const archiveDirectory = reviewed ? dirname(referencePath) : artifacts;
    mkdirSync(consumer);
    // No external module search path or preload hooks may supply missing package files.
    const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
    const run = (command, args, cwd) => execFileSync(command, args, {
        cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const npm = (args, cwd) => run(process.execPath, [process.env.npm_execpath, ...args,
        '--cache', join(artifacts, 'npm-cache'), '--registry=https://registry.npmjs.org/',
        '--fetch-retries=0', '--fetch-timeout=20000',
    ], cwd);
    const manifests = names.map((name) => readJson(join(packages, name, 'package.json')));
    const inventory = {
        source,
        referenceInventory: referencePath,
        node: process.version,
        npm: npm(['--version'], packages).trim(),
        typescript: readJson(join(packages, 'node_modules/typescript/package.json')).version,
        sourceCommit: run('git', ['rev-parse', 'HEAD'], packages).trim(),
        packageChanges: run('git', ['status', '--short', '--', '.'], packages).trim(),
        validation: 'pending',
        archives: source === 'registry' ? reviewed.archives : JSON.parse(npm(['pack', '--workspaces', '--ignore-scripts', '--json',
            '--pack-destination', artifacts], packages)),
    };
    const inventoryPath = join(artifacts, 'inventory.json');
    writeJson(inventoryPath, inventory);
    try {
        assert.deepEqual(inventory.archives.map(({ name }) => name).sort(), manifests.map(({ name }) => name).sort());
        for (const archive of inventory.archives) {
            assert.equal(archive.version, manifests.find(({ name }) => name === archive.name).version);
            assert.equal(archive.filename, `${archive.name.replace('@', '').replace('/', '-')}-${archive.version}.tgz`);
            const integrity = `sha512-${createHash('sha512').update(readFileSync(join(archiveDirectory, archive.filename))).digest('base64')}`;
            assert.equal(integrity, archive.integrity);
            for (const { path } of archive.files) {
                assert.match(path, /^(?:package\.json|README\.md|LICENSE|dist\/.+\.(?:js|js\.map|d\.ts))$/);
                assert.ok(!path.split('/').includes('..'), `Unexpected archive path: ${path}`);
            }
        }
        if (source === 'registry') {
            inventory.registry = [];
            for (const archive of inventory.archives) {
                const metadata = JSON.parse(npm(['view', `${archive.name}@${archive.version}`,
                    'version', 'dist.integrity', '_from', '_resolved', '--json'], consumer));
                assert.equal(metadata.version, archive.version, `Registry version mismatch: ${archive.name}`);
                assert.equal(metadata['dist.integrity'], archive.integrity, `Registry integrity mismatch: ${archive.name}`);
                assert.equal(metadata._from, undefined, `Unexpected publication source: ${archive.name}`);
                assert.equal(metadata._resolved, undefined, `Unexpected publication path: ${archive.name}`);
                inventory.registry.push({ name: archive.name, ...metadata });
            }
        }
        writeJson(join(consumer, 'package.json'), { name: 'oya-release-consumer', private: true, type: 'module' });
        npm(['install', '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund',
            ...inventory.archives.map(({ name, version, filename }) => source === 'registry'
                ? `${name}@${version}` : join(archiveDirectory, filename))], consumer);

        const expectedVersions = Object.fromEntries(manifests.map(({ name, version }) => [name, version]));
        for (const manifest of manifests) {
            assert.equal(manifest.license, 'MIT');
            assert.equal(manifest.repository.url, 'git+https://github.com/oyaprotocol/oya-commitments.git');
            assert.equal(manifest.engines?.node, undefined);
            assert.deepEqual(manifest.scripts ?? {}, {}, 'Packages must need no lifecycle scripts');
            for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
                assert.ok(dependency in expectedVersions || ['@noble/curves', '@noble/hashes'].includes(dependency));
                assert.match(version, /^\d+\.\d+\.\d+$/);
                if (dependency in expectedVersions) assert.equal(version, expectedVersions[dependency]);
                expectedVersions[dependency] = version;
            }
            const directory = join(consumer, 'node_modules', manifest.name);
            assert.equal(realpathSync(directory), directory, 'Package must be installed without a workspace symlink');
            assert.deepEqual(readJson(join(directory, 'package.json')), manifest);
            const archive = inventory.archives.find(({ name }) => name === manifest.name);
            assert.deepEqual(listFiles(directory), archive.files.map(({ path }) => path).sort());
            for (const { path } of archive.files) {
                const content = readFileSync(join(directory, path));
                assert.deepEqual(content, readFileSync(join(packages, manifest.repository.directory.replace('packages/', ''), path)));
                assert.doesNotMatch(content.toString('utf8'), /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bnpm_[A-Za-z0-9]{30,}\b/);
                if (path.endsWith('.map')) {
                    const map = JSON.parse(content);
                    assert.equal(map.sourceRoot, '');
                    assert.equal(map.sourcesContent, undefined, 'Source maps must not embed source files');
                    for (const source of map.sources) {
                        const target = relative(directory, resolve(directory, dirname(path), source));
                        assert.ok(target.startsWith(`src${sep}`), `Unexpected source map reference: ${source}`);
                    }
                }
            }
            assert.match(readFileSync(join(directory, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 John Shutt/);
            for (const entry of [manifest.exports['.'].import, manifest.exports['.'].types]) {
                assert.ok(archive.files.some(({ path }) => `./${path}` === entry), `Missing entrypoint: ${entry}`);
            }
        }
        const lock = readJson(join(consumer, 'package-lock.json'));
        assert.deepEqual(Object.keys(lock.packages).filter(Boolean).sort(),
            Object.keys(expectedVersions).map((name) => `node_modules/${name}`).sort());
        for (const [name, version] of Object.entries(expectedVersions)) {
            const installed = lock.packages[`node_modules/${name}`];
            assert.equal(installed.version, version);
            assert.ok(!installed.link && !installed.hasInstallScript);
            const archive = inventory.archives.find((entry) => entry.name === name);
            if (archive) {
                assert.equal(installed.integrity, archive.integrity, `Installed integrity mismatch: ${name}`);
                if (source === 'registry') {
                    assert.ok(installed.resolved.startsWith('https://registry.npmjs.org/'), `Expected registry installation: ${name}`);
                }
            }
            const directory = join(consumer, 'node_modules', name);
            assert.equal(realpathSync(directory), directory);
        }
        inventory.dependencies = expectedVersions;

        const cids = readJson(join(packages, 'test/fixtures/cids.json'));
        const logger = readJson(join(packages, 'ethereum/test/fixtures/logger-abi.json'));
        writeJson(join(consumer, 'fixtures.json'), {
            publication: cids.cases.find(({ name }) => name === 'message'),
            event: logger.cases.find(({ name }) => name === 'message'),
        });
        writeFileSync(join(consumer, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertCanonicalCid } from '@oyaprotocol/utils';
import { createIpfsConfig } from '@oyaprotocol/ipfs';
import { encodeLoggerCall, hashLoggerCid, parseTransactionQuantity } from '@oyaprotocol/ethereum';
import { publishSignedMessage, verifySignedMessage, SignedMessageVerificationError } from '@oyaprotocol/messages';
for (const name of ${JSON.stringify(manifests.map(({ name }) => name))}) {
    assert.equal(realpathSync(fileURLToPath(import.meta.resolve(name))),
        realpathSync(new URL('./node_modules/' + name + '/dist/index.js', import.meta.url)));
}
const { publication, event } = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
assert.equal(parseTransactionQuantity('0x7a69', 'chainId'), 31337n);
assert.throws(() => parseTransactionQuantity('0x01', 'balance'));
assert.throws(() => parseTransactionQuantity('0x1' + '0'.repeat(64), 'balance'));
const message = JSON.parse(publication.text);
assert.deepEqual(verifySignedMessage(message), message);
assert.throws(() => verifySignedMessage({ ...message, text: message.text + '!' }), SignedMessageVerificationError);
assertCanonicalCid(publication.cid, 'cid');
assert.throws(() => assertCanonicalCid('invalid-cid', 'cid'));
const result = await publishSignedMessage(message, {
    config: createIpfsConfig({ url: 'https://ipfs.example', headers: {}, timeoutMs: 1000, maxRetries: 0, retryDelayMs: 0 }),
    fetch: async (url, request) => {
        assert.equal(await request.body.get('file').text(), publication.text);
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ Hash: publication.cid }) };
    },
});
assert.equal(result.cid, event.cid);
assert.equal(result.pinned, true);
assert.equal(encodeLoggerCall(result.cid), event.calldata);
assert.equal(hashLoggerCid(result.cid), event.cidKeccak256Hash);
`);
        run(process.execPath, ['consumer.mjs'], consumer);
        writeFileSync(join(consumer, 'consumer.ts'), `
import { assertCanonicalCid, type HttpConfig } from '@oyaprotocol/utils';
import { createIpfsConfig, type PublishToIpfsResult } from '@oyaprotocol/ipfs';
import { encodeLoggerCall, parseTransactionQuantity } from '@oyaprotocol/ethereum';
import { verifySignedMessage, publishSignedMessage, type SignedMessageInput, type PublishSignedMessageOptions } from '@oyaprotocol/messages';
const config: HttpConfig = createIpfsConfig({ url: 'https://ipfs.example', headers: {}, timeoutMs: 1000, maxRetries: 0, retryDelayMs: 0 });
declare const cid: string;
assertCanonicalCid(cid, 'cid');
const calldata: string = encodeLoggerCall(cid);
const chainId: bigint = parseTransactionQuantity('0x7a69', 'chainId');
// @ts-expect-error Quantities must not be narrowed to imprecise numbers.
const imprecise: number = parseTransactionQuantity('0x7a69', 'chainId');
declare const message: SignedMessageInput;
const verified: Readonly<SignedMessageInput> = verifySignedMessage(message);
declare const options: PublishSignedMessageOptions;
const result: Promise<PublishToIpfsResult> = publishSignedMessage(verified, options);
// @ts-expect-error The Logger encoder requires a CID string.
encodeLoggerCall(123);
// @ts-expect-error Publication requires an explicit transport.
publishSignedMessage(verified, { config });
`);
        writeJson(join(consumer, 'tsconfig.json'), {
            compilerOptions: {
                target: 'ES2025', module: 'NodeNext', moduleResolution: 'NodeNext',
                lib: ['ES2025', 'DOM', 'DOM.Iterable'], types: [], strict: true,
                exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true,
            },
            files: ['consumer.ts'],
        });
        run(process.execPath, [join(packages, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], consumer);
        inventory.validation = 'passed';
    } catch (error) {
        inventory.validation = 'failed';
        throw error;
    } finally {
        writeJson(inventoryPath, inventory);
    }
});
