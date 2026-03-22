import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { ensureHarnessSession, resetHarnessSession } from './lib/testnet-harness-session.mjs';
import {
    ensureHarnessIpfs,
    getIpfsRuntimeStatus,
    isManageableLocalIpfsUrl,
    pollIpfsHealth,
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

async function closeServer(server) {
    await new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

async function run() {
    assert.equal(isManageableLocalIpfsUrl('http://127.0.0.1:5001'), true);
    assert.equal(isManageableLocalIpfsUrl('http://localhost:5001'), true);
    assert.equal(isManageableLocalIpfsUrl('https://ipfs.example.com'), false);

    const server = createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/v0/version') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ Version: 'test-kubo' }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    const repoRootPath = await mkdtemp(path.join(os.tmpdir(), 'testnet-harness-phase6-'));
    const sessionPaths = await ensureHarnessSession({
        repoRootPath,
        agentRef: 'signed-message-smoke',
        profile: 'local-mock',
    });

    try {
        const port = await listenOnEphemeralPort(server);
        const baseUrl = `http://127.0.0.1:${port}`;

        const health = await pollIpfsHealth(baseUrl);
        assert.equal(health.ok, true);

        const record = await ensureHarnessIpfs({
            sessionPaths,
            runtimeConfig: {
                ipfsEnabled: true,
                ipfsApiUrl: baseUrl,
            },
            existingRecord: null,
            env: process.env,
            cwd: repoRootPath,
        });
        assert.equal(record.managed, false);
        assert.equal(record.external, true);
        assert.equal(record.pid, null);
        assert.equal(record.baseUrl, baseUrl);

        const status = await getIpfsRuntimeStatus(record, {
            runtimeConfig: {
                ipfsEnabled: true,
                ipfsApiUrl: baseUrl,
            },
        });
        assert.equal(status.enabled, true);
        assert.equal(status.running, true);
        assert.equal(status.ready, true);
        assert.equal(status.managed, false);
        assert.equal(status.external, true);
    } finally {
        await closeServer(server);
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
