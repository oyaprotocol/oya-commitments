import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Wallet } from 'ethers';
import { loadLocalConfig } from '../scripts/local-config.mjs';
import { deployLogger, deploymentPath } from '../scripts/local-deploy.mjs';
import { main } from '../scripts/local-node.mjs';

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'oya-deploy-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const deployer = Wallet.createRandom();
    const address = Wallet.createRandom().address;
    const hash = `0x${'ab'.repeat(32)}`;
    const configPath = join(directory, 'settings.json');
    const envPath = join(directory, 'node.env');
    const input = { chainId: 31337, loggerContract: '0x1111111111111111111111111111111111111111',
        allowedSigners: [address], rpcUrl: 'http://127.0.0.1:1/rpc-secret-marker', ipfsUrl: 'http://127.0.0.1:1',
        receiptTimeoutMs: 30, pollIntervalMs: 1 };
    const original = `${JSON.stringify(input, null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });
    await chmod(configPath, 0o640);
    await writeFile(envPath, `LOGGER_DEPLOYER_PK=${deployer.privateKey}\n`, { mode: 0o600 });
    const output = [];
    const log = (line) => output.push(line);
    const settings = await loadLocalConfig(configPath, envPath, { log, env: {
        PATH: process.env.PATH, LOGGER_DEPLOYER_PK: 'wrong-secret-marker', LOGGER_CHAIN_ID: '1',
        OYA_NODE_PRIVATE_KEY: 'node-secret-marker', OYA_AGENT_PRIVATE_KEY: 'agent-secret-marker',
        OYA_IPFS_AUTHORIZATION: 'ipfs-secret-marker', FOUNDRY_ETH_RPC_URL: 'wrong-secret-marker',
    } });
    const receipt = { transactionHash: hash, transactionIndex: '0x0', blockHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '0x1', from: deployer.address, to: null, contractAddress: address,
        cumulativeGasUsed: '0x20000', gasUsed: '0x20000', logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1' };
    const artifact = { chain: 31337, transactions: [{ hash, contractName: 'Logger', transactionType: 'CREATE',
        contractAddress: address, transaction: { from: deployer.address, to: null } }] };
    const state = { chain: '0x7a69', configuredCode: '0x', deployedCode: '0x6000', receipt, artifact, forgeError: false };
    const commands = [];
    const calls = [];
    const fetch = async (_url, options) => {
        const { method, params, id } = JSON.parse(options.body);
        calls.push(method);
        let result;
        if (method === 'eth_chainId') result = state.chain;
        else if (method === 'eth_getCode') result = params[0] === input.loggerContract ? state.configuredCode : state.deployedCode;
        else if (method === 'eth_getTransactionReceipt') result = state.receipt;
        else throw new Error('Unexpected RPC method.');
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    const execute = async (command, args, options) => {
        commands.push({ command, args, options });
        assert.equal(command, 'forge');
        if (args.includes('--broadcast')) {
            const destination = join(options.env.FOUNDRY_BROADCAST, 'DeployLogger.s.sol', '31337');
            await mkdir(destination, { recursive: true });
            await writeFile(join(destination, 'run-latest.json'), JSON.stringify(state.artifact));
        }
        if (state.forgeError) throw new Error('forge-secret-marker');
    };
    t.after(() => {
        assert.equal(output.join('\n').includes('secret-marker'), false);
        assert.equal(output.join('\n').includes(deployer.privateKey), false);
    });
    return { directory, configPath, envPath, original, input, address, hash, deployer, settings, state, output, calls, commands, execute,
        run: (options = {}) => deployLogger(configPath, settings, { execute, fetch, log, ...options }) };
}

test('simulation uses only selected deployment settings and leaves config and metadata untouched', async (t) => {
    const f = await fixture(t);
    assert.equal(await f.run(), 0);
    const [{ args, options }] = f.commands;
    assert.equal(args.includes('--broadcast'), false);
    assert.equal(args.includes('--resume'), false);
    assert.equal(args.join(' ').includes('secret-marker'), false);
    assert.equal(args.join(' ').includes(f.deployer.privateKey), false);
    assert.equal(options.env.LOGGER_CHAIN_ID, '31337');
    assert.equal(options.env.LOGGER_DEPLOYER_PK, f.deployer.privateKey);
    assert.equal(options.env.FOUNDRY_ETH_RPC_URL, f.input.rpcUrl);
    assert.equal(options.env.FOUNDRY_ETH_RPC_HEADERS, undefined);
    for (const key of ['OYA_NODE_PRIVATE_KEY', 'OYA_AGENT_PRIVATE_KEY', 'OYA_IPFS_AUTHORIZATION', 'OYA_RPC_AUTHORIZATION']) {
        assert.equal(options.env[key], undefined);
    }
    assert.equal(await readFile(f.configPath, 'utf8'), f.original);
    await assert.rejects(readFile(deploymentPath(f.configPath)), { code: 'ENOENT' });
    assert.deepEqual(f.calls, ['eth_chainId', 'eth_getCode']);
});

test('verified broadcast records public metadata and atomically preserves other config values and permissions', async (t) => {
    const f = await fixture(t);
    const originalInode = (await stat(f.configPath)).ino;
    assert.equal(await f.run({ broadcast: true }), 0);
    assert.ok(f.commands[0].args.includes('--broadcast'));
    assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), { ...f.input, loggerContract: f.address });
    assert.notEqual((await stat(f.configPath)).ino, originalInode);
    assert.equal((await stat(f.configPath)).mode & 0o777, 0o640);
    assert.equal((await stat(deploymentPath(f.configPath))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(deploymentPath(f.configPath), 'utf8')), {
        chainId: 31337, loggerContract: f.address, transactionHash: f.hash, blockNumber: '1', deployer: f.deployer.address,
    });
    assert.equal(deploymentPath(join(f.directory, 'config.local.json')), join(f.directory, 'deployment.local.json'));
    assert.notEqual(deploymentPath(join(f.directory, 'settings.json')), deploymentPath(join(f.directory, 'settings.txt')));
});

test('reuse requires no deployment or node key, invokes no Forge, and changes no files', async (t) => {
    const f = await fixture(t);
    f.state.configuredCode = '0x6000';
    delete f.settings.env.LOGGER_DEPLOYER_PK;
    const files = await readdir(f.directory);
    assert.equal(await f.run({ broadcast: true }), 0);
    assert.equal(f.commands.length, 0);
    assert.deepEqual(await readdir(f.directory), files);
    assert.equal(await readFile(f.configPath, 'utf8'), f.original);
});

test('preflight failures stop before Forge or configuration changes', async (t) => {
    for (const reason of ['chain', 'key', 'code', 'record', 'symlink', 'hardlink', 'authorization']) await t.test(reason, async (t) => {
        const f = await fixture(t);
        if (reason === 'chain') f.state.chain = '0x1';
        if (reason === 'key') f.settings.env.LOGGER_DEPLOYER_PK = '';
        if (reason === 'code') f.state.configuredCode = 'provider-secret-marker';
        if (reason === 'record') await writeFile(deploymentPath(f.configPath), 'existing-record');
        if (reason === 'authorization') {
            f.settings.config = { ...f.settings.config,
                rpc: { ...f.settings.config.rpc, headers: { authorization: 'Bearer rpc-secret-marker' } } };
        }
        if (reason === 'hardlink') await link(f.configPath, join(f.directory, 'alias.json'));
        if (reason === 'symlink') {
            await writeFile(join(f.directory, 'target.json'), f.original);
            await rm(f.configPath);
            await symlink(join(f.directory, 'target.json'), f.configPath);
        }
        assert.equal(await f.run({ broadcast: true }), 1);
        assert.equal(f.commands.length, 0);
        if (reason === 'authorization') assert.equal(f.calls.length, 0);
        assert.equal(await readFile(f.configPath, 'utf8'), f.original);
    });
});

test('failed or unverified broadcasts retain artifacts, leave config unchanged, and never retry', async (t) => {
    for (const reason of ['forge', 'artifact', 'reverted', 'sender', 'address', 'missing-code', 'missing-receipt']) await t.test(reason, async (t) => {
        const f = await fixture(t);
        if (reason === 'forge') f.state.forgeError = true;
        if (reason === 'artifact') f.state.artifact.chain = 1;
        if (reason === 'reverted') f.state.receipt.status = '0x0';
        if (reason === 'sender') f.state.receipt.from = f.address;
        if (reason === 'address') f.state.receipt.contractAddress = f.input.loggerContract;
        if (reason === 'missing-code') f.state.deployedCode = '0x';
        if (reason === 'missing-receipt') f.state.receipt = null;
        assert.equal(await f.run({ broadcast: true }), 1);
        assert.equal(f.commands.length, 1);
        assert.equal(await readFile(f.configPath, 'utf8'), f.original);
        await assert.rejects(readFile(deploymentPath(f.configPath)), { code: 'ENOENT' });
        assert.ok((await readdir(f.directory)).some((name) => name.startsWith('.oya-logger-')));
        if (reason === 'forge') assert.ok(f.output.some((line) => line.includes(f.hash)));
    });
});

test('operator edits during deployment are preserved and the verified address is reported for recovery', async (t) => {
    const f = await fixture(t);
    const edited = JSON.stringify({ ...f.input, port: 9090 });
    assert.equal(await f.run({ broadcast: true, execute: async (...args) => {
        await f.execute(...args);
        await writeFile(f.configPath, edited);
    } }), 1);
    assert.equal(await readFile(f.configPath, 'utf8'), edited);
    assert.ok(f.output.some((line) => line.includes(`Verified Logger ${f.address}`)));
    assert.match(f.output.join('\n'), /Adopt the verified address manually/);
});

test('broadcast flag is rejected for every non-deployment action before effects', async () => {
    for (const action of ['setup', 'check', 'run', 'status']) {
        const output = [];
        assert.equal(await main([action, '--broadcast'], { log: (line) => output.push(line), execute: () => {
            assert.fail('Invalid arguments must not execute a child process.');
        } }), 1);
        assert.match(output[0], /Invalid arguments/);
    }
});
