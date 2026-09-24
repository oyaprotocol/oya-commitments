import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Wallet } from 'ethers';

const runtime = fileURLToPath(new URL('../', import.meta.url));
const script = join(runtime, 'scripts/deploy-droplet.sh');

function fixture(t, mode = '') {
    const directory = mkdtempSync(join(tmpdir(), 'oya-deploy-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const remote = join(directory, 'remote home');
    const bin = join(directory, 'bin');
    mkdirSync(remote);
    mkdirSync(bin);
    const config = JSON.parse(readFileSync(join(runtime, 'docker/config.example.json')));
    config.operationTimeoutMs = 300001;
    const configFile = join(directory, 'private config.json');
    const envFile = join(directory, 'private node.env');
    const privateKey = Wallet.createRandom().privateKey;
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(envFile, `OYA_NODE_PRIVATE_KEY=${privateKey}\nOYA_RPC_AUTHORIZATION=\nOYA_IPFS_AUTHORIZATION=\n`);
    const executable = (name, body) => writeFileSync(join(bin, name), body, { mode: 0o755 });
    executable('uname', '#!/bin/sh\necho Linux\n');
    executable('id', '#!/bin/sh\necho 1000\n');
    executable('ssh', `#!/usr/bin/env bash
set -euo pipefail
[[ $* == *StrictHostKeyChecking=yes* && $* == *BatchMode=yes* ]]
export OYA_DEPLOY_DIR="$TEST_REMOTE/oya"
for command in "$@"; do :; done
exec bash -c "$command"
`);
    executable('docker', `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + '\\n');
const mode = process.env.TEST_MODE;
if (args[0] === 'info') console.log(mode === 'architecture' ? 'linux/arm64' : 'linux/amd64');
else if (args[0] === 'ps' && mode === 'containers') console.log('existing-container');
else if (args[0] === 'volume' && mode === 'volumes') console.log('oya_ipfs-data');
else if (args[0] === 'build' && mode === 'build') process.exit(1);
else if (args[0] === 'image' && args[1] === 'save') process.stdout.write('test image');
else if (args[0] === 'image' && args[1] === 'load') {
    readFileSync(0);
    if (mode === 'transfer') process.exit(1);
} else if (args[0] === 'compose') {
    if (args[1] === 'version') console.log(mode === 'version' ? 'v2.29.0' : 'v2.31.0');
    if (args.includes('-e')) {
        const deployment = join(process.env.TEST_REMOTE, 'oya');
        const code = args.at(-1).replace('"/config/node.json"', JSON.stringify(join(deployment, 'node.json')));
        const settings = Object.fromEntries(readFileSync(join(deployment, 'node.env'), 'utf8').trim().split('\\n').map(line => {
            const equals = line.indexOf('=');
            return [line.slice(0, equals), line.slice(equals + 1)];
        }));
        try {
            execFileSync(process.execPath, ['--input-type=module', '-e', code], {
                cwd: process.env.TEST_RUNTIME, env: { ...process.env, ...settings }, stdio: 'inherit',
            });
        } catch { process.exit(1); }
    }
    if (args.includes('caddy') && mode === 'caddy') process.exit(1);
    if (args[1] === 'up' && mode === 'startup') process.exit(1);
}
`);
    const run = (args = ['oya@example.com', 'node.example.com', configFile, envFile]) => spawnSync('bash', [script, ...args], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_REMOTE: remote,
            TEST_LOG: join(directory, 'commands'), TEST_MODE: mode, TEST_RUNTIME: runtime },
        encoding: 'utf8', timeout: 20_000,
    });
    const commands = () => {
        try { return readFileSync(join(directory, 'commands'), 'utf8').trim().split('\n').map(JSON.parse); }
        catch { return []; }
    };
    return { run, commands, remote, configFile, envFile, config, privateKey };
}

test('first deployment transfers only required files, preserves secrets, and derives longer deadlines', (t) => {
    const f = fixture(t);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const deployment = join(f.remote, 'oya');
    assert.deepEqual(readdirSync(deployment).sort(), ['compose.env', 'compose.yaml', 'docker', 'image.yaml', 'node.env', 'node.json']);
    assert.equal(readFileSync(join(deployment, 'node.env'), 'utf8'), readFileSync(f.envFile, 'utf8'));
    assert.equal(statSync(deployment).mode & 0o777, 0o700);
    assert.equal(statSync(join(deployment, 'node.env')).mode & 0o777, 0o600);
    assert.equal(statSync(join(deployment, 'node.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(deployment, 'docker/Caddyfile')).mode & 0o777, 0o644);
    const exports = execFileSync('bash', ['-c', 'source "$1"; printf "%s %s %s" "$OYA_PROXY_RESPONSE_TIMEOUT" "$OYA_STOP_GRACE_PERIOD" "$OYA_PROXY_STOP_GRACE_PERIOD"', 'bash', join(deployment, 'compose.env')], {
        encoding: 'utf8',
    });
    assert.equal(exports, '361s 361s 421s');
    assert.ok(f.commands().some(args => args[0] === 'build' && args.includes('linux/amd64')));
    assert.ok(f.commands().some(args => args[1] === 'up' && args.includes('--no-build') && args.includes('--wait')));
    assert.ok(f.commands().filter(args => args[1] === 'config').every(args => args.includes('--quiet')));
    assert.equal((result.stdout + result.stderr).includes(f.privateKey), false);
    assert.notEqual(f.run().status, 0, 'must refuse repeated deployment');
    assert.equal(f.commands().filter(args => args[0] === 'build').length, 1);
});

test('existing state, wrong platform, and old Compose stop before the local build', async (t) => {
    for (const mode of ['containers', 'volumes', 'architecture', 'version', 'directory']) {
        await t.test(mode, (t) => {
            const f = fixture(t, mode);
            if (mode === 'directory') mkdirSync(join(f.remote, 'oya'));
            assert.notEqual(f.run().status, 0);
            assert.equal(f.commands().some(args => args[0] === 'build'), false);
        });
    }
});

test('failed build, transfer, validation, and startup never retry or delete remote state', async (t) => {
    for (const mode of ['build', 'transfer', 'key', 'config', 'caddy', 'startup']) {
        await t.test(mode, (t) => {
            const f = fixture(t, mode);
            if (mode === 'key') writeFileSync(f.envFile, 'OYA_NODE_PRIVATE_KEY=private-invalid-marker\n');
            if (mode === 'config') writeFileSync(f.configFile, JSON.stringify({ ...f.config, host: '127.0.0.1' }));
            const result = f.run();
            assert.notEqual(result.status, 0);
            assert.equal(f.commands().filter(args => args[1] === 'up').length, mode === 'startup' ? 1 : 0);
            assert.equal(f.commands().some(args => args.includes('down') || args.includes('restart') || args.includes('rm')), false);
            assert.equal((result.stdout + result.stderr).includes('private-invalid-marker'), false);
            assert.equal((result.stdout + result.stderr).includes(f.privateKey), false);
        });
    }
});

test('unsafe SSH targets and hostnames are rejected before contacting the host', (t) => {
    const f = fixture(t);
    for (const [target, hostname] of [['-oProxyCommand=bad', 'node.example.com'], ['host;exit', 'node.example.com'],
        ['oya@example.com', 'https://node.example.com'], ['oya@example.com', 'node.example.com;exit']]) {
        assert.notEqual(f.run([target, hostname, f.configFile, f.envFile]).status, 0);
    }
    assert.deepEqual(f.commands(), []);
});
