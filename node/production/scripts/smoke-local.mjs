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
import { Interface, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { parseConfig } from '../src/config.mjs';
import { createLocalSigner } from '../src/signer.mjs';
import { startNode } from '../src/main.mjs';

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
        try { const result = await check(); if (result) return result; } catch {}
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
        'script', '--root', 'contracts', 'contracts/script/DeployLedger.s.sol:DeployLedger',
        '--rpc-url', rpcUrl, '--broadcast', '--offline',
    ], {
        cwd: root, timeout: 60_000,
        env: { ...process.env, LEDGER_CHAIN_ID: '31337', LEDGER_DEPLOYER_PK: deployer.privateKey },
    });
    const broadcast = JSON.parse(await readFile(join(root, 'contracts/broadcast/DeployLedger.s.sol/31337/run-latest.json'), 'utf8'));
    const deployment = broadcast.transactions.find((transaction) => transaction.contractName === 'Ledger');
    assert.ok(deployment?.contractAddress);
    const input = {
        host: '127.0.0.1', port: nodePort, chainId: 31337, ledgerContract: deployment.contractAddress,
        allowedSigners: [agent.address], rpcUrl, ipfsUrl,
        receiptTimeoutMs: 30_000, operationTimeoutMs: 45_000, pollIntervalMs: 50,
    };
    const config = parseConfig(input, { env: {} });
    const signer = createLocalSigner(nodeWallet.privateKey);
    await assert.rejects(startNode({ ...config, chainId: 1 }, signer), /chain ID/);
    await assert.rejects(startNode({ ...config, ledgerContract: agent.address }, signer), /bytecode/);
    runtime = await startNode(config, signer);
    assert.equal((await fetch(`${nodeUrl}/healthz`)).status, 200);
    const text = 'First message through the Oya kernel node and deployed Ledger.';
    const message = { text, signer: agent.address, signature: await agent.signMessage(text) };
    const post = (body) => fetch(`${nodeUrl}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const ledgerAbi = new Interface(['event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)']);
    const checkedPublication = async (response, expectedMessage) => {
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.status, 'logged');
        assert.equal(body.signer.toLowerCase(), agent.address.toLowerCase());
        const publication = body.publication;
        assert.equal(publication.status, 'logged');
        assert.equal(publication.uri, `ipfs://${publication.cid}`);
        const content = await fetch(`${ipfsUrl}/api/v0/cat?arg=${publication.cid}`, { method: 'POST' });
        assert.equal(content.status, 200);
        assert.deepEqual(await content.json(), expectedMessage);
        const receipt = await rawRpc('eth_getTransactionReceipt', [publication.transactionHash]);
        assert.equal(receipt.status, '0x1');
        assert.equal(publication.blockNumber, BigInt(receipt.blockNumber).toString());
        assert.equal(receipt.logs.length, 1);
        assert.equal(receipt.logs[0].address.toLowerCase(), config.ledgerContract.toLowerCase());
        const event = ledgerAbi.parseLog(receipt.logs[0]);
        assert.equal(event.name, 'Log');
        assert.equal(event.args.node.toLowerCase(), signer.address.toLowerCase());
        assert.equal(event.args.cid, publication.cid);
        assert.equal(event.args.cidKeccak256Hash, keccak256(toUtf8Bytes(publication.cid)));
        assert.equal(publication.nodeAddress.toLowerCase(), signer.address.toLowerCase());
        assert.equal(publication.ledgerContract.toLowerCase(), config.ledgerContract.toLowerCase());
        return publication;
    };
    const initialNonce = await rawRpc('eth_getTransactionCount', [signer.address, 'pending']);
    assert.equal((await post({ ...message, text: 'tampered' })).status, 401);
    assert.equal(await rawRpc('eth_getTransactionCount', [signer.address, 'pending']), initialNonce);
    const publication = await checkedPublication(await post(message), message);

    // Wait for an actual pending transaction before testing busy admission.
    const pendingText = 'Keep one Ledger transaction active until its receipt is checked.';
    const pendingMessage = { text: pendingText, signer: agent.address, signature: await agent.signMessage(pendingText) };
    const nextText = 'Process this message after the active operation completes.';
    const nextMessage = { text: nextText, signer: agent.address, signature: await agent.signMessage(nextText) };
    let pendingPublication;
    let pendingTransactionHash;
    await rawRpc('evm_setAutomine', [false]);
    try {
        const pendingResponse = post(pendingMessage);
        // Observe rejection immediately even if a readiness assertion fails first.
        pendingResponse.catch(() => {});
        const pendingBlock = await until(async () => {
            const block = await rawRpc('eth_getBlockByNumber', ['pending', false]);
            return block.transactions.length > 0 ? block : false;
        });
        assert.equal(pendingBlock.transactions.length, 1);
        [pendingTransactionHash] = pendingBlock.transactions;
        const nonce = await rawRpc('eth_getTransactionCount', [signer.address, 'pending']);
        assert.equal((await (await fetch(`${nodeUrl}/healthz`)).json()).status, 'busy');
        for (const rejectedMessage of [nextMessage, message]) {
            const rejected = await post(rejectedMessage);
            assert.equal(rejected.status, 503);
            assert.equal(rejected.headers.get('retry-after'), '5');
            assert.deepEqual(await rejected.json(), { code: 'node_busy', started: false });
        }
        assert.deepEqual((await rawRpc('eth_getBlockByNumber', ['pending', false])).transactions, [pendingTransactionHash]);
        assert.equal(await rawRpc('eth_getTransactionCount', [signer.address, 'pending']), nonce);
        await rawRpc('evm_mine');
        pendingPublication = await checkedPublication(await pendingResponse, pendingMessage);
        assert.equal(pendingPublication.transactionHash, pendingTransactionHash);
    } finally {
        await rawRpc('evm_setAutomine', [true]);
    }
    assert.equal((await (await fetch(`${nodeUrl}/healthz`)).json()).status, 'ready');
    const nextPublication = await checkedPublication(await post(nextMessage), nextMessage);
    const duplicatePublication = await checkedPublication(await post(message), message);
    assert.equal(duplicatePublication.cid, publication.cid);
    assert.notEqual(duplicatePublication.transactionHash, publication.transactionHash);
    assert.equal(BigInt(await rawRpc('eth_getTransactionCount', [signer.address, 'latest'])), BigInt(initialNonce) + 4n);

    await writeFile(join(directory, 'config.json'), `${JSON.stringify(input, null, 2)}\n`);
    await writeFile(join(directory, '.env'), `OYA_NODE_PRIVATE_KEY=${nodeWallet.privateKey}\nOYA_AGENT_PRIVATE_KEY=${agent.privateKey}\n`, { mode: 0o600 });
    await runtime.close(); runtime = undefined;
    const nodeEnv = { ...process.env };
    for (const name of ['OYA_NODE_PRIVATE_KEY', 'OYA_AGENT_PRIVATE_KEY', 'OYA_RPC_AUTHORIZATION', 'OYA_IPFS_AUTHORIZATION']) delete nodeEnv[name];
    const daemon = background('node', [
        `--env-file=${join(directory, '.env')}`, 'node/production/src/main.mjs', join(directory, 'config.json'),
    ], nodeEnv);
    await until(async () => {
        const response = await fetch(`${nodeUrl}/healthz`);
        return response.ok ? response.json() : false;
    }, daemon);
    const health = await (await fetch(`${nodeUrl}/healthz`)).json();
    assert.equal(health.status, 'ready');
    assert.equal(health.nodeAddress.toLowerCase(), signer.address.toLowerCase());

    const evidence = {
        chainId: 31337, ledgerContract: config.ledgerContract, deploymentTransactionHash: deployment.hash,
        nodeUrl, rpcUrl, ipfsUrl, nodeAddress: signer.address, agentAddress: agent.address,
        publication, pendingPublication, nextPublication, duplicatePublication,
        busyCheck: { pendingTransactionHash, pendingTransactionCount: 1, rejectedRequests: 2 },
        checks: ['signed HTTP ingestion', 'IPFS retrieval', 'Ledger event', 'invalid signature rejection',
            'busy rejection while a transaction is pending', 'no second pending transaction',
            'successful resubmission after completion', 'independent duplicate Ledger event',
            'chain and contract startup checks', 'CLI startup'],
    };
    await writeFile(join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ event: 'smoke_passed', directory, ...evidence }, null, 2));
    if (process.argv.includes('--keep-running')) {
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
