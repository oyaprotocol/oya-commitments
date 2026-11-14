import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../scripts/peer-directory.mjs', import.meta.url));
const official = new URL('../peers/testnet-directory.json', import.meta.url);
// Fixed synthetic records, independent of future edits to the official roster.
const nodes = [{ nodeAddress: '0x1111111111111111111111111111111111111111',
    url: 'https://node.example/v1/jobs', target: 'example-node' }];
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'oya-registry-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const guard = join(dir, 'fetch.mjs');
    const mock = body => writeFileSync(guard, body);
    mock('globalThis.fetch = () => { throw new Error("Unexpected network access"); };');
    const run = (...args) => spawnSync(process.execPath, ['--import', guard, cli, ...args], {
        cwd: dir, encoding: 'utf8', timeout: 5000,
    });
    return { dir, mock, run };
}

test('default loads the bundled registry from any working directory without networking', t => {
    const f = fixture(t), result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), JSON.parse(readFileSync(official, 'utf8')));
    assert.equal(result.stderr, '');
});

test('local list preserves records and recovers from malformed or missing files', t => {
    const f = fixture(t), path = join(f.dir, 'registry.json');
    assert.equal(f.run('list', path).status, 1);
    for (const invalid of ['private-marker', '{}', '[null]', '[{}]', '[{"nodeAddress":1}]',
        ...[undefined, '', null, 1].map(url => JSON.stringify([{ ...nodes[0], url }]))]) {
        writeFileSync(path, invalid);
        const result = f.run('list', path);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.ok(!result.stderr.includes('private-marker'));
        assert.equal(readFileSync(path, 'utf8'), invalid);
    }
    for (const records of [[], nodes, [...nodes, { ...nodes[0], target: 'second-node' }]]) {
        writeFileSync(path, JSON.stringify(records));
        const result = f.run('list', path);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), records);
    }
});

test('fetch uses only official upstream with a deadline and rejects redirects', t => {
    const f = fixture(t);
    f.mock(`import assert from 'node:assert/strict';
        AbortSignal.timeout = ms => { assert.equal(ms, 10_000); return new AbortController().signal; };
        globalThis.fetch = async (url, options) => {
            assert.equal(url, 'https://raw.githubusercontent.com/oyaprotocol/oya-commitments/main/node/production/peers/testnet-directory.json');
            assert.equal(options.redirect, 'error');
            assert.ok(options.signal instanceof AbortSignal);
            return new Response(${JSON.stringify(JSON.stringify(nodes))});
        };`);
    const result = f.run('fetch');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), nodes);
});

test('failed fetches emit no partial list and do not change an existing copy', t => {
    const f = fixture(t), path = join(f.dir, 'registry.json');
    const original = JSON.stringify(nodes); writeFileSync(path, original);
    for (const behavior of [
        'throw new Error("private-marker")',
        'return new Response("private-marker", {status: 404})',
        'return new Response("private-marker", {status: 500})',
        'return new Response("not JSON")',
        'return new Response("{}")',
        'return {ok: true, text: async () => { throw new Error("body interrupted"); }}',
        'await new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason)))',
    ]) {
        f.mock(`const timeout = AbortSignal.timeout;
            AbortSignal.timeout = () => timeout(20);
            // Keep the fixture alive while testing the unref'ed timeout signal.
            const hold = setTimeout(() => {}, 500);
            globalThis.fetch = async (url, options) => { try { ${behavior}; } finally { clearTimeout(hold); } };`);
        const result = f.run('fetch');
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, '');
        assert.ok(!result.stderr.includes('private-marker'));
        assert.equal(readFileSync(path, 'utf8'), original);
    }
    f.mock('globalThis.fetch = async () => new Response("[]");');
    assert.equal(f.run('fetch').status, 0, 'retry recovers without state repair');
});

test('deadline also covers response body reading', t => {
    const f = fixture(t);
    f.mock(`const timeout = AbortSignal.timeout;
        AbortSignal.timeout = () => timeout(20);
        globalThis.fetch = async (url, options) => ({ok: true, text: async () => {
            const hold = setTimeout(() => {}, 500);
            try {
                await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
            } finally { clearTimeout(hold); }
        }});`);
    const result = f.run('fetch');
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
});

test('documented refresh preserves the saved list on failure and replaces it on success', t => {
    const f = fixture(t), saved = join(f.dir, 'testnet-directory.json');
    writeFileSync(saved, JSON.stringify(nodes));
    const guide = readFileSync(new URL('../peers/README.md', import.meta.url), 'utf8');
    const shell = guide.match(/```sh\n(# Set this[\s\S]*?)```/)[1]
        .replace('OYA_SOURCE=/path/to/oya-source', 'OYA_SOURCE="$TEST_SOURCE"');
    const run = () => spawnSync('bash', ['-c', shell], { cwd: f.dir, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, TEST_SOURCE: fileURLToPath(new URL('../../../', import.meta.url)),
            NODE_OPTIONS: `--import=${JSON.stringify(join(f.dir, 'fetch.mjs'))}` } });
    f.mock('globalThis.fetch = async () => new Response("failed", {status: 404});');
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Unable to load peer registry/);
    assert.deepEqual(JSON.parse(readFileSync(saved)), nodes);
    f.mock('globalThis.fetch = async () => new Response("[]");');
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(JSON.parse(readFileSync(saved)), []);
    assert.deepEqual(readdirSync(f.dir).sort(), ['fetch.mjs', 'testnet-directory.json']);
});

test('invalid arguments fail without accessing the network', t => {
    const f = fixture(t);
    for (const args of [['unknown'], ['list', 'one', 'two'], ['fetch', 'https://other.example/']]) {
        const result = f.run(...args);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /Usage:/);
    }
});
