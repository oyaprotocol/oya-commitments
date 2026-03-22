import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { ensureHarnessSession, resetHarnessSession } from './lib/testnet-harness-session.mjs';
import {
    buildIpfsApiMultiaddr,
    ensureHarnessIpfs,
    getIpfsRuntimeStatus,
    stopHarnessIpfs,
} from './lib/testnet-harness-ipfs.mjs';

async function listenOnEphemeralPort(server, host = '127.0.0.1') {
    return await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to bind test server.'));
                return;
            }
            resolve(address.port);
        });
    });
}

async function createMockIpfsExecutable(rootDir) {
    const executablePath = path.join(rootDir, 'mock-ipfs.mjs');
    const source = `#!/usr/bin/env node
const { createServer } = await import('node:http');
const { mkdir, readFile, writeFile, appendFile } = await import('node:fs/promises');
const path = await import('node:path');

const repoPath = process.env.IPFS_PATH;
const logPath = process.env.MOCK_IPFS_LOG;
if (!repoPath) {
    throw new Error('IPFS_PATH is required.');
}
if (!logPath) {
    throw new Error('MOCK_IPFS_LOG is required.');
}

const args = process.argv.slice(2);
await appendFile(logPath, JSON.stringify(args) + '\\n');

const configPath = path.join(repoPath, 'config.json');

async function ensureRepoConfig() {
    await mkdir(repoPath, { recursive: true });
    try {
        await readFile(configPath, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
        await writeFile(
            configPath,
            JSON.stringify({
                Addresses: {
                    API: '/ip4/127.0.0.1/tcp/0',
                },
            }, null, 2)
        );
    }
}

function parseMultiaddr(value) {
    const match = String(value).match(/^\\/(ip4|ip6)\\/([^/]+)\\/tcp\\/(\\d+)$/);
    if (!match) {
        throw new Error('Unsupported multiaddr: ' + value);
    }
    return {
        family: match[1],
        host: match[2],
        port: Number(match[3]),
    };
}

if (args[0] === 'init') {
    await ensureRepoConfig();
    process.exit(0);
}

if (args[0] === 'config' && args[1] === 'Addresses.API' && args[2]) {
    await ensureRepoConfig();
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    parsed.Addresses = parsed.Addresses || {};
    parsed.Addresses.API = args[2];
    await writeFile(configPath, JSON.stringify(parsed, null, 2));
    process.exit(0);
}

if (args[0] === 'daemon') {
    await ensureRepoConfig();
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    const { host, port } = parseMultiaddr(parsed.Addresses?.API);
    const server = createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/v0/version') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ Version: 'mock-kubo' }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    process.on('SIGTERM', () => {
        server.close(() => process.exit(0));
    });
    process.on('SIGINT', () => {
        server.close(() => process.exit(0));
    });

    server.listen(port, host, () => {
        console.log('mock ipfs daemon ready on ' + host + ':' + port);
    });
    await new Promise(() => {});
}

throw new Error('Unsupported mock ipfs command: ' + args.join(' '));
`;
    await writeFile(executablePath, source, 'utf8');
    await chmod(executablePath, 0o755);
    return executablePath;
}

async function run() {
    assert.equal(buildIpfsApiMultiaddr('http://127.0.0.1:5001'), '/ip4/127.0.0.1/tcp/5001');
    assert.equal(buildIpfsApiMultiaddr('http://localhost:5001'), '/ip4/127.0.0.1/tcp/5001');
    assert.equal(buildIpfsApiMultiaddr('http://[::1]:5001'), '/ip6/::1/tcp/5001');

    const repoRootPath = await mkdtemp(path.join(os.tmpdir(), 'testnet-harness-phase7-'));
    const sessionPaths = await ensureHarnessSession({
        repoRootPath,
        agentRef: 'signed-message-smoke',
        profile: 'local-mock',
    });

    const portProbe = createServer(() => {});
    const port = await listenOnEphemeralPort(portProbe);
    await new Promise((resolve, reject) => portProbe.close((error) => (error ? reject(error) : resolve())));

    const baseUrl = `http://127.0.0.1:${port}`;
    const logPath = path.join(repoRootPath, 'mock-ipfs.log');
    const executablePath = await createMockIpfsExecutable(repoRootPath);

    let record = null;
    try {
        record = await ensureHarnessIpfs({
            sessionPaths,
            runtimeConfig: {
                ipfsEnabled: true,
                ipfsApiUrl: baseUrl,
            },
            existingRecord: null,
            env: {
                ...process.env,
                IPFS_BIN: executablePath,
                MOCK_IPFS_LOG: logPath,
            },
            cwd: repoRootPath,
        });

        assert.equal(record.managed, true);
        assert.equal(record.external, false);
        assert.equal(record.baseUrl, baseUrl);
        assert.equal(typeof record.pid, 'number');

        const status = await getIpfsRuntimeStatus(record, {
            runtimeConfig: {
                ipfsEnabled: true,
                ipfsApiUrl: baseUrl,
            },
        });
        assert.equal(status.enabled, true);
        assert.equal(status.running, true);
        assert.equal(status.ready, true);
        assert.equal(status.managed, true);

        const logLines = (await readFile(logPath, 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        assert.deepEqual(logLines[0], ['init', '--profile=test']);
        assert.deepEqual(logLines[1], ['config', 'Addresses.API', buildIpfsApiMultiaddr(baseUrl)]);
        assert.deepEqual(logLines[2], ['daemon']);
    } finally {
        if (record) {
            await stopHarnessIpfs(record);
        }
        await resetHarnessSession({
            repoRootPath,
            agentRef: 'signed-message-smoke',
            profile: 'local-mock',
        });
        await rm(repoRootPath, { recursive: true, force: true });
    }

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
