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
import { parseArgs, promisify } from 'node:util';
import { Interface, Wallet, keccak256, toUtf8Bytes } from 'ethers';

const execute = promisify(execFile);
const production = fileURLToPath(new URL('../', import.meta.url));
const { values: { verbose } } = parseArgs({ options: { verbose: { type: 'boolean', default: false } } });
const progress = (message) => { if (verbose) console.log(`[local] ${message}`); };

async function freePort() {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function until(check, running) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (running?.closed()) throw new Error('Fixture process exited before becoming ready.');
        try { const result = await check(); if (result) return result; } catch {}
        await delay(100);
    }
    throw new Error('Timed out waiting for a local fixture process.');
}

async function command(file, args, options) {
    try {
        const result = await execute(file, args, { timeout: 60_000, maxBuffer: 1_048_576, ...options });
        return { code: 0, output: result.stdout + result.stderr };
    } catch (error) {
        return { code: error.code, output: (error.stdout ?? '') + (error.stderr ?? '') };
    }
}

test('local CLI deploys Logger, publishes from a separate agent, and preserves identity across restart', { timeout: 180_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'oya-local-operations-'));
    const processes = [];
    t.after(async () => {
        try {
            for (const running of processes.toReversed()) {
                if (!running.closed()) {
                    try {
                        if (process.platform === 'win32') running.child.kill('SIGKILL');
                        else process.kill(-running.child.pid, 'SIGKILL'); // Only this fixture's process group.
                    } catch (error) { if (error.code !== 'ESRCH') throw error; }
                }
                await running.exited.catch(() => {});
            }
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(OYA_|LOGGER_|FOUNDRY_|IPFS_)/.test(key)));
    const background = (file, args, env = baseEnv) => {
        const child = spawn(file, args, { cwd: directory, env, detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let closed = false;
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        const exited = new Promise((resolve, reject) => {
            child.once('error', () => reject(new Error('Could not launch a local fixture process.')));
            child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
        });
        exited.catch(() => {});
        const running = { child, exited, closed: () => closed, output: () => output };
        processes.push(running);
        return running;
    };
    const stop = async (running, signal = 'SIGTERM') => {
        assert.equal(running.closed(), false, 'fixture process should still be running');
        running.child.kill(signal);
        await until(running.closed);
        return running.exited;
    };
    const port = await freePort();
    progress('Starting disposable Anvil...');
    const anvil = background('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent']);
    const rpcUrl = `http://127.0.0.1:${port}`;
    const rpc = async (method, params = []) => {
        const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(1000) });
        const body = await response.json();
        if (body.error) throw new Error('Fixture RPC failed.');
        return body.result;
    };
    await until(async () => await rpc('eth_chainId') === '0x7a69', anvil);
    progress(`Anvil ready at ${rpcUrl}; chain 31337.`);

    const deployer = Wallet.createRandom();
    const nodeWallet = Wallet.createRandom();
    const agent = Wallet.createRandom();
    const disallowed = Wallet.createRandom();
    const inherited = Wallet.createRandom();
    progress(`Deployer: ${deployer.address}; node: ${nodeWallet.address}; agent: ${agent.address}.`);
    await rpc('anvil_setBalance', [deployer.address, '0x56bc75e2d63100000']);
    const configPath = join(directory, 'config.local.json');
    const envPath = join(directory, 'node.env');
    const metadataPath = join(directory, 'deployment.local.json');
    const config = { chainId: 31337, loggerContract: '0x1111111111111111111111111111111111111111',
        allowedSigners: [agent.address],
        rpcUrl, ipfsUrl: 'http://127.0.0.1:1',
        pollIntervalMs: 50, receiptTimeoutMs: 5000 };
    const original = `${JSON.stringify(config, null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });
    await chmod(configPath, 0o640);
    const credentials = `LOGGER_DEPLOYER_PK=${deployer.privateKey}\nOYA_RPC_AUTHORIZATION=\n`;
    await writeFile(envPath, credentials, { mode: 0o600 });
    const env = { ...baseEnv, LOGGER_DEPLOYER_PK: inherited.privateKey,
        OYA_NODE_PRIVATE_KEY: 'unused-node-secret-marker',
        FOUNDRY_ETH_RPC_URL: 'http://127.0.0.1:1', LOGGER_CHAIN_ID: '1' };
    const cli = (action, ...flags) => command('npm', ['--prefix', production, 'run', 'local', '--', action,
        '--config', 'config.local.json', '--env-file', 'node.env', ...flags], { cwd: directory, env, timeout: 120_000 });
    const redacted = (output) => {
        for (const secret of [deployer, nodeWallet, agent, disallowed, inherited].map((wallet) => wallet.privateKey).concat('secret-marker')) {
            assert.equal(output.includes(secret), false, 'Fixture output must redact credentials');
        }
    };
    const checked = (result, code, pattern) => {
        redacted(result.output);
        assert.equal(result.code, code, result.output);
        if (pattern) assert.match(result.output, pattern);
    };
    await writeFile(configPath, JSON.stringify({ ...config, chainId: 1 }));
    checked(await cli('deploy-logger', '--broadcast'), 1, /FAIL.*chainId/);
    assert.equal(await rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x0');
    await writeFile(configPath, original);
    progress('Wrong-chain deployment rejected without a transaction.');

    progress('Simulating Logger deployment...');
    checked(await cli('deploy-logger'), 0, /Simulation passed/);
    assert.equal(await rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x0');
    assert.equal(await readFile(configPath, 'utf8'), original);
    await assert.rejects(readFile(metadataPath), { code: 'ENOENT' });
    progress('Simulation passed; no transaction or config changes.');

    progress('Broadcasting Logger deployment...');
    const deployed = await cli('deploy-logger', '--broadcast');
    checked(deployed, 0, /Deployment recorded/);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const receipt = await rpc('eth_getTransactionReceipt', [metadata.transactionHash]);
    assert.equal(await readFile(configPath, 'utf8'), original);
    assert.ok(deployed.output.includes(`Set loggerContract to ${metadata.loggerContract}`));
    assert.deepEqual(metadata, { chainId: 31337, loggerContract: receipt.contractAddress,
        transactionHash: receipt.transactionHash, blockNumber: BigInt(receipt.blockNumber).toString(), deployer: deployer.address });
    assert.equal(receipt.status, '0x1');
    assert.notEqual(await rpc('eth_getCode', [metadata.loggerContract, 'latest']), '0x');
    progress(`Logger verified at ${metadata.loggerContract}; transaction ${metadata.transactionHash}.`);
    assert.equal((await stat(configPath)).mode & 0o777, 0o640);
    assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
    assert.ok(await readFile(envPath, 'utf8') === credentials, 'Deployment must preserve the environment file.');
    const files = await readdir(directory);
    for (const name of files.filter((name) => name.startsWith('.oya-logger-'))) {
        assert.equal((await stat(join(directory, name))).mode & 0o777, 0o700);
    }
    checked(await cli('deploy-logger', '--broadcast'), 1, /Prior deployment metadata exists/);
    assert.equal(await rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x1');
    assert.equal(await readFile(configPath, 'utf8'), original);
    assert.deepEqual(await readdir(directory), files);
    progress('Deployment record blocked a second broadcast before config adoption.');

    // Act as the operator adopting the verified address before reuse.
    await writeFile(configPath, `${JSON.stringify({ ...config, loggerContract: metadata.loggerContract }, null, 2)}\n`);
    const before = await Promise.all([configPath, metadataPath].map((path) => readFile(path, 'utf8')));
    await writeFile(envPath, 'LOGGER_DEPLOYER_PK=\nOYA_RPC_AUTHORIZATION=\n');
    checked(await cli('deploy-logger', '--broadcast'), 0, /Reusing configured Logger/);
    assert.equal(await rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x1');
    assert.deepEqual(await readdir(directory), files);
    assert.deepEqual(await Promise.all([configPath, metadataPath].map((path) => readFile(path, 'utf8'))), before);
    progress('Logger address adopted in config; reuse submitted no transaction.');

    progress('Starting isolated offline Kubo...');
    const ipfsEnv = { ...baseEnv, IPFS_PATH: join(directory, 'ipfs') };
    checked(await command('ipfs', ['init', '--profile=test'], { cwd: directory, env: ipfsEnv }), 0);
    const ipfsConfigPath = join(ipfsEnv.IPFS_PATH, 'config');
    const ipfsConfig = JSON.parse(await readFile(ipfsConfigPath, 'utf8'));
    const ipfsPort = await freePort();
    ipfsConfig.Addresses.API = `/ip4/127.0.0.1/tcp/${ipfsPort}`;
    ipfsConfig.Addresses.Gateway = ''; // This fixture only needs the Kubo API.
    ipfsConfig.Addresses.Swarm = [];
    await writeFile(ipfsConfigPath, JSON.stringify(ipfsConfig), { mode: 0o600 });
    const ipfs = background('ipfs', ['daemon', '--offline'], ipfsEnv);
    const ipfsUrl = `http://127.0.0.1:${ipfsPort}`;
    const ipfsRequest = (path) => fetch(`${ipfsUrl}/api/v0/${path}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    await until(async () => { const response = await ipfsRequest('version'); await response.text(); return response.ok; }, ipfs);
    progress(`Kubo API ready at ${ipfsUrl}.`);

    const nodePort = await freePort();
    const nodeUrl = `http://127.0.0.1:${nodePort}`;
    const selectedConfig = { ...config, loggerContract: metadata.loggerContract, ipfsUrl, host: '127.0.0.1', port: nodePort,
        receiptTimeoutMs: 30_000, operationTimeoutMs: 45_000 };
    await writeFile(configPath, `${JSON.stringify(selectedConfig, null, 2)}\n`);
    await writeFile(envPath, `OYA_NODE_PRIVATE_KEY=${nodeWallet.privateKey}\nOYA_RPC_AUTHORIZATION=\nOYA_IPFS_AUTHORIZATION=\nLOGGER_DEPLOYER_PK=\n`);
    await rpc('anvil_setBalance', [nodeWallet.address, '0x56bc75e2d63100000']);
    const settingsBefore = await Promise.all([configPath, envPath, metadataPath].map((path) => readFile(path, 'utf8')));
    progress('Checking node configuration, Ethereum, Logger, gas balance, and IPFS...');
    checked(await cli('check'), 0, /OK IPFS API/);
    progress('Readiness checks passed.');

    const start = async () => {
        progress('Starting the node through the foreground runner...');
        const running = background(process.execPath, ['--', join(production, 'scripts/local-node.mjs'), 'run',
            '--config', 'config.local.json', '--env-file', 'node.env'], { ...env, INIT_CWD: directory });
        const health = await until(async () => {
            const response = await fetch(`${nodeUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
            return response.ok ? response.json() : false;
        }, running);
        assert.equal(health.status, 'ready');
        assert.equal(health.chainId, 31337);
        assert.equal(health.loggerContract.toLowerCase(), metadata.loggerContract.toLowerCase());
        assert.equal(health.nodeAddress.toLowerCase(), nodeWallet.address.toLowerCase());
        checked(await cli('status'), 0, /OK ready/);
        progress(`Node ready at ${nodeUrl}; signing address and Logger match the config.`);
        return running;
    };
    const shutdown = async (running, signal) => {
        progress(`Stopping the node with ${signal}...`);
        assert.deepEqual(await stop(running, signal), { code: 0, signal: null });
        redacted(running.output());
        assert.match(running.output(), /Stopping node; waiting for active work to finish/);
        await assert.rejects(fetch(`${nodeUrl}/healthz`, { signal: AbortSignal.timeout(1000) }));
        checked(await cli('status'), 1, /Node is unreachable/);
        assert.equal(await rpc('eth_chainId'), '0x7a69');
        assert.ok((await (await ipfsRequest('version')).json()).Version.length > 0);
        progress('Node stopped cleanly; status is unreachable; Anvil and Kubo remain available.');
    };
    const messagePath = join(directory, 'message.txt');
    const send = async (wallet, text) => {
        await writeFile(messagePath, text, { mode: 0o600 });
        return command(process.execPath, ['--', join(production, 'scripts/send-message.mjs'), nodeUrl, messagePath], {
            cwd: directory, env: { OYA_AGENT_PRIVATE_KEY: wallet.privateKey },
        });
    };
    const logger = new Interface(['event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)']);
    const publish = async (text) => {
        progress(`Submitting agent message: ${JSON.stringify(text)}`);
        const result = await send(agent, text);
        checked(result, 0);
        const body = JSON.parse(result.output);
        assert.equal(body.status, 'logged'); // The sender exits 0 only for HTTP 200.
        assert.equal(body.signer, agent.address);
        const publication = body.publication;
        assert.equal(publication.status, 'logged');
        assert.equal(publication.uri, `ipfs://${publication.cid}`);
        assert.equal(publication.nodeAddress.toLowerCase(), nodeWallet.address.toLowerCase());
        assert.equal(publication.loggerContract.toLowerCase(), metadata.loggerContract.toLowerCase());
        progress(`Node returned HTTP 200 / logged; CID ${publication.cid}; transaction ${publication.transactionHash}.`);
        const content = await ipfsRequest(`cat?arg=${encodeURIComponent(publication.cid)}`);
        assert.equal(content.status, 200);
        assert.equal(await content.text(), JSON.stringify({ text, signer: agent.address, signature: await agent.signMessage(text) }));
        progress('Retrieved IPFS envelope exactly matches the message, agent, and signature.');
        const receipt = await rpc('eth_getTransactionReceipt', [publication.transactionHash]);
        assert.equal(receipt.status, '0x1');
        assert.equal(receipt.from.toLowerCase(), nodeWallet.address.toLowerCase());
        assert.equal(receipt.to.toLowerCase(), metadata.loggerContract.toLowerCase());
        assert.equal(publication.blockNumber, BigInt(receipt.blockNumber).toString());
        assert.equal(receipt.logs.length, 1);
        assert.equal(receipt.logs[0].address.toLowerCase(), metadata.loggerContract.toLowerCase());
        const event = logger.parseLog(receipt.logs[0]);
        assert.equal(event.name, 'Log');
        assert.equal(event.args.node.toLowerCase(), nodeWallet.address.toLowerCase());
        assert.equal(event.args.cid, publication.cid);
        assert.equal(event.args.cidKeccak256Hash, keccak256(toUtf8Bytes(publication.cid)));
        progress(`Logger event verified in block ${publication.blockNumber}; node, CID, and CID hash match.`);
        return publication;
    };

    const firstRun = await start();
    assert.equal(await rpc('eth_getTransactionCount', [nodeWallet.address, 'pending']), '0x0');
    const firstText = 'A signed message from the separate local agent.\n';
    const firstPublication = await publish(firstText);
    progress(`Submitting a message from disallowed signer ${disallowed.address}...`);
    const rejected = await send(disallowed, 'This signer is not on the allowlist.\n');
    checked(rejected, 1);
    assert.equal(JSON.parse(rejected.output).code, 'unauthorized_signer');
    assert.equal(await rpc('eth_getTransactionCount', [nodeWallet.address, 'pending']), '0x1');
    progress('Unauthorized signer rejected; node nonce remains one.');
    await shutdown(firstRun, 'SIGINT');

    progress('Restarting with the same node identity and Logger...');
    const secondRun = await start();
    checked(await cli('deploy-logger', '--broadcast'), 0, /Reusing configured Logger/);
    assert.equal(await rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x1');
    assert.equal(await rpc('eth_getTransactionCount', [nodeWallet.address, 'pending']), '0x1');
    progress('Identity and Logger preserved; restart and reuse submitted no transactions.');
    const secondPublication = await publish('Another signed message after restarting the same node.\n');
    assert.notEqual(secondPublication.transactionHash, firstPublication.transactionHash);
    assert.equal(await rpc('eth_getTransactionCount', [nodeWallet.address, 'latest']), '0x2');
    await shutdown(secondRun, 'SIGTERM');
    assert.equal(await (await ipfsRequest(`cat?arg=${firstPublication.cid}`)).text(),
        JSON.stringify({ text: firstText, signer: agent.address, signature: await agent.signMessage(firstText) }));
    const settingsAfter = await Promise.all([configPath, envPath, metadataPath].map((path) => readFile(path, 'utf8')));
    assert.ok(settingsAfter.every((value, index) => value === settingsBefore[index]), 'Node operation must preserve settings files.');
    for (const wallet of [agent, disallowed]) assert.equal(await rpc('eth_getBalance', [wallet.address, 'latest']), '0x0');
    progress('Original IPFS content remains available; settings are unchanged; agents used no gas.');
    progress('Stopping fixture Kubo and Anvil...');
    await stop(ipfs);
    await stop(anvil);
    progress('All fixture services stopped.');

    const evidence = { chainId: 31337, loggerContract: metadata.loggerContract, deploymentTransactionHash: metadata.transactionHash,
        nodeUrl, rpcUrl, ipfsUrl, nodeAddress: nodeWallet.address, agentAddress: agent.address,
        firstPublication, secondPublication,
        checks: ['manual Logger adoption and reuse', 'separate sender with only agent credentials', 'exact IPFS envelope',
            'verified Logger event', 'disallowed signer rejected without a transaction', 'SIGINT and SIGTERM shutdown',
            'stable identity and nonce across restart', 'unchanged settings', 'supplied services survive node shutdown',
            'fixture services stopped'] };
    const evidenceDirectory = await mkdtemp(join(tmpdir(), 'oya-local-evidence-'));
    const evidencePath = join(evidenceDirectory, 'evidence.json');
    const evidenceText = JSON.stringify(evidence, null, 2);
    redacted(evidenceText);
    await writeFile(evidencePath, `${evidenceText}\n`, { mode: 0o600 });
    t.diagnostic(JSON.stringify({ event: 'local_flow_passed', evidencePath }));
});
