import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, chown, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { createInboxClient } from '../src/inbox/http.mjs';
import { signJob } from '../src/inbox/protocol.mjs';
import { createFixtureRedactor } from './inbox-docker-diagnostics.mjs';

const execute = promisify(execFile);
const production = fileURLToPath(new URL('../', import.meta.url));

test('packaged inbox and local worker publish offline-queued jobs through HTTPS in both modes', { timeout: 600000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oya-inbox-docker-'));
    if (process.getuid?.() === 0) await chown(directory, 1000, 1000);
    const project = `oya-inbox-${randomUUID()}`;
    const image = `${project}-node`;
    const proxyCheck = `${project}-proxy-config`;
    const files = ['inbox/compose.yaml', 'inbox/compose.postgres.yaml', 'inbox/compose.https.yaml', 'inbox/compose.worker.yaml']
        .map(file => join(production, file)).concat(join(directory, 'fixture.yaml'));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OYA_|COMPOSE_|NODE_)/.test(key))),
        OYA_NODE_IMAGE: image, OYA_INBOX_DIR: directory, OYA_LOCAL_DIR: directory,
        OYA_CONTAINER_USER: process.getuid?.() ? `${process.getuid()}:${process.getgid()}` : '1000:1000',
        OYA_PUBLIC_HOSTNAME: 'proxy' };
    let stage = 'prepare fixture';
    let configured = false, succeeded = false;
    const secrets = [];
    const redact = createFixtureRedactor(secrets, [[directory, '<fixture>'], [production, '<production>/']]);
    const progress = value => { stage = value; console.log(`[inbox] ${value}`); };
    const command = async (file, args, timeout = 180000) => {
        try { return (await execute(file, args, { env, cwd: production, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
        catch (error) {
            const details = redact(error.stderr || error.stdout || error.code || 'No command output.').slice(-8000);
            throw new Error(`Inbox Docker command failed during ${stage}:\n${details}`);
        }
    };
    const compose = (args, timeout) => command('docker', ['compose', '--project-name', project, '--env-file', join(directory, 'empty.env'),
        ...files.flatMap(file => ['-f', file]), ...args], timeout);
    t.after(async () => {
        if (!succeeded && configured) {
            for (const args of [['ps', '--all'], ['logs', '--no-color', '--tail', '80']]) {
                try { t.diagnostic(redact(await compose(args, 15000)).slice(-16000)); }
                catch (error) { t.diagnostic(error.message); }
            }
        }
        await command('docker', ['rm', '-f', '-v', proxyCheck], 15000).catch(() => {});
        await compose(['down', '--volumes', '--remove-orphans', '--timeout', '3']).catch(() => {});
        await command('docker', ['image', 'rm', image]).catch(() => {});
        await rm(directory, { recursive: true, force: true });
    });
    const write = async (name, content) => {
        const path = join(directory, name);
        await writeFile(path, content, { mode: 0o600 });
        if (process.getuid?.() === 0) await chown(path, 1000, 1000);
    };
    const until = async (check, { timeoutMs = 60000, intervalMs = 250 } = {}) => {
        const deadline = performance.now() + timeoutMs;
        let lastError;
        while (performance.now() < deadline) {
            t.signal.throwIfAborted();
            try { const value = await check(); if (value) return value; }
            catch (error) { lastError = redact(error.message); }
            await delay(Math.min(intervalMs, Math.max(0, deadline - performance.now())), undefined, { signal: t.signal });
        }
        throw new Error(`Inbox Docker fixture timed out after ${timeoutMs}ms during ${stage}.${lastError ? ` Last error: ${lastError}` : ''}`);
    };
    const endpoint = async (service, port) => `http://${await compose(['port', service, String(port)])}`;
    const password = randomBytes(32).toString('hex');
    const workerToken = randomBytes(32).toString('base64url');
    const agent = Wallet.createRandom();
    const nodeWallet = Wallet.createRandom();
    secrets.push(password, workerToken, agent.privateKey, nodeWallet.privateKey);
    await write('empty.env', '');
    await write('postgres-password', password + '\n');
    await write('inbox-secrets.json', JSON.stringify({ databaseUrl: `postgres://oya:${password}@postgres:5432/oya`, workerToken }));
    await write('worker-secrets.json', JSON.stringify({ workerToken }));
    await write('root.crt', '');
    const proxyConfig = await readFile(join(production, 'inbox/Caddyfile'), 'utf8');
    await write('Caddyfile', proxyConfig.replace('{$OYA_PUBLIC_HOSTNAME} {', 'https://proxy {\n    tls internal'));
    // Caddy drops DAC_OVERRIDE and cannot read a runner-owned 0600 file on Linux.
    // This file contains only proxy routes; generated secret files remain 0600.
    await chmod(join(directory, 'Caddyfile'), 0o644);
    await write('fixture.yaml', `services:
  inbox:
    ports: !override ["127.0.0.1::8788"]
    restart: "no"
  node:
    ports: !override ["127.0.0.1::8787"]
    restart: "no"
    environment:
      NODE_EXTRA_CA_CERTS: /trust/root.crt
    volumes:
      - type: bind
        source: \${OYA_LOCAL_DIR}/root.crt
        target: /trust/root.crt
        read_only: true
  ipfs:
    command: [daemon, --offline, --migrate=true]
    ports: !override ["127.0.0.1::5001"]
    restart: "no"
  proxy:
    restart: "no"
    ports: !override ["127.0.0.1::443"]
    volumes:
      - type: bind
        source: \${OYA_INBOX_DIR}/Caddyfile
        target: /etc/caddy/Caddyfile
        read_only: true
  anvil:
    image: ghcr.io/foundry-rs/foundry:v1.5.1@sha256:3a70bfa9bd2c732a767bb60d12c8770b40e8f9b6cca28efc4b12b1be81c7f28e
    entrypoint: [anvil]
    command: [--host, "0.0.0.0", --chain-id, "31337", --accounts, "0", --silent]
    ports: ["127.0.0.1::8545"]
`);
    configured = true;
    progress('verify proxy configuration with Linux file ownership');
    const model = JSON.parse(await compose(['config', '--format', 'json']));
    // docker cp --archive preserves the runner UID and mode on a Linux inode,
    // avoiding Docker Desktop bind-mount permission translation in this regression.
    await command('docker', ['create', '--name', proxyCheck, '--network', 'none', '--read-only', '--volume', '/etc/caddy',
        '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges',
        '--entrypoint', 'caddy', model.services.proxy.image, 'adapt', '--config', '/etc/caddy/Caddyfile']);
    await command('docker', ['cp', '--archive', join(directory, 'Caddyfile'), `${proxyCheck}:/etc/caddy/Caddyfile`]);
    await command('docker', ['start', '--attach', proxyCheck]);
    assert.equal(await command('docker', ['inspect', '--format', '{{.State.ExitCode}}', proxyCheck]), '0',
        'The hardened proxy must be able to read the generated Caddyfile with Linux permissions.');
    progress('build image');
    await command('docker', ['build', '-t', image, production], 300000);
    const client = args => command('docker', ['run', '--rm', '--network', 'none', '--user', env.OYA_CONTAINER_USER,
        '--mount', `type=bind,src=${directory},dst=/private`, '--entrypoint', 'node', image, '/app/src/inbox/client.mjs', ...args]);
    const generated = JSON.parse(await client(['keygen', '/private/client-key']));
    secrets.push((await readFile(join(directory, 'client-key'), 'utf8')).trim());
    await write('client-text', 'Client CLI fixture');
    await client(['prepare', '/private/client-key', 'test-ipfs', '/private/client-text', '/private/client-job.json']);
    const preparedJob = JSON.parse(await readFile(join(directory, 'client-job.json'), 'utf8'));
    assert.equal(preparedJob.message.signer, generated.address);
    await assert.rejects(client(['prepare', '/private/client-key', 'test-ipfs', '/private/client-text', '/private/client-job.json']));
    await compose(['up', '-d', '--wait', 'postgres', 'ipfs', 'anvil']);
    const provider = new JsonRpcProvider(await endpoint('anvil', 8545));
    t.after(() => provider.destroy());
    await until(() => provider.send('eth_chainId', []));
    await provider.send('anvil_setBalance', [nodeWallet.address, '0x56bc75e2d63100000']);
    const deployer = Wallet.createRandom().connect(provider);
    secrets.push(deployer.privateKey);
    await provider.send('anvil_setBalance', [deployer.address, '0x56bc75e2d63100000']);
    const artifact = JSON.parse(await readFile(join(production, '../../contracts/out/Ledger.sol/Ledger.json'), 'utf8'));
    const ledger = await new ContractFactory(artifact.abi, artifact.bytecode.object, deployer).deploy();
    await ledger.waitForDeployment();
    const ledgerContract = await ledger.getAddress();
    const ipfsUrl = await endpoint('ipfs', 5001);

    for (const mode of ['ipfs', 'ledger']) {
        progress(`${mode}: configure and start inbox with worker offline`);
        const target = `test-${mode}`;
        const execution = mode === 'ipfs' ? { mode } : { mode, chainId: 31337, ledgerContract, nodeAddress: nodeWallet.address };
        await write('inbox.json', JSON.stringify({ target, host: '0.0.0.0', allowedSigners: [agent.address], execution, databaseTls: false }));
        await write('node.json', JSON.stringify({ mode, host: '0.0.0.0', allowedSigners: [agent.address], ipfsUrl: 'http://ipfs:5001',
            ...(mode === 'ledger' ? { chainId: 31337, ledgerContract, rpcUrl: 'http://anvil:8545' } : {}) }));
        await write('node.env', mode === 'ledger' ? `OYA_NODE_PRIVATE_KEY=${nodeWallet.privateKey}\n` : '');
        await write('worker.json', JSON.stringify({ target, url: 'https://proxy', pollIntervalMs: 1000 }));
        await compose(['up', '-d', '--force-recreate', '--wait', 'inbox', 'proxy']);
        progress(`${mode}: wait for proxy CA certificate`);
        const ca = await until(() => compose(['exec', '-T', 'proxy', 'cat', '/data/caddy/pki/authorities/local/root.crt'], 10000),
            { timeoutMs: 120000 });
        await write('root.crt', ca);
        const proxyPort = new URL(await endpoint('proxy', 443)).port;
        const transport = (url, options) => new Promise((resolveResponse, reject) => {
            const request = httpsRequest({ hostname: '127.0.0.1', port: proxyPort, servername: 'proxy', ca,
                path: new URL(url).pathname, method: options.method, headers: { ...options.headers, host: 'proxy' }, signal: options.signal }, response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('error', reject);
                response.on('end', () => resolveResponse(new Response(Buffer.concat(chunks), { status: response.statusCode })));
            });
            request.on('error', reject);
            request.end(options.body);
        });
        const api = createInboxClient('https://proxy', undefined, transport);
        progress(`${mode}: verify HTTPS inbox and queue offline job`);
        await until(async () => (await transport('https://proxy/healthz', { method: 'GET', signal: AbortSignal.timeout(5000) })).status === 404);
        const job = await signJob(agent, target, `Real ${mode} inbox publication`);
        assert.equal((await api('/v1/jobs', job)).status, 'queued');
        await compose(['restart', 'inbox']);
        assert.equal((await until(() => api('/v1/status', job))).status, 'queued');
        progress(`${mode}: start local worker and verify publication`);
        await compose(['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90', 'node']);
        const completed = await until(async () => {
            const status = await api('/v1/status', job);
            return status.status === (mode === 'ipfs' ? 'published' : 'logged') && status;
        });
        const content = await (await fetch(`${ipfsUrl}/api/v0/cat?arg=${completed.cid}`, { method: 'POST' })).json();
        assert.deepEqual(content, job.message);
        if (mode === 'ledger') {
            assert.equal(await provider.getTransactionCount(nodeWallet.address, 'latest'), 1);
            assert.equal((await provider.getTransactionReceipt(completed.transactionHash)).status, 1);
        }
        assert.equal((await api('/v1/jobs', job)).requestId, job.requestId);
        await compose(['restart', 'node']);
        assert.equal((await api('/v1/status', job)).status, completed.status);
        const logs = await compose(['logs', '--no-color', 'node', 'inbox']);
        for (const secret of [password, workerToken, nodeWallet.privateKey, agent.privateKey]) assert.equal(logs.includes(secret), false);
        assert.ok(logs.includes('job_result'));
        await compose(['stop', 'node', 'inbox', 'proxy']);
    }
    succeeded = true;
    progress('both modes passed with real PostgreSQL, HTTPS, Kubo and Anvil');
});
