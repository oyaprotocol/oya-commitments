import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseConfig } from '../src/config.mjs';
import { parseGasLimits, projectGasPolicy } from '../src/gas-policy.mjs';
import { fixture } from './runtime-fixture.mjs';

const cli = fileURLToPath(new URL('../scripts/gas-policy.mjs', import.meta.url));
const runtime = fileURLToPath(new URL('../', import.meta.url));
const base = { allowedSigners: ['0x2222222222222222222222222222222222222222'], ipfsUrl: 'http://ipfs.example' };
const parse = input => parseConfig({ ...base, ...input }, { env: {} });

for (const [name, input, expected] of [
    ['defaults', {}, [200000n, 30000000000n, 'default', 'default']],
    ['gas null', { gasLimit: null }, [200000n, 30000000000n, 'default', 'default']],
    ['explicit defaults', { gasLimit: 200000, maxFeePerGasWei: '30000000000' }, [200000n, 30000000000n, 'override', 'override']],
    ['minimum', { gasLimit: 1, maxFeePerGasWei: '1' }, [1n, 1n, 'override', 'override']],
    ['maximum config values', { gasLimit: 2147483647, maxFeePerGasWei: '9'.repeat(78) },
        [2147483647n, BigInt('9'.repeat(78)), 'override', 'override']],
    ['beyond float precision', { gasLimit: 200001, maxFeePerGasWei: '9007199254740993' },
        [200001n, 9007199254740993n, 'override', 'override']],
]) {
    test(`gas projection and runtime preserve ${name}`, () => {
        const [gas, fee, gasOrigin, feeOrigin] = expected;
        const limits = parse(input).limits;
        assert.deepEqual(limits, { gasLimit: gas, feePerGas: fee });
        assert.deepEqual(parseGasLimits(input), limits);
        assert.deepEqual(projectGasPolicy(input), { version: 1, scope: 'offline-config-projection',
            mode: 'ledger', applicable: true, gasLimit: gas.toString(), maxFeePerGasWei: fee.toString(),
            executionGasCeilingWei: (gas * fee).toString(), origins: { gasLimit: gasOrigin, maxFeePerGasWei: feeOrigin } });
    });
}

test('gas parser rejection parity includes null, types, ranges and pathological decimal strings', () => {
    for (const [key, values] of [
        ['gasLimit', [0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '200000', true, [], {}, 1n]],
        ['maxFeePerGasWei', [null, 0, 30000000000, true, [], {}, 1n, '', '0', '01', '+1', '-1', '1.0',
            '1e9', ' 1', '1\n', '１', '9'.repeat(79), '9'.repeat(65536)]],
        ['mode', [null, '', false, 1, [], {}, 'LEDGER']],
    ]) {
        for (const value of values) {
            let runtimeError;
            assert.throws(() => parse({ [key]: value }), error => { runtimeError = error.message; return true; });
            assert.throws(() => projectGasPolicy({ [key]: value }), error => error.message === runtimeError);
        }
    }
    for (const input of [null, false, 1, 'ledger', []]) assert.throws(() => projectGasPolicy(input), /object/);
});

test('IPFS is inapplicable and rejects explicit gas fields even when null or undefined', () => {
    assert.equal(parse({ mode: 'ipfs' }).limits, undefined);
    assert.deepEqual(projectGasPolicy({ mode: 'ipfs' }), { version: 1, scope: 'offline-config-projection',
        mode: 'ipfs', applicable: false, gasLimit: null, maxFeePerGasWei: null, executionGasCeilingWei: null, origins: null });
    for (const key of ['gasLimit', 'maxFeePerGasWei']) {
        for (const value of [null, undefined, 1, '1']) {
            for (const fn of [parse, projectGasPolicy]) assert.throws(() => fn({ mode: 'ipfs', [key]: value }), /IPFS mode/);
        }
    }
});

test('projection ignores unrelated runtime fields and never returns their contents', () => {
    const input = { rpcUrl: 'private-marker', allowedSigners: [], unknown: 'private-marker' };
    assert.throws(() => parse(input));
    assert.equal(JSON.stringify(projectGasPolicy(input)).includes('private-marker'), false);
    assert.equal(projectGasPolicy(input).executionGasCeilingWei, '6000000000000000');
    assert.equal(projectGasPolicy({ gasLimit: 200001, maxFeePerGasWei: '9007199254740993' }).executionGasCeilingWei,
        '1801448858147453340993');
});

function files(t) {
    const directory = mkdtempSync(join(tmpdir(), 'oya-gas-policy-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = join(directory, 'private-marker.json');
    writeFileSync(config, '{}');
    const run = (args = ['--config', config, '--json'], entry = cli, options = []) => spawnSync(process.execPath,
        [...options, entry, ...args], { cwd: directory, encoding: 'utf8', timeout: 5000,
            env: { PATH: process.env.PATH, OYA_NODE_PRIVATE_KEY: 'private-marker',
                OYA_RPC_AUTHORIZATION: 'private-marker', OYA_IPFS_AUTHORIZATION: 'private-marker' } });
    return { directory, config, run };
}

test('Node invokes the CLI directly and through a symlink with read-only permissions', t => {
    const f = files(t);
    const link = join(f.directory, 'gas-policy.mjs');
    symlinkSync(cli, link);
    const before = readFileSync(f.config);
    const names = readdirSync(f.directory);
    for (const entry of [cli, link]) {
        const result = f.run(undefined, entry, ['--permission', `--allow-fs-read=${runtime}`, `--allow-fs-read=${f.directory}`]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.deepEqual(JSON.parse(result.stdout), projectGasPolicy({}));
    }
    const human = f.run(['--config', f.config]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /6000000000000000 wei/);
    assert.match(human.stdout, /not an actual fee estimate or daily budget/);
    assert.deepEqual(readFileSync(f.config), before);
    assert.deepEqual(readdirSync(f.directory), names);
    writeFileSync(f.config, '{"mode":"ipfs"}');
    assert.match(f.run(['--config', f.config]).stdout, /inapplicable/);
});

test('CLI rejects malformed arguments, paths, JSON and special files with sanitized output', t => {
    const f = files(t);
    for (const args of [[], ['--config'], ['--json'], ['--help', '--json'], ['private-marker'],
        ['--config', f.config, '--config', f.config], ['--config', f.config, '--json', '--json'],
        ['--config', f.config, '--private-marker'], ['--config', join(f.directory, 'missing-private-marker')],
        ['--config', f.directory]]) {
        const result = f.run(args);
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, '');
        assert.doesNotMatch(result.stderr, /private-marker|Error:|\n\s+at /);
    }
    for (const data of ['private-marker', '{"private-marker":', 'null', '[]', '{"mode":"private-marker"}',
        '{"maxFeePerGasWei":"private-marker"}', Buffer.from([0xff]), '{}'.padEnd(65537)]) {
        writeFileSync(f.config, data);
        const result = f.run();
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, '');
        assert.doesNotMatch(result.stderr, /private-marker|SyntaxError|\n\s+at /);
    }
    writeFileSync(f.config, '{}'.padEnd(65536));
    assert.equal(f.run().status, 0);
    const link = join(f.directory, 'config-link');
    symlinkSync(f.config, link);
    assert.equal(f.run(['--config', link]).status, 2);
    const fifo = join(f.directory, 'fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    assert.equal(f.run(['--config', fifo]).status, 2, 'FIFO must not block');
    assert.equal(f.run(['--config', '/dev/null']).status, 2);
    assert.equal(f.run(['--help']).status, 0);
});

test('CLI dependency closure denies credentials, network and writes; growing input remains bounded', t => {
    const f = files(t);
    const preload = join(f.directory, 'guard.mjs');
    writeFileSync(preload, `
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
const denied = () => { process.stderr.write(new Error('Forbidden side effect').stack + '\\n'); process.exit(99); };
const allowed = new Set([${JSON.stringify(new URL('../scripts/gas-policy.mjs', import.meta.url).href)},
    ${JSON.stringify(new URL('../src/gas-policy.mjs', import.meta.url).href)}, 'node:fs']);
registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (!allowed.has(result.url)) denied();
    return result;
} });
globalThis.fetch = denied;
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const sources = new Map([${JSON.stringify(cli)}, ${JSON.stringify(fileURLToPath(new URL('../src/gas-policy.mjs', import.meta.url)))}]
    .map(path => [path, fs.readFileSync(path)]));
fs.readFileSync = (path, encoding) => {
    const bytes = sources.get(path instanceof URL ? fileURLToPath(path) : String(path));
    if (!bytes) denied();
    return encoding ? bytes.toString(encoding) : bytes;
};
let selected;
let total = 0;
fs.openSync = (path, flags, ...args) => {
    if (path !== ${JSON.stringify(f.config)} || flags !==
        (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)) denied();
    selected = originalOpen(path, flags, ...args);
    return selected;
};
fs.readSync = (fd, buffer, offset, length, position) => {
    if (fd !== selected || total + length > 65537) denied();
    const count = originalRead(fd, buffer, offset, length, position);
    total += count;
    return count;
};
// Simulate growth between the metadata check and the first read.
fs.fstatSync = () => ({ isFile: () => true, size: 2 });
for (const name of ['writeFileSync', 'appendFileSync', 'unlinkSync', 'renameSync',
    'mkdirSync', 'rmSync', 'createReadStream', 'createWriteStream']) fs[name] = denied;
syncBuiltinESMExports();
process.env = new Proxy(process.env, { get(target, key) {
    if (typeof key === 'string' && key.startsWith('OYA_')) denied();
    return Reflect.get(target, key);
} });
`);
    const run = () => f.run(undefined, cli, ['--import', preload]);
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    writeFileSync(f.config, '{}'.padEnd(65537));
    const result = run();
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /at most 65536 bytes/);
});

for (const [name, overrides] of [['gas', { gasLimit: 32767 }], ['fee', { maxFeePerGasWei: '2' }]]) {
    test(`direct ${name} cap rejects preparation before signing or broadcasting`, async t => {
        const f = await fixture(t, overrides);
        await f.start();
        const response = await f.post();
        assert.equal(response.status, 502);
        assert.equal((await response.json()).loggingOutcome, 'not_submitted');
        assert.equal(f.state.signs, 0);
        assert.equal(f.state.sends, 0);
        assert.ok(f.state.calls.includes(name === 'gas' ? 'eth_estimateGas' : 'eth_maxPriorityFeePerGas'));
    });
}
