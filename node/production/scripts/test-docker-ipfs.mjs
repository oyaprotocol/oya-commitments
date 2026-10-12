import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chown, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as requestHttps } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { Wallet, verifyMessage } from 'ethers';

const execute = promisify(execFile);
const production = fileURLToPath(new URL('../', import.meta.url));
const { values: { verbose, platform } } = parseArgs({ options: {
    verbose: { type: 'boolean', default: false }, platform: { type: 'string' },
} });
if (platform && !['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('Select linux/amd64 or linux/arm64.');

test('IPFS-only Docker node publishes through HTTPS and the hourly agent without Ethereum or a node key', { timeout: 600_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'oya-ipfs-docker-'));
    const project = `oya-ipfs-${randomUUID()}`;
    const image = `${project}-node`;
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(OYA_|LEDGER_|LOGGER_|FOUNDRY_|DAPP_|ETH_|ETHERSCAN_|VERIFIER_|IPFS_|COMPOSE_)/.test(key)
        && !['NODE_OPTIONS', 'NODE_PATH', 'INIT_CWD', 'DOCKER_DEFAULT_PLATFORM', 'NODE_EXTRA_CA_CERTS',
            'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY'].includes(key)));
    const env = { ...baseEnv, COMPOSE_PROJECT_NAME: project, OYA_TEST_AGENT_IMAGE: image,
        OYA_CONFIG_FILE: join(directory, 'node.json'), OYA_ENV_FILE: join(directory, 'node.env'),
        OYA_TEST_AGENT_DIR: join(directory, 'agent-private'),
        OYA_TEST_AGENT_SOURCE: join(production, '../../agent-library/agents/hourly-message-test'),
        OYA_PUBLIC_HOSTNAME: 'localhost',
        OYA_CONTAINER_USER: process.getuid?.() ? `${process.getuid()}:${process.getgid()}` : '1000:1000' };
    let stage = 'prerequisites', configured = false, built = false;
    const progress = message => { stage = message; if (verbose) console.log(`[ipfs] ${message}`); };
    const command = async (file, args, { cleanup = false, ...options } = {}) => {
        try {
            return (await execute(file, args, { cwd: production, env, encoding: 'utf8', timeout: 120_000,
                maxBuffer: 8 * 1024 * 1024, ...(cleanup ? {} : { signal: t.signal }), ...options })).stdout;
        } catch { throw new Error(`IPFS fixture command failed during ${stage}.`); }
    };
    const compose = (args, options = {}) => command('docker', ['compose', '--project-name', project,
        '--env-file', join(directory, 'empty.env'), '--profile', 'testing',
        ...['compose.yaml', 'docker/compose.http.yaml', 'docker/compose.testing.yaml',
            'docker/compose.ipfs.test.yaml', 'docker/compose.http.test.yaml'].flatMap(file => ['-f', join(production, file)]),
        ...args], options);
    t.after(async () => {
        try {
            if (configured) await compose(['down', '--volumes', '--remove-orphans', '--timeout', '5'], { cleanup: true });
            if (built) await command('docker', ['image', 'rm', image], { cleanup: true });
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
    const until = async (check) => {
        const deadline = performance.now() + 60_000;
        while (performance.now() < deadline) {
            t.signal.throwIfAborted();
            try { const result = await check(); if (result) return result; } catch { t.signal.throwIfAborted(); }
            await delay(200, undefined, { signal: t.signal });
        }
        throw new Error(`IPFS fixture timed out during ${stage}.`);
    };
    const endpoint = async (service, port) => {
        const address = (await compose(['port', service, String(port)])).trim();
        assert.match(address, /^127\.0\.0\.1:\d+$/);
        return `http://${address}`;
    };
    const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.any([t.signal, AbortSignal.timeout(15_000)]) });
    try {
        assert.equal(process.versions.node.split('.')[0], '24');
        env.OYA_TEST_PLATFORM = platform ?? (await command('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'])).trim();
        const agent = Wallet.createRandom();
        const config = { mode: 'ipfs', host: '0.0.0.0', port: 8787, allowedSigners: [agent.address], ipfsUrl: 'http://ipfs:5001' };
        await mkdir(env.OYA_TEST_AGENT_DIR, { mode: 0o700 });
        for (const [path, content] of [[env.OYA_CONFIG_FILE, JSON.stringify(config)], [env.OYA_ENV_FILE, ''], [join(directory, 'empty.env'), '']]) {
            await writeFile(path, content, { mode: 0o600 });
            if (process.getuid?.() === 0) await chown(path, 1000, 1000);
        }
        if (process.getuid?.() === 0) await chown(env.OYA_TEST_AGENT_DIR, 1000, 1000);
        const model = JSON.parse(await compose(['config', '--format', 'json']));
        assert.deepEqual(Object.keys(model.services).sort(), ['ipfs', 'node', 'proxy', 'test-agent']);
        assert.deepEqual(Object.keys(model.services.node.depends_on), ['ipfs']);
        assert.equal(model.services.node.environment, undefined);
        configured = true;
        progress(`Building ${env.OYA_TEST_PLATFORM} and running hourly-agent unit tests`);
        await compose(['build', 'node'], { timeout: 300_000 });
        built = true;
        await command('docker', ['run', '--rm', '--network', 'none', '--read-only', '--platform', env.OYA_TEST_PLATFORM,
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
            '--mount', `type=bind,src=${env.OYA_TEST_AGENT_SOURCE},dst=/app/test-agent,readonly`,
            '--entrypoint', 'node', image, '--test', '/app/test-agent/test-agent.test.mjs']);
        progress('Initializing only the agent key and starting Kubo, node, and HTTPS');
        await command('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--user', env.OYA_CONTAINER_USER, '--platform', env.OYA_TEST_PLATFORM,
            '--mount', `type=bind,src=${env.OYA_TEST_AGENT_SOURCE},dst=/app/test-agent,readonly`,
            '--mount', `type=bind,src=${env.OYA_TEST_AGENT_DIR},dst=/setup`,
            '--mount', `type=bind,src=${env.OYA_CONFIG_FILE},dst=/config/node.json`,
            '--entrypoint', 'node', image, '/app/test-agent/agent.mjs', 'init', '/setup/key', '/config/node.json']);
        await compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'ipfs', 'node', 'proxy'], { timeout: 240_000 });
        let nodeUrl = await endpoint('node', 8787), ipfsUrl = await endpoint('ipfs', 5001);
        const publicUrl = (await endpoint('proxy', 443)).replace('http://127.0.0.1', 'https://localhost');
        const ca = await until(() => compose(['exec', '-T', 'proxy', 'cat', '/data/caddy/pki/authorities/local/root.crt']));
        const https = (path, body) => new Promise((resolve, reject) => {
            const req = requestHttps(`${publicUrl}${path}`, { ca, family: 4, method: body ? 'POST' : 'GET',
                headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([t.signal, AbortSignal.timeout(15_000)]) }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('error', reject);
                res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
            });
            req.on('error', reject);
            req.end(body && JSON.stringify(body));
        });
        await until(async () => (await https('/healthz')).status === 404);
        assert.deepEqual(await (await request(`${nodeUrl}/healthz`)).json(), { status: 'ready', mode: 'ipfs', busy: false });
        const ipfs = path => request(`${ipfsUrl}/api/v0/${path}`, { method: 'POST' });
        const peerId = (await (await ipfs('id')).json()).ID;
        const text = 'IPFS-only publication through HTTPS.\n';
        const envelope = { text, signer: agent.address, signature: await agent.signMessage(text) };
        progress('Publishing and independently retrieving exact bytes through HTTPS');
        const response = await https('/v1/messages', envelope);
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.status, 'published');
        assert.deepEqual(Object.keys(result.publication).sort(), ['cid', 'status', 'uri']);
        assert.equal(result.publication.uri, `ipfs://${result.publication.cid}`);
        assert.equal(await (await ipfs(`cat?arg=${result.publication.cid}`)).text(), JSON.stringify(envelope));
        assert.equal((await https('/v1/messages', { ...envelope, text: 'tampered' })).status, 401);
        const outsider = Wallet.createRandom();
        assert.equal((await https('/v1/messages', { text, signer: outsider.address, signature: await outsider.signMessage(text) })).status, 403);
        assert.deepEqual(await (await https('/v1/messages', envelope)).json(), result);
        progress('Checking recovery after an IPFS outage and retained content after container replacement');
        await compose(['stop', '--timeout', '10', 'ipfs']);
        const failed = await https('/v1/messages', envelope);
        assert.equal(failed.status, 502);
        assert.deepEqual(await failed.json(), { code: 'publication_failed', started: true });
        assert.equal((await (await request(`${nodeUrl}/healthz`)).json()).status, 'ready');
        await compose(['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '90', 'ipfs']);
        ipfsUrl = await endpoint('ipfs', 5001);
        assert.equal((await (await ipfs('id')).json()).ID, peerId);
        assert.equal(await (await ipfs(`cat?arg=${result.publication.cid}`)).text(), JSON.stringify(envelope));
        await compose(['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '45', 'node']);
        nodeUrl = await endpoint('node', 8787);
        // Caddy resolves the recreated node on a fresh connection.
        assert.equal((await https('/v1/messages', envelope)).status, 200);
        progress('Verifying hourly IPFS publication and private key mounts');
        await compose(['up', '-d', '--no-build', '--pull', 'never', '--wait', 'test-agent']);
        const published = await until(async () => (await compose(['logs', '--no-log-prefix', 'test-agent'])).trim()
            .split('\n').filter(Boolean).map(line => JSON.parse(line)).find(record => record.event === 'test_message_published'));
        assert.equal(published.transactionHash, undefined);
        const stored = await (await ipfs(`cat?arg=${published.cid}`)).json();
        assert.equal(verifyMessage(stored.text, stored.signature), published.signer);
        assert.equal(stored.signer, published.signer);
        assert.match(stored.text, /^Hourly test message /);
        const id = (await compose(['ps', '--quiet', 'test-agent'])).trim();
        const container = JSON.parse(await command('docker', ['inspect', id]))[0];
        assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [`${project}_testing`]);
        assert.ok(container.Mounts.every(mount => !mount.RW));
        assert.equal(await readFile(env.OYA_ENV_FILE, 'utf8'), '');
        await compose(['stop', '--timeout', '10', 'test-agent', 'proxy', 'node']);
        assert.equal(JSON.parse(await command('docker', ['inspect', id]))[0].State.ExitCode, 0);
        t.diagnostic(JSON.stringify({ platform: env.OYA_TEST_PLATFORM, cid: result.publication.cid,
            checks: ['no Ethereum service or node key', 'HTTPS', 'exact signed IPFS bytes', 'authorization',
                'IPFS outage recovery', 'retained IPFS identity and content', 'hourly agent publication'] }));
    } catch (error) {
        throw new Error(`IPFS Docker validation failed during ${stage}; ${error.code ?? error.name}.`);
    }
});
