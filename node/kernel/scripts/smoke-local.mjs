import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Wallet } from 'ethers';
import { createTransactionPreparer, encodeLoggerCall } from '@oyaprotocol/ethereum';
import { publishSignedMessage } from '@oyaprotocol/messages';
import { parseConfig } from '../src/config.mjs';
import { createLocalSigner } from '../src/signer.mjs';
import { startNode } from '../src/main.mjs';
import { messageId, openStore } from '../src/store.mjs';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(join(tmpdir(), 'oya-kernel-local-'));
const children = [];
let runtime;

async function freePort() {
    const server = createServer();
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const port = server.address().port;
    await new Promise((resolveClose) => server.close(resolveClose));
    return port;
}

function background(command, args, env = process.env) {
    const output = createWriteStream(join(directory, `${command}.log`), { mode: 0o600 });
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(output);
    child.stderr.pipe(output);
    children.push(child);
    return child;
}

async function until(check, child) {
    for (let i = 0; i < 150; i++) {
        if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('Local service exited; inspect its log.');
        try { if (await check()) return; } catch {}
        await delay(100);
    }
    throw new Error('Local service did not become ready.');
}

async function cleanup() {
    if (runtime) { await runtime.close(); runtime = undefined; }
    await Promise.all(children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        try { await exited; } finally { clearTimeout(timer); }
    }));
}

try {
    const [rpcPort, ipfsPort, gatewayPort, nodePort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
    const rpcUrl = `http://127.0.0.1:${rpcPort}`;
    const ipfsUrl = `http://127.0.0.1:${ipfsPort}`;
    const nodeUrl = `http://127.0.0.1:${nodePort}`;
    const anvil = background('anvil', ['--host', '127.0.0.1', '--port', String(rpcPort), '--chain-id', '31337', '--silent']);
    const rawRpc = async (method, params = []) => {
        const response = await fetch(rpcUrl, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const body = await response.json();
        if (body.error) throw new Error(`Local RPC rejected ${method}.`);
        return body.result;
    };
    await until(async () => await rawRpc('eth_chainId') === '0x7a69', anvil);

    const ipfsEnv = { ...process.env, IPFS_PATH: join(directory, 'ipfs') };
    await run('ipfs', ['init', '--profile=test'], { env: ipfsEnv });
    const ipfsConfigPath = join(ipfsEnv.IPFS_PATH, 'config');
    const ipfsConfig = JSON.parse(await readFile(ipfsConfigPath, 'utf8'));
    ipfsConfig.Addresses.API = `/ip4/127.0.0.1/tcp/${ipfsPort}`;
    ipfsConfig.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${gatewayPort}`;
    ipfsConfig.Addresses.Swarm = [];
    await writeFile(ipfsConfigPath, JSON.stringify(ipfsConfig), { mode: 0o600 });
    const ipfs = background('ipfs', ['daemon', '--offline'], ipfsEnv);
    await until(async () => (await fetch(`${ipfsUrl}/api/v0/version`, { method: 'POST' })).ok, ipfs);

    const deployer = Wallet.createRandom();
    const nodeWallet = Wallet.createRandom();
    const agent = Wallet.createRandom();
    for (const wallet of [deployer, nodeWallet]) await rawRpc('anvil_setBalance', [wallet.address, '0x56bc75e2d63100000']);
    await run('forge', [
        'script', '--root', 'contracts', 'contracts/script/DeployLogger.s.sol:DeployLogger',
        '--rpc-url', rpcUrl, '--broadcast', '--offline',
    ], {
        cwd: root, timeout: 60_000,
        env: { ...process.env, LOGGER_CHAIN_ID: '31337', LOGGER_DEPLOYER_PK: deployer.privateKey },
    });
    const broadcast = JSON.parse(await readFile(join(root, 'contracts/broadcast/DeployLogger.s.sol/31337/run-latest.json'), 'utf8'));
    const deployment = broadcast.transactions.find((transaction) => transaction.contractName === 'Logger');
    assert.ok(deployment?.contractAddress);
    const input = {
        host: '127.0.0.1', port: nodePort, chainId: 31337, loggerContract: deployment.contractAddress,
        allowedSigners: [agent.address], rpcUrl, ipfsUrl, stateDir: join(directory, 'state'),
        receiptTimeoutMs: 3000, pollIntervalMs: 50,
    };
    const config = parseConfig(input, { env: {} });
    const signer = createLocalSigner(nodeWallet.privateKey);
    await assert.rejects(startNode({ ...config, chainId: 1 }, signer), /chain ID/);
    await assert.rejects(startNode({ ...config, loggerContract: agent.address }, signer), /bytecode/);
    runtime = await startNode(config, signer);
    assert.equal((await fetch(`${nodeUrl}/healthz`)).status, 200);
    const text = 'First message through the Oya kernel node and deployed Logger.';
    const message = { text, signer: agent.address, signature: await agent.signMessage(text) };
    const post = (body) => fetch(`${nodeUrl}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await post({ ...message, text: 'tampered' })).status, 401);
    const response = await post(message);
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    const publication = body.publication;
    const content = await fetch(`${ipfsUrl}/api/v0/cat?arg=${publication.cid}`, { method: 'POST' });
    assert.deepEqual(await content.json(), message);
    const receipt = await rawRpc('eth_getTransactionReceipt', [publication.transactionHash]);
    assert.equal(receipt.status, '0x1');
    assert.equal(receipt.logs.length, 1);
    assert.equal(publication.nodeAddress.toLowerCase(), signer.address.toLowerCase());
    const nonce = await rawRpc('eth_getTransactionCount', [signer.address, 'pending']);
    const duplicate = await post(message);
    assert.deepEqual((await duplicate.json()).publication, publication);
    assert.equal(await rawRpc('eth_getTransactionCount', [signer.address, 'pending']), nonce);
    await runtime.close(); runtime = undefined;

    // Simulate a crash after mining, before saving success: retain the real signed transaction.
    const recordPath = join(config.stateDir, `${messageId(message)}.json`);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    delete record.result;
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    runtime = await startNode(config, signer);
    assert.deepEqual((await (await post(message)).json()).publication, publication);
    assert.equal(await rawRpc('eth_getTransactionCount', [signer.address, 'pending']), nonce);
    await runtime.close(); runtime = undefined;

    // Simulate a crash after durable preparation, before broadcast. Recovery must use those exact bytes.
    const recoveryText = 'Resume a prepared Logger transaction after restart.';
    const recoveryMessage = { text: recoveryText, signer: agent.address, signature: await agent.signMessage(recoveryText) };
    const recoveryPublication = await publishSignedMessage(recoveryMessage, { config: config.ipfs, fetch });
    const prepare = createTransactionPreparer({ config: config.rpc, fetch, chainId: config.chainId, signer, limits: config.limits });
    const signed = await prepare({ to: config.loggerContract, data: encodeLoggerCall(recoveryPublication.cid), value: 0n });
    const store = await openStore(config.stateDir, {
        version: 1, chainId: config.chainId, loggerContract: config.loggerContract.toLowerCase(), nodeAddress: signer.address.toLowerCase(),
    });
    await store.save({ id: messageId(recoveryMessage), message: recoveryMessage, cid: recoveryPublication.cid, signed });
    await store.close();
    runtime = await startNode(config, signer);
    const recovered = await (await post(recoveryMessage)).json();
    assert.equal(recovered.publication.transactionHash, signed.transactionHash);
    assert.equal(recovered.publication.status, 'logged');

    // Hold mining to demonstrate one lifecycle at a time without nonce collisions.
    await rawRpc('evm_setAutomine', [false]);
    const concurrentText = 'Serialize node signing while a transaction is pending.';
    const concurrentMessage = { text: concurrentText, signer: agent.address, signature: await agent.signMessage(concurrentText) };
    const pendingResponse = post(concurrentMessage);
    await until(async () => (await (await fetch(`${nodeUrl}/healthz`)).json()).busy);
    const busyResponse = await post({ ...message, text: recoveryText, signature: recoveryMessage.signature });
    // Previously completed requests can return their durable result even while a new one is active.
    assert.equal(busyResponse.status, 202);
    const newText = 'Concurrent new message through the Oya kernel node.';
    const rejected = await post({ text: newText, signer: agent.address, signature: await agent.signMessage(newText) });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).code, 'node_busy');
    await until(async () => {
        const pendingBlock = await rawRpc('eth_getBlockByNumber', ['pending', false]);
        return pendingBlock.transactions.length > 0;
    });
    await rawRpc('evm_mine');
    await rawRpc('evm_setAutomine', [true]);
    assert.equal((await pendingResponse).status, 202);

    const evidence = {
        chainId: 31337, loggerContract: config.loggerContract, deploymentTransactionHash: deployment.hash,
        nodeUrl, rpcUrl, ipfsUrl, nodeAddress: signer.address, agentAddress: agent.address,
        publication, recoveryTransactionHash: signed.transactionHash,
        checks: ['signed HTTP ingestion', 'IPFS retrieval', 'Logger event', 'invalid signature rejection',
            'duplicate suppression', 'mined receipt recovery', 'prepared transaction recovery',
            'serialized submissions', 'chain and contract startup checks'],
    };
    await writeFile(join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(join(directory, 'config.json'), `${JSON.stringify(input, null, 2)}\n`);
    await writeFile(join(directory, '.env'), `OYA_NODE_PRIVATE_KEY=${nodeWallet.privateKey}\nOYA_AGENT_PRIVATE_KEY=${agent.privateKey}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ event: 'smoke_passed', directory, ...evidence }, null, 2));
    if (process.argv.includes('--keep-running')) {
        await runtime.close(); runtime = undefined;
        const daemon = background('node', [
            `--env-file=${join(directory, '.env')}`, 'node/kernel/src/main.mjs', join(directory, 'config.json'),
        ]);
        await until(async () => (await fetch(`${nodeUrl}/healthz`)).ok, daemon);
        console.log('Local node, Anvil, and isolated IPFS remain running. Press Ctrl-C to stop.');
        await new Promise((resolveStop) => {
            process.once('SIGINT', resolveStop);
            process.once('SIGTERM', resolveStop);
        });
    }
} catch (error) {
    console.error(`Local smoke failed; artifacts: ${directory}`);
    // Child-process exceptions retain their complete environment; never print those objects.
    console.error(error.message?.slice(0, 1200));
    process.exitCode = 1;
} finally {
    await cleanup();
}
