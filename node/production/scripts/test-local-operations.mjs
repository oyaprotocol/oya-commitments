import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';

const execute = promisify(execFile);
const production = fileURLToPath(new URL('../', import.meta.url));

async function freePort() {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

test('local CLI simulates, deploys, records, and reuses Logger on Anvil', { timeout: 180_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'oya-local-operations-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const port = await freePort();
    const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], {
        stdio: 'ignore',
    });
    const stopped = once(anvil, 'exit');
    stopped.catch(() => {});
    t.after(async () => {
        if (anvil.exitCode !== null || anvil.signalCode !== null) return;
        anvil.kill('SIGTERM');
        const timer = setTimeout(() => anvil.kill('SIGKILL'), 5000);
        try { await stopped; } finally { clearTimeout(timer); }
    });
    const rpcUrl = `http://127.0.0.1:${port}`;
    const rpc = async (method, params = []) => {
        const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(1000) });
        const body = await response.json();
        if (body.error) throw new Error('Fixture RPC failed.');
        return body.result;
    };
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        if (anvil.exitCode !== null || anvil.signalCode !== null) throw new Error('Fixture Anvil exited.');
        try { ready = await rpc('eth_chainId') === '0x7a69'; } catch {}
        if (ready) break;
        await delay(100);
    }
    assert.ok(ready, 'fixture Anvil must start');

    const deployer = Wallet.createRandom();
    await rpc('anvil_setBalance', [deployer.address, '0x56bc75e2d63100000']);
    const configPath = join(directory, 'config.local.json');
    const envPath = join(directory, 'node.env');
    const metadataPath = join(directory, 'deployment.local.json');
    const config = { chainId: 31337, loggerContract: '0x1111111111111111111111111111111111111111',
        allowedSigners: [Wallet.createRandom().address],
        rpcUrl, ipfsUrl: 'http://127.0.0.1:1',
        pollIntervalMs: 50, receiptTimeoutMs: 5000 };
    const original = `${JSON.stringify(config, null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });
    await chmod(configPath, 0o640);
    const credentials = `LOGGER_DEPLOYER_PK=${deployer.privateKey}\nOYA_RPC_AUTHORIZATION=\n`;
    await writeFile(envPath, credentials, { mode: 0o600 });
    const inherited = Wallet.createRandom();
    const env = { ...process.env, LOGGER_DEPLOYER_PK: inherited.privateKey,
        OYA_NODE_PRIVATE_KEY: 'unused-node-secret-marker',
        FOUNDRY_ETH_RPC_URL: 'http://127.0.0.1:1', LOGGER_CHAIN_ID: '1' };
    const cli = async (...flags) => {
        try {
            const result = await execute('npm', ['--prefix', production, 'run', 'local', '--', 'deploy-logger',
                '--config', 'config.local.json', '--env-file', 'node.env', ...flags], {
                cwd: directory, env, timeout: 120_000, maxBuffer: 1_048_576,
            });
            return { code: 0, output: result.stdout + result.stderr };
        } catch (error) {
            return { code: error.code, output: (error.stdout ?? '') + (error.stderr ?? '') };
        }
    };
    const checked = (result, code, pattern) => {
        for (const secret of [deployer.privateKey, inherited.privateKey, 'secret-marker']) {
            assert.equal(result.output.includes(secret), false, 'CLI output must redact credentials');
        }
        assert.equal(result.code, code, result.output);
        assert.match(result.output, pattern);
    };
    await writeFile(configPath, JSON.stringify({ ...config, chainId: 1 }));
    checked(await cli('--broadcast'), 1, /FAIL.*chainId/);
    assert.equal(await rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x0');
    await writeFile(configPath, original);

    checked(await cli(), 0, /Simulation passed/);
    assert.equal(await rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x0');
    assert.equal(await readFile(configPath, 'utf8'), original);
    await assert.rejects(readFile(metadataPath), { code: 'ENOENT' });

    checked(await cli('--broadcast'), 0, /Deployment recorded/);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const updated = JSON.parse(await readFile(configPath, 'utf8'));
    const receipt = await rpc('eth_getTransactionReceipt', [metadata.transactionHash]);
    assert.deepEqual(updated, { ...config, loggerContract: receipt.contractAddress });
    assert.deepEqual(metadata, { chainId: 31337, loggerContract: receipt.contractAddress,
        transactionHash: receipt.transactionHash, blockNumber: BigInt(receipt.blockNumber).toString(), deployer: deployer.address });
    assert.equal(receipt.status, '0x1');
    assert.notEqual(await rpc('eth_getCode', [updated.loggerContract, 'latest']), '0x');
    assert.equal((await stat(configPath)).mode & 0o777, 0o640);
    assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(envPath, 'utf8'), credentials);
    const files = await readdir(directory);
    for (const name of files.filter((name) => name.startsWith('.oya-logger-'))) {
        assert.equal((await stat(join(directory, name))).mode & 0o777, 0o700);
    }
    const before = await Promise.all([configPath, metadataPath].map((path) => readFile(path, 'utf8')));
    await writeFile(envPath, 'LOGGER_DEPLOYER_PK=\nOYA_RPC_AUTHORIZATION=\n');
    checked(await cli('--broadcast'), 0, /Reusing configured Logger/);
    assert.equal(await rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x1');
    assert.deepEqual(await readdir(directory), files);
    assert.deepEqual(await Promise.all([configPath, metadataPath].map((path) => readFile(path, 'utf8'))), before);
});
