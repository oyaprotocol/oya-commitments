import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getAddress } from 'ethers';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { comparePeerDirectories, decodePeerDirectory, DirectoryError, inspectPeerDirectory,
    loadPeerDirectory, MAX_DIRECTORY_BYTES, parsePeerDirectory, sha256 } from '../src/peers/directory.mjs';

const runtime = fileURLToPath(new URL('../', import.meta.url));
const addressA = '0x1111111111111111111111111111111111111111';
const addressB = '0x2222222222222222222222222222222222222222';
const mixedAddress = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
const node = (nodeAddress = addressA, name = 'a') => ({ nodeAddress, receiveUrl: `https://${name}.example/v1/jobs`, target: name });
const directory = () => ({ version: 1, networkId: 'oya-sepolia-v1', revision: 1,
    execution: { mode: 'ledger', chainId: 11155111, ledgerContract: mixedAddress }, nodes: [node()] });
const reject = (action, code) => assert.throws(action, error => error instanceof DirectoryError && error.code === code);
function fixture(t) {
    const path = mkdtempSync(join(tmpdir(), 'oya-peer-directory-'));
    t.after(() => rmSync(path, { recursive: true, force: true }));
    return path;
}

// Offline network sentinels deliberately fail if inspection grows side effects.
test('inspection is deterministic, immutable, offline and separates byte/content identity', () => {
    const raw = directory();
    raw.nodes.push(node(addressB, 'b'));
    const original = JSON.stringify(raw);
    const parsed = parsePeerDirectory(raw);
    assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.execution) && Object.isFrozen(parsed.nodes));
    assert.ok(Object.isFrozen(parsed.nodes[0]));
    assert.throws(() => { parsed.nodes[0].target = 'changed'; }, TypeError);
    const a = inspectPeerDirectory(raw);
    raw.nodes.reverse(); raw.execution.ledgerContract = raw.execution.ledgerContract.toLowerCase();
    raw.revision = 3;
    const b = inspectPeerDirectory(raw);
    assert.equal(a.contentSha256, b.contentSha256);
    assert.deepEqual(a.nodes, b.nodes);
    assert.notEqual(sha256(original), sha256(JSON.stringify(raw)));
    assert.equal(parsed.revision, 1);
    assert.equal(a.runtimeAuthorization, 'unchanged');
    assert.equal(a.bootstrapOnly, false);
    const empty = { ...directory(), nodes: [] };
    assert.equal(inspectPeerDirectory(empty).bootstrapOnly, true);
    assert.equal(inspectPeerDirectory(empty).nodeCount, 0);
});

test('accepts exact grammar, node count, integer and byte boundaries', () => {
    for (const networkId of ['a', 'a'.repeat(64), 'a-._0']) {
        const raw = directory(); raw.networkId = networkId; raw.nodes[0].target = 'a'.repeat(64);
        raw.revision = Number.MAX_SAFE_INTEGER; raw.execution.chainId = Number.MAX_SAFE_INTEGER;
        assert.equal(parsePeerDirectory(raw).networkId, networkId);
    }
    const raw = directory();
    raw.nodes = Array.from({ length: 256 }, (_, i) => node(`0x${(i + 1).toString(16).padStart(40, '0')}`, `n${i}`));
    assert.equal(parsePeerDirectory(raw).nodes.length, 256);
    raw.nodes.push(node(addressB, 'extra'));
    reject(() => parsePeerDirectory(raw), 'invalid_nodes');
    const text = JSON.stringify(directory());
    const exact = Buffer.from(text + ' '.repeat(MAX_DIRECTORY_BYTES - Buffer.byteLength(text)));
    assert.equal(decodePeerDirectory(exact).fileSha256, sha256(exact));
    reject(() => decodePeerDirectory(Buffer.concat([exact, Buffer.from(' ')])), 'directory_too_large');
});

const invalid = [
    ['root null', () => null, 'invalid_directory_fields'],
    ['root array', () => [], 'invalid_directory_fields'],
    ['root extra', d => ({ ...d, secret: 'private-marker' }), 'invalid_directory_fields'],
    ['root missing', d => { delete d.nodes; return d; }, 'invalid_directory_fields'],
    ['version', d => ({ ...d, version: '1' }), 'unsupported_directory_version'],
    ...['', 'a'.repeat(65), 'oya-é', 'A', ' a', 'a\n', 'a\r', 'a\0', 1, null].map(value =>
        [`network ${JSON.stringify(value)}`, d => ({ ...d, networkId: value }), 'invalid_network_id']),
    ...[0, -1, 1.1, '1', null, Number.MAX_SAFE_INTEGER + 1].map(value =>
        [`revision ${value}`, d => ({ ...d, revision: value }), 'invalid_revision']),
    ['execution extra', d => { d.execution.extra = true; return d; }, 'invalid_execution_fields'],
    ['execution null', d => ({ ...d, execution: null }), 'invalid_execution_fields'],
    ['execution mode', d => { d.execution.mode = 'ipfs'; return d; }, 'invalid_execution'],
    ['chain string', d => { d.execution.chainId = '11155111'; return d; }, 'invalid_execution'],
    ['chain zero', d => { d.execution.chainId = 0; return d; }, 'invalid_execution'],
    ['nodes object', d => ({ ...d, nodes: {} }), 'invalid_nodes'],
    ['sparse node array', d => ({ ...d, nodes: Array(1) }), 'invalid_node_fields'],
    ['node null', d => ({ ...d, nodes: [null] }), 'invalid_node_fields'],
    ['node extra', d => { d.nodes[0].token = 'private-marker'; return d; }, 'invalid_node_fields'],
    ['node missing', d => { delete d.nodes[0].target; return d; }, 'invalid_node_fields'],
    ...['', 'A', 'a.b', 'a\n', 'a\0', 'a'.repeat(65), 1, null].map(value =>
        [`target ${JSON.stringify(value)}`, d => { d.nodes[0].target = value; return d; }, 'invalid_target']),
    ...['0x' + '0'.repeat(40), addressA + '\n', '  ' + addressA, '0X' + '1'.repeat(40),
        '0x123', 1, null, mixedAddress.replace('a', 'A')].map(value =>
        [`address ${value}`, d => { d.nodes[0].nodeAddress = value; return d; }, 'invalid_address']),
    ...['http://a.example/v1/jobs', 'https://u:p@a.example/v1/jobs', 'https://a.example/v1/jobs?',
        'https://a.example/v1/jobs#', 'https://a.example/v1/jobs?q=x', 'https://a.example/v1/jobs#x',
        'https://a.example/v1/jobs/', 'https://a.example/v1/worker/claim', 'https://a.example/./v1/jobs',
        'https://a.example/v1/%6aobs', 'https://a.example./v1/jobs', 'https://A.example/v1/jobs', 'https://a.example:443/v1/jobs',
        'https://a.example\\v1/jobs', ' https://a.example/v1/jobs', 'https://a.example/v1/jobs\n',
        'https://é.example/v1/jobs', 'https://' + 'a'.repeat(2048) + '/v1/jobs', null, 1].map(value =>
        [`url ${String(value).slice(0, 70)}`, d => { d.nodes[0].receiveUrl = value; return d; }, 'invalid_receive_url']),
];
for (const [name, mutate, code] of invalid) test(`rejects ${name}`, () => reject(() => parsePeerDirectory(mutate(directory())), code));

test('nonzero and checksum validation applies to Ledger as well as node addresses', () => {
    for (const value of ['0x' + '0'.repeat(40), mixedAddress.replace('a', 'A')]) {
        const raw = directory(); raw.execution.ledgerContract = value;
        reject(() => parsePeerDirectory(raw), 'invalid_address');
    }
    const raw = directory(); raw.nodes[0].nodeAddress = mixedAddress.toLowerCase();
    assert.equal(parsePeerDirectory(raw).nodes[0].nodeAddress, mixedAddress);
    raw.nodes[0].nodeAddress = '0x' + mixedAddress.slice(2).toUpperCase();
    assert.equal(parsePeerDirectory(raw).nodes[0].nodeAddress, mixedAddress);
});

test('rejects duplicate addresses independent of casing and duplicate routes/targets', () => {
    for (const [record, code] of [
        [node(mixedAddress.toLowerCase(), 'b'), 'duplicate_node_address'],
        [{ ...node(addressB, 'b'), receiveUrl: 'https://a.example/v1/jobs' }, 'duplicate_receive_url'],
        [{ ...node(addressB, 'b'), target: 'a' }, 'duplicate_target'],
    ]) {
        const raw = directory(); raw.nodes = [node(mixedAddress), record];
        reject(() => parsePeerDirectory(raw), code);
    }
});

test('URL validation is syntax only: no claim of routability or endpoint authorization', () => {
    for (const url of ['https://127.0.0.1/v1/jobs', 'https://[::1]/v1/jobs', 'https://a.example:8443/v1/jobs']) {
        const raw = directory(); raw.nodes[0].receiveUrl = url;
        assert.equal(parsePeerDirectory(raw).nodes[0].receiveUrl, url);
    }
});

test('comparison detects additions/removals/route edits and rejects stale revisions and domain drift', () => {
    const base = directory(), candidate = directory();
    candidate.revision = 2;
    candidate.nodes[0].receiveUrl = 'https://new.example/v1/jobs';
    candidate.nodes.push(node(addressB, 'b'));
    const result = comparePeerDirectories(base, candidate);
    assert.equal(result.changed, true);
    assert.deepEqual(result.added, [node(addressB, 'b')]);
    assert.deepEqual(result.updated, [{ before: node(), after: candidate.nodes[0] }]);
    assert.deepEqual(result.removed, []);
    const rotated = { ...base, revision: 3, nodes: [node(addressB, 'b')] };
    assert.deepEqual(comparePeerDirectories(base, rotated).removed, [node()]);
    for (const revision of [1, 0]) {
        candidate.revision = revision;
        reject(() => comparePeerDirectories(base, candidate), revision ? 'directory_revision_not_advanced' : 'invalid_revision');
    }
    reject(() => comparePeerDirectories({ ...base, revision: 3 }, { ...base, revision: 2 }), 'directory_revision_not_advanced');
    assert.equal(comparePeerDirectories(base, { ...base, revision: 9 }).changed, false);
    for (const mutate of [d => { d.networkId = 'other'; }, d => { d.execution.chainId++; },
        d => { d.execution.ledgerContract = addressB; }]) {
        const changed = directory(); changed.revision = 2; mutate(changed);
        reject(() => comparePeerDirectories(base, changed), 'directory_domain_changed');
    }
    const removed = { ...base, revision: 2, nodes: [] };
    assert.deepEqual(comparePeerDirectories(base, removed).removed, [node()]);
});

test('bounded file loader fails closed and recovers after explicit repair without rewriting', t => {
    const dir = fixture(t), path = join(dir, 'directory.json');
    reject(() => loadPeerDirectory(path), 'directory_read_failed');
    reject(() => loadPeerDirectory(dir), 'directory_not_regular');
    for (const bad of [Buffer.from('{"private-marker":'), Buffer.from([0xff]), Buffer.from('\ufeff{}'), Buffer.from('null')]) {
        writeFileSync(path, bad);
        assert.throws(() => loadPeerDirectory(path), DirectoryError);
        assert.deepEqual(readFileSync(path), bad);
    }
    writeFileSync(path, Buffer.alloc(MAX_DIRECTORY_BYTES + 1, 32));
    reject(() => loadPeerDirectory(path), 'directory_too_large');
    const bytes = Buffer.from(JSON.stringify(directory())); writeFileSync(path, bytes);
    assert.equal(loadPeerDirectory(path).fileSha256, sha256(bytes));
    symlinkSync(path, join(dir, 'link'));
    reject(() => loadPeerDirectory(join(dir, 'link')), 'directory_read_failed');
    execFileSync('mkfifo', [join(dir, 'pipe')]);
    reject(() => loadPeerDirectory(join(dir, 'pipe')), 'directory_not_regular');
    assert.deepEqual(readFileSync(path), bytes);
});

test('loader handles short reads and rejects growth/truncation during reading', t => {
    const dir = fixture(t), path = join(dir, 'directory.json');
    const bytes = Buffer.from(JSON.stringify(directory()));
    const read = fs.readSync;
    for (const mode of ['short', 'grow', 'truncate']) {
        writeFileSync(path, bytes);
        let calls = 0;
        const mocked = t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
            const count = read(fd, buffer, offset, Math.min(length, 11), position);
            if (++calls === 1 && mode !== 'short') {
                writeFileSync(path, mode === 'grow' ? Buffer.alloc(MAX_DIRECTORY_BYTES + 1, 32) : Buffer.from('{'));
            }
            return count;
        });
        syncBuiltinESMExports();
        try {
            if (mode === 'short') assert.equal(loadPeerDirectory(path).fileSha256, sha256(bytes));
            else reject(() => loadPeerDirectory(path), mode === 'grow' ? 'directory_too_large' : 'directory_changed_during_read');
        } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
    }
    writeFileSync(path, bytes);
    assert.equal(loadPeerDirectory(path).fileSha256, sha256(bytes));
});

test('CLI subprocess is offline, sanitized, read-only and repeatable after failure', t => {
    const dir = fixture(t), path = join(dir, 'directory.json'), base = join(dir, 'base.json');
    const guard = join(dir, 'offline.mjs');
    writeFileSync(guard, `import { syncBuiltinESMExports } from 'node:module';
import dns from 'node:dns'; import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
const stop = () => { throw new Error('unexpected network'); };
globalThis.fetch = stop; dns.lookup = stop; dns.resolve = stop;
net.connect = stop; net.createConnection = stop; net.Socket.prototype.connect = stop;
http.request = stop; http.get = stop; https.request = stop; https.get = stop;
syncBuiltinESMExports();\n`);
    const run = (...args) => spawnSync(process.execPath, ['--import', guard, join(runtime, 'scripts/peer-directory.mjs'), ...args], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, OYA_NODE_PRIVATE_KEY: 'private-marker' },
    });
    assert.equal(run().status, 2); assert.equal(run('inspect', path, 'extra').status, 2);
    assert.equal(run('inspect', path).status, 1);
    writeFileSync(path, '{"token":"private-marker"');
    const failed = run('inspect', path);
    assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    assert.deepEqual(JSON.parse(failed.stderr), { error: 'invalid_directory_json' });
    assert.ok(!failed.stderr.includes(path) && !failed.stderr.includes('private-marker'));
    writeFileSync(path, JSON.stringify(directory())); writeFileSync(base, readFileSync(path));
    const before = readFileSync(path), first = run('inspect', path), second = run('inspect', path);
    assert.equal(first.status, 0, first.stderr); assert.equal(first.stderr, '');
    assert.equal(first.stdout, second.stdout); assert.deepEqual(readFileSync(path), before);
    assert.equal(JSON.parse(first.stdout).fileSha256, sha256(before));
    assert.equal(JSON.parse(run('compare', base, path).stdout).changed, false);
    const changed = directory(); changed.nodes = [];
    writeFileSync(path, JSON.stringify(changed));
    assert.equal(run('compare', base, path).status, 1);
    changed.revision = 2; writeFileSync(path, JSON.stringify(changed));
    const recovery = run('compare', base, path);
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.deepEqual(JSON.parse(recovery.stdout).removed, [node()]);
});
