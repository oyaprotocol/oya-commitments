import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chown, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Interface, Wallet, keccak256, toUtf8Bytes } from 'ethers';

const production = fileURLToPath(new URL('../', import.meta.url));
const { values: { verbose, platform } } = parseArgs({ options: {
    verbose: { type: 'boolean', default: false }, platform: { type: 'string' },
} });
if (platform && !['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('Select linux/amd64 or linux/arm64.');

test('Docker publishes signed messages, preserves IPFS, drains work, and requires reconciliation', { timeout: 900_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'oya-docker-'));
    const project = `oya-test-${randomUUID()}`;
    const restoredProject = `${project}-restore`;
    const interrupted = new AbortController();
    const signal = AbortSignal.any([t.signal, interrupted.signal]);
    const interrupt = () => interrupted.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const active = new Set();
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(OYA_|LEDGER_|LOGGER_|FOUNDRY_|DAPP_|ETH_|ETHERSCAN_|VERIFIER_|IPFS_|COMPOSE_)/.test(key)
        && !['NODE_OPTIONS', 'NODE_PATH', 'INIT_CWD', 'DOCKER_DEFAULT_PLATFORM'].includes(key)));
    const fixtureEnv = { ...baseEnv, OYA_CONFIG_FILE: join(directory, 'node.json'),
        OYA_ENV_FILE: join(directory, 'node.env'),
        OYA_CONTAINER_USER: process.getuid?.() ? `${process.getuid()}:${process.getgid()}` : '1000:1000' };
    let stage = 'prerequisites';
    const progress = (message) => { stage = message; if (verbose) console.log(`[docker] ${message}`); };

    // Capture child output privately, bound its size/lifetime, and stop descendant processes too.
    function command(file, args, { env = baseEnv, timeout = 60_000, code = 0, input, cleanup = false } = {}) {
        if (!cleanup) signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const child = execFile(file, args, { cwd: production, env, encoding: 'buffer',
                detached: process.platform !== 'win32', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
                clearTimeout(timer);
                signal.removeEventListener('abort', kill);
                active.delete(kill);
                kill();
                if ((error ? error.code : 0) !== code) reject(new Error('Fixture command failed.'));
                else resolve(stdout);
            });
            const kill = () => {
                try {
                    if (process.platform === 'win32') child.kill('SIGKILL');
                    else if (child.pid) process.kill(-child.pid, 'SIGKILL');
                } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
            };
            const timer = setTimeout(kill, timeout);
            active.add(kill);
            if (!cleanup) signal.addEventListener('abort', kill, { once: true });
            child.stdin.on('error', () => {});
            child.stdin.end(input);
        });
    }
    const compose = (args, { name = project, ...options } = {}) => command('docker', [
        'compose', '--project-name', name, '--env-file', join(directory, 'empty.env'),
        '-f', join(production, 'compose.yaml'), '-f', join(production, 'docker/compose.test.yaml'), ...args,
    ], { ...options, env: { ...fixtureEnv, COMPOSE_PROJECT_NAME: name } });
    let configured = false;
    let built = false;
    t.after(async () => {
        for (const kill of active) kill();
        try {
            if (configured) {
                const results = await Promise.allSettled([project, restoredProject].map((name) =>
                    compose(['down', '--volumes', '--remove-orphans', '--timeout', '5'], { name, cleanup: true })));
                assert.ok(results.every((result) => result.status === 'fulfilled'), `Fixture cleanup failed for ${project}.`);
                if (built) await command('docker', ['image', 'rm', `${project}-node`], { cleanup: true });
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', interrupt);
        }
    });
    const until = async (check, timeout = 60_000) => {
        const deadline = performance.now() + timeout;
        while (performance.now() < deadline) {
            signal.throwIfAborted();
            try { const result = await check(); if (result) return result; } catch { signal.throwIfAborted(); }
            await delay(200, undefined, { signal });
        }
        throw new Error('Fixture condition timed out.');
    };
    const request = (url, options = {}) => fetch(url, {
        ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    const endpoint = async (service, port) => {
        const binding = (await compose(['port', service, String(port)])).toString().trim();
        assert.match(binding, /^127\.0\.0\.1:\d+$/);
        return `http://${binding}`;
    };
    const containerId = async (service) => (await compose(['ps', '--all', '--quiet', service])).toString().trim();
    const state = async (id) => JSON.parse((await command('docker', ['inspect', '--format', '{{json .State}}', id])).toString());
    const ipfsCommand = (args, options) => compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', args[0], 'ipfs', ...args.slice(1)], options);

    try {
        assert.equal(process.versions.node.split('.')[0], '24', 'Select Node 24 before running test:docker.');
        const docker = JSON.parse((await command('docker', ['version', '--format', '{{json .Server}}'])).toString());
        assert.equal(docker.Os, 'linux');
        fixtureEnv.OYA_TEST_PLATFORM = platform ?? `linux/${docker.Arch}`;
        const composeVersion = (await command('docker', ['compose', 'version', '--short'])).toString().trim();
        assert.match(composeVersion, /^v?2\.(\d+)/);
        assert.ok(Number(composeVersion.match(/^v?2\.(\d+)/)[1]) >= 30, 'Compose 2.30+ is required.');
        const forgeVersion = (await command('forge', ['--version'])).toString().split('\n')[0];
        await readFile(join(production, '../../lib/forge-std/src/Script.sol'));
        const deployer = Wallet.createRandom();
        const nodeWallet = Wallet.createRandom();
        const agent = Wallet.createRandom();
        const disallowed = Wallet.createRandom();
        await writeFile(join(directory, 'empty.env'), '', { mode: 0o600 });
        await writeFile(fixtureEnv.OYA_CONFIG_FILE, '{}', { mode: 0o600 });
        if (process.getuid?.() === 0) await chown(fixtureEnv.OYA_CONFIG_FILE, 1000, 1000);
        await writeFile(fixtureEnv.OYA_ENV_FILE, `OYA_NODE_PRIVATE_KEY=${nodeWallet.privateKey}\n`, { mode: 0o600 });
        await compose(['config', '--quiet']);
        // Inspect only selected fields; the complete model contains the generated node key.
        const model = JSON.parse((await compose(['config', '--format', 'json'])).toString());
        const ports = { node: 8787, ipfs: 5001, anvil: 8545 };
        for (const [service, port] of Object.entries(ports)) {
            assert.equal(model.services[service].ports.length, 1);
            const binding = model.services[service].ports[0];
            assert.equal(binding.host_ip, '127.0.0.1');
            assert.equal(binding.target, port);
            assert.equal(binding.protocol, 'tcp');
            assert.ok(!binding.published || binding.published === '0');
        }
        assert.equal(model.services.node.restart, 'no');
        assert.deepEqual(Object.keys(model.services.node.environment), ['OYA_NODE_PRIVATE_KEY']);
        for (const service of ['ipfs', 'anvil']) assert.equal(model.services.node.depends_on[service].condition, 'service_healthy');
        configured = true;
        progress(`Building the repository image for ${fixtureEnv.OYA_TEST_PLATFORM}`);
        await compose(['build', 'node'], { timeout: 300_000 });
        built = true;
        const imagePlatform = (await command('docker', ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', `${project}-node`])).toString().trim();
        assert.equal(imagePlatform, fixtureEnv.OYA_TEST_PLATFORM);
        progress('Starting disposable Anvil and offline Kubo');
        await compose(['up', '-d', '--wait', '--wait-timeout', '90', 'anvil', 'ipfs'], { timeout: 240_000 });
        const rpcUrl = await endpoint('anvil', 8545);
        let ipfsUrl = await endpoint('ipfs', 5001);
        let nodeUrl;
        const rpc = async (method, params = []) => {
            const response = await request(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
            const body = await response.json();
            assert.ok(response.ok && !body.error, 'Fixture RPC failed.');
            return body.result;
        };
        const ipfs = (path) => request(`${ipfsUrl}/api/v0/${path}`, { method: 'POST' });
        assert.equal(await rpc('eth_chainId'), '0x7a69');
        assert.equal((await (await ipfs('version')).json()).Version, '0.43.0');
        const peerId = (await (await ipfs('id')).json()).ID;
        for (const wallet of [deployer, nodeWallet]) await rpc('anvil_setBalance', [wallet.address, '0x56bc75e2d63100000']);
        const config = { host: '127.0.0.1', port: 8787, chainId: 31337,
            ledgerContract: '0x1111111111111111111111111111111111111111', allowedSigners: [agent.address],
            rpcUrl, ipfsUrl, receiptTimeoutMs: 45_000, operationTimeoutMs: 90_000, pollIntervalMs: 100 };
        const deployPath = join(directory, 'deploy.json');
        await writeFile(deployPath, JSON.stringify(config), { mode: 0o600 });
        await writeFile(join(directory, 'deployer.env'), `LEDGER_DEPLOYER_PK=${deployer.privateKey}\n`, { mode: 0o600 });
        progress('Deploying Ledger with the existing local CLI and adopting its verified address');
        await command(process.execPath, ['scripts/local-node.mjs', 'deploy-ledger', '--broadcast',
            '--config', deployPath, '--env-file', join(directory, 'deployer.env')], { timeout: 210_000 });
        const metadata = JSON.parse(await readFile(`${deployPath}.deployment.local.json`, 'utf8'));
        config.ledgerContract = metadata.ledgerContract;
        await writeFile(fixtureEnv.OYA_CONFIG_FILE, JSON.stringify({ ...config, host: '0.0.0.0',
            rpcUrl: 'http://anvil:8545', ipfsUrl: 'http://ipfs:5001' }));
        const start = async () => {
            await compose(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '45', 'node']);
            nodeUrl = await endpoint('node', 8787);
            const health = await (await request(`${nodeUrl}/healthz`)).json();
            assert.equal(health.status, 'ready');
            assert.equal(health.nodeAddress.toLowerCase(), nodeWallet.address.toLowerCase());
            assert.equal(health.ledgerContract.toLowerCase(), metadata.ledgerContract.toLowerCase());
            assert.equal(health.chainId, 31337);
        };
        const nonce = () => rpc('eth_getTransactionCount', [nodeWallet.address, 'pending']);
        const send = async (wallet, text, code = 0) => {
            const path = join(directory, `${randomUUID()}.txt`);
            await writeFile(path, text, { mode: 0o600 });
            const output = await command(process.execPath, ['scripts/send-message.mjs', nodeUrl, path], {
                env: { ...baseEnv, OYA_AGENT_PRIVATE_KEY: wallet.privateKey }, timeout: 100_000, code,
            });
            return JSON.parse(output.toString());
        };
        const ledger = new Interface(['event Log(address indexed node, bytes32 indexed cidKeccak256Hash, string cid)']);
        const verify = async (publication, text) => {
            const content = await ipfs(`cat?arg=${publication.cid}`);
            assert.equal(content.status, 200);
            assert.equal(await content.text(), JSON.stringify({ text, signer: agent.address, signature: await agent.signMessage(text) }));
            const receipt = await rpc('eth_getTransactionReceipt', [publication.transactionHash]);
            assert.equal(receipt.status, '0x1');
            assert.equal(receipt.from.toLowerCase(), nodeWallet.address.toLowerCase());
            assert.equal(receipt.to.toLowerCase(), metadata.ledgerContract.toLowerCase());
            assert.equal(receipt.logs.length, 1);
            assert.equal(receipt.logs[0].address.toLowerCase(), metadata.ledgerContract.toLowerCase());
            const event = ledger.parseLog(receipt.logs[0]);
            assert.equal(event.name, 'Log');
            assert.equal(event.args.node.toLowerCase(), nodeWallet.address.toLowerCase());
            assert.equal(event.args.cid, publication.cid);
            assert.equal(event.args.cidKeccak256Hash, keccak256(toUtf8Bytes(publication.cid)));
            assert.equal(publication.uri, `ipfs://${publication.cid}`);
            return receipt;
        };
        const publish = async (text, pending = send(agent, text)) => {
            const body = await pending;
            assert.equal(body.status, 'logged');
            assert.equal(body.signer, agent.address);
            assert.equal(body.publication.status, 'logged');
            const receipt = await verify(body.publication, text);
            assert.equal(body.publication.blockNumber, BigInt(receipt.blockNumber).toString());
            assert.equal(body.publication.nodeAddress.toLowerCase(), nodeWallet.address.toLowerCase());
            assert.equal(body.publication.ledgerContract.toLowerCase(), metadata.ledgerContract.toLowerCase());
            if (verbose) console.log(`[docker] Verified CID ${body.publication.cid}; transaction ${body.publication.transactionHash}`);
            return body.publication;
        };
        const pendingHash = () => until(async () => {
            const block = await rpc('eth_getBlockByNumber', ['pending', false]);
            return block.transactions.length === 1 ? block.transactions[0] : false;
        }, 20_000);

        progress('Publishing through the Compose node from a separate agent process');
        await start();
        for (const [service, port] of Object.entries(ports)) {
            const bindings = JSON.parse((await command('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', await containerId(service)])).toString());
            const published = Object.entries(bindings).filter(([, addresses]) => addresses?.length);
            assert.deepEqual(published.map(([target]) => target), [`${port}/tcp`]);
            assert.equal(published[0][1][0].HostIp, '127.0.0.1');
        }
        assert.equal(await nonce(), '0x0');
        const firstText = 'A signed message through the Docker runtime.\n';
        const first = await publish(firstText);
        assert.equal((await send(disallowed, 'Disallowed sender.', 1)).code, 'unauthorized_signer');
        assert.equal(await nonce(), '0x1');
        const anvilId = await containerId('anvil');
        progress('Recreating node and Kubo while retaining the IPFS volume and Anvil');
        await compose(['stop', 'node', 'ipfs']);
        await compose(['up', '-d', '--no-deps', '--force-recreate', '--wait', 'ipfs']);
        ipfsUrl = await endpoint('ipfs', 5001);
        await compose(['up', '-d', '--no-deps', '--force-recreate', '--wait', 'node']);
        await start();
        assert.equal(await containerId('anvil'), anvilId);
        assert.equal((await (await ipfs('id')).json()).ID, peerId);
        assert.ok((await (await ipfs('pin/ls?type=recursive')).json()).Keys[first.cid]);
        await verify(first, firstText);
        assert.equal(await nonce(), '0x1');
        assert.equal(await rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x1');
        const second = await publish('A new message after container recreation.\n');

        progress('Stopping the node with a transaction pending for more than ten seconds');
        await rpc('evm_setAutomine', [false]);
        const drainText = 'Let this accepted operation drain during Docker SIGTERM.\n';
        const draining = send(agent, drainText);
        draining.catch(() => {});
        const drainingHash = await pendingHash();
        assert.equal((await send(agent, 'Busy request.', 1)).code, 'node_busy');
        assert.equal(await nonce(), '0x3');
        assert.deepEqual((await rpc('eth_getBlockByNumber', ['pending', false])).transactions, [drainingHash]);
        const nodeId = await containerId('node');
        const stopping = compose(['stop', 'node'], { timeout: 260_000 });
        stopping.catch(() => {});
        await until(async () => (await compose(['logs', '--no-log-prefix', 'node'])).toString().includes('"event":"stopping"'));
        await delay(12_000, undefined, { signal });
        assert.equal((await state(nodeId)).Running, true);
        await rpc('evm_mine');
        const drained = await publish(drainText, draining);
        assert.equal(drained.transactionHash, drainingHash);
        await stopping;
        assert.equal((await state(nodeId)).Running, false);
        assert.equal((await state(nodeId)).ExitCode, 0);
        await rpc('evm_setAutomine', [true]);
        await start();
        assert.equal(await nonce(), '0x3');

        progress('Leaving a receipt unknown, checking unhealthy status, then reconciling before restart');
        await rpc('evm_setAutomine', [false]);
        const unknownText = 'Reconcile this delayed receipt before explicitly restarting.\n';
        const timingOut = send(agent, unknownText, 1);
        timingOut.catch(() => {});
        const unknownHash = await pendingHash();
        const unknown = await timingOut;
        assert.equal(unknown.code, 'receipt_timeout');
        assert.equal(unknown.started, true);
        assert.equal(unknown.loggingOutcome, 'unknown');
        assert.equal(unknown.publication.transactionHash, unknownHash);
        const results = (await compose(['logs', '--no-log-prefix', 'node'])).toString().trim().split('\n').map((line) => JSON.parse(line));
        assert.ok(results.some((result) => result.httpStatus === 504 && result.publication?.transactionHash === unknownHash));
        const unhealthyId = await containerId('node');
        const startedAt = (await state(unhealthyId)).StartedAt;
        await until(async () => (await state(unhealthyId)).Health.Status === 'unhealthy');
        const health = await request(`${nodeUrl}/healthz`);
        assert.equal(health.status, 503);
        assert.equal((await health.json()).status, 'transaction_outcome_unknown');
        assert.equal((await send(agent, 'Unavailable request.', 1)).code, 'transaction_outcome_unknown');
        assert.equal(await nonce(), '0x4');
        assert.equal(await containerId('node'), unhealthyId);
        assert.equal((await state(unhealthyId)).StartedAt, startedAt);
        assert.equal((await command('docker', ['inspect', '--format', '{{.RestartCount}}', unhealthyId])).toString().trim(), '0');
        await rpc('evm_mine');
        await verify(unknown.publication, unknownText);
        assert.equal(await rpc('eth_getTransactionCount', [nodeWallet.address, 'latest']), '0x4');
        await rpc('evm_setAutomine', [true]);
        assert.equal((await request(`${nodeUrl}/healthz`)).status, 503);
        await compose(['restart', 'node']);
        await start();
        assert.equal(await nonce(), '0x4');
        await publish('Accept new work after receipt reconciliation and deliberate restart.\n');

        progress('Checking a cold backup restored into a fresh fixture volume');
        await compose(['stop', 'node', 'ipfs']);
        const permissions = await ipfsCommand(['stat', '-c', '%u:%g:%a', '/data/ipfs/config']);
        const archive = await ipfsCommand(['tar', '-C', '/data/ipfs', '-cpf', '-', '.']);
        await ipfsCommand(['tar', '-C', '/data/ipfs', '-xpf', '-'], { name: restoredProject, input: archive });
        assert.deepEqual(await ipfsCommand(['stat', '-c', '%u:%g:%a', '/data/ipfs/config'], { name: restoredProject }), permissions);
        assert.equal((await ipfsCommand(['ipfs', '--offline', 'id', '-f=<id>'], { name: restoredProject })).toString(), peerId);
        assert.ok((await ipfsCommand(['ipfs', '--offline', 'pin', 'ls', '--type=recursive'], { name: restoredProject })).toString().includes(first.cid));
        const restoredContent = await ipfsCommand(['ipfs', '--offline', 'cat', `/ipfs/${first.cid}`], { name: restoredProject });
        assert.equal(restoredContent.toString(), JSON.stringify({ text: firstText, signer: agent.address, signature: await agent.signMessage(firstText) }));
        for (const wallet of [agent, disallowed]) assert.equal(await rpc('eth_getBalance', [wallet.address, 'latest']), '0x0');
        t.diagnostic(JSON.stringify({ platform: fixtureEnv.OYA_TEST_PLATFORM, dockerArchitecture: docker.Arch,
            dockerVersion: docker.Version, composeVersion, nodeVersion: process.version, forgeVersion,
            kuboVersion: '0.43.0', ledgerContract: metadata.ledgerContract, nodeAddress: nodeWallet.address,
            agentAddress: agent.address, first, second, drained, reconciledTransactionHash: unknownHash,
            checks: ['separate signed sender', 'exact IPFS envelope and Ledger event', 'disallowed and busy rejection',
                'persistent identity, pins and content', 'no startup transaction', 'SIGTERM drains beyond ten seconds',
                'unknown outcome stays unhealthy without restart', 'receipt reconciliation before restart', 'cold backup restore'] }));
    } catch {
        // Process errors can contain credentials, temporary paths, and provider responses.
        throw new Error(`Docker validation failed during: ${stage}. Check Node 24, Foundry, Docker/Compose, and fixture prerequisites.`);
    }
});
