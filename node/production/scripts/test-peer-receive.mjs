import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Wallet } from 'ethers';
import { Pool } from 'pg';
import { InboxStore } from '../src/inbox/store.mjs';
import { parseInboxConfig } from '../src/inbox/config.mjs';
import { PeerStore } from '../src/peers/store.mjs';
import { signPeer, MAX_AGE, peerDigest, peerJob } from '../src/peers/protocol.mjs';
import { sendPeer } from '../src/peers/client.mjs';
import { waitForPostgres } from './postgres-readiness.mjs';
import { cid } from '../test/runtime-fixture.mjs';

const execute = promisify(execFile);
const runtime = fileURLToPath(new URL('../', import.meta.url));
const postgresImage = 'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';

test('peer reception with real PostgreSQL, process restart and one-shot CLI', { timeout: 300000 }, async t => {
    const name = `oya-peer-test-${randomUUID()}`;
    const password = randomBytes(32).toString('hex');
    const dir = await mkdtemp(join(tmpdir(), 'oya-peer-db-'));
    const pools = [];
    const children = [];
    const docker = async args => (await execute('docker', args, { timeout: 180000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, POSTGRES_PASSWORD: password } })).stdout.trim();
    t.after(async () => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
        for (const pool of pools) if (!pool.ended) await pool.end();
        await docker(['rm', '-f', '-v', name]).catch(() => {});
        await rm(dir, { recursive: true, force: true });
    });
    await docker(['run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD', '-p', '127.0.0.1::5432', postgresImage]);
    const database = { host: '127.0.0.1', port: 0, user: 'postgres', password, database: 'postgres', max: 5,
        connectionTimeoutMillis: 1000, statement_timeout: 10000, idle_in_transaction_session_timeout: 15000 };
    const ready = async () => {
        database.port = Number((await docker(['port', name, '5432'])).split(':').at(-1));
        const pool = new Pool(database);
        pool.on('error', () => {});
        try { await waitForPostgres(pool, { signal: t.signal }); } finally { await pool.end(); }
    };
    await ready();
    const sender = Wallet.createRandom();
    const receiver = Wallet.createRandom();
    const config = { networkId: 'testnet', nodeAddress: receiver.address.toLowerCase(), target: `peer-${randomUUID()}`,
        members: Object.freeze([sender.address.toLowerCase()]), maxTextBytes: 8192, maxMessages: 2, retentionMs: MAX_AGE };
    const make = overrides => signPeer(sender, { networkId: config.networkId, receiver: config.nodeAddress,
        target: config.target, text: 'ordinary peer publication', ...overrides });
    const newStore = async (settings = config) => {
        const inbox = new InboxStore(database, parseInboxConfig({ target: settings.target, allowedSigners: [sender.address], execution: { mode: 'ipfs' } }));
        pools.push(inbox.pool); await inbox.initialize();
        const store = new PeerStore(inbox.pool, settings, inbox); await store.initialize(); return store;
    };
    let store = await newStore();
    const original = await make();
    let receipt;
    await t.test('concurrent retries return one immutable receipt; conflicting content fails', async () => {
        const results = await Promise.all(Array.from({ length: 8 }, () => store.receive(original)));
        receipt = results[0];
        for (const result of results) assert.deepEqual(result, receipt);
        const changed = await make({ requestId: original.requestId, text: 'changed' });
        await assert.rejects(store.receive(changed), { code: 'peer_id_conflict' });
        await assert.rejects(store.status(changed), { code: 'peer_not_found' });
        const row = (await store.pool.query('SELECT * FROM oya_peer_messages WHERE target=$1', [config.target])).rows[0];
        assert.deepEqual(row.envelope, original);
        assert.equal(row.digest, peerDigest(original));
        const jobs = await store.pool.query('SELECT payload FROM oya_inbox_jobs WHERE target=$1', [config.target]);
        assert.deepEqual(jobs.rows.map(row => row.payload), [peerJob(original)]);
        assert.ok(receipt.retainedUntil >= original.expiresAt);
    });
    await t.test('independent pools serialize capacity and retain earlier accepted records', async () => {
        const other = await newStore();
        const values = await Promise.all(Array.from({ length: 8 }, () => make()));
        const results = await Promise.allSettled(values.map((value, i) => (i % 2 ? store : other).receive(value)));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'peer_capacity'));
        assert.deepEqual(await other.receive(original), receipt);
        assert.equal((await other.prune()).deleted, 0);
    });
    await t.test('lost acknowledgement survives database restart; identity changes fail closed', async () => {
        // Commit an identical retry, then sever HTTP before acknowledging it.
        const server = httpServer(async (request, response) => {
            request.resume();
            try { await store.receive(original); response.destroy(); }
            catch { response.writeHead(503); response.end(); }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            await assert.rejects(sendPeer(`http://127.0.0.1:${server.address().port}`, JSON.stringify(original), 'submit'));
        } finally { await new Promise(resolve => server.close(resolve)); }
        // Recover through status after restarting the database and every pool.
        for (const pool of pools) if (!pool.ended) await pool.end();
        await docker(['restart', name]); await ready();
        store = await newStore();
        assert.deepEqual(await store.status(original), receipt);
        assert.deepEqual(await store.receive(original), receipt);
        for (const override of [{ networkId: 'different' }, { nodeAddress: sender.address.toLowerCase() }]) {
            await assert.rejects(newStore({ ...config, ...override }), /identity changed/);
        }
        const revoked = await newStore({ ...config, members: [] });
        await assert.rejects(revoked.status(original), { status: 403 });
        await assert.rejects(revoked.receive(original), { status: 403 });
    });
    await t.test('expired-envelope status and bounded retention; publication checkpoints remain intact', async () => {
        const shortConfig = { ...config, target: `short-${randomUUID()}`, retentionMs: 250, maxMessages: 1 };
        const short = await newStore(shortConfig);
        const value = await make({ target: shortConfig.target, expiresAt: Date.now() + 500 });
        const accepted = await short.receive(value);
        assert.equal(accepted.retainedUntil, value.expiresAt);
        assert.equal((await short.prune()).deleted, 0);
        await assert.rejects(short.receive(await make({ target: shortConfig.target })), { code: 'peer_capacity' });
        const retained = await newStore({ ...shortConfig, target: `retained-${randomUUID()}`, retentionMs: 60000 });
        const expired = await make({ target: retained.config.target, expiresAt: Date.now() + 500 });
        const retainedReceipt = await retained.receive(expired);
        await delay(550);
        assert.deepEqual(await retained.status(expired), retainedReceipt);
        await assert.rejects(retained.receive(expired), { code: 'invalid_peer_expiry' });
        await short.receive(await make({ target: shortConfig.target, expiresAt: Date.now() + 500 })); // admission prunes the expired receipt before capacity check
        assert.equal((await short.prune()).deleted, 0);
        await assert.rejects(short.status(value), { status: 404 });
        const inbox = new InboxStore(database, parseInboxConfig({ target: config.target, allowedSigners: [sender.address], execution: { mode: 'ipfs' } }));
        pools.push(inbox.pool); await inbox.initialize();
        assert.equal((await inbox.pool.query('SELECT count(*)::int AS count FROM oya_inbox_jobs WHERE target=$1', [config.target])).rows[0].count, 2);
        // A publication checkpoint is unrelated to peer pruning.
        await inbox.pool.query(`INSERT INTO oya_inbox_jobs(target,request_id,payload,payload_hash,expires_at,status,cid)
            VALUES ($1,$2,'{}','fixture',clock_timestamp(),'processing','retained-checkpoint')`, [config.target, randomUUID()]);
        await delay(550);
        assert.equal((await short.prune()).deleted, 1);
        await retained.prune();
        assert.equal((await inbox.pool.query('SELECT cid FROM oya_inbox_jobs WHERE cid IS NOT NULL')).rows[0].cid, 'retained-checkpoint');
    });
    await t.test('queue capacity, conflicts and post-enqueue failure roll back both stores', async () => {
        const isolated = await newStore({ ...config, target: `atomic-${randomUUID()}`, maxMessages: 10 });
        const makeHere = changes => make({ target: isolated.config.target, ...changes });
        const first = await makeHere();
        const enqueue = isolated.inbox.enqueueInTransaction.bind(isolated.inbox);
        isolated.inbox.enqueueInTransaction = async (client, job) => {
            await enqueue(client, job);
            // Real PostgreSQL error after the queue insert must abort the whole transaction.
            await client.query('SELECT 1/0');
        };
        await assert.rejects(isolated.receive(first), /division by zero/);
        for (const table of ['oya_peer_messages', 'oya_inbox_jobs']) {
            assert.equal((await isolated.pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE target=$1`, [isolated.config.target])).rows[0].count, 0);
        }
        await assert.rejects(isolated.status(first), { code: 'peer_not_found' });
        isolated.inbox.enqueueInTransaction = enqueue;
        await isolated.receive(first);
        isolated.inbox.config.maxJobs = 1;
        const second = await makeHere();
        await assert.rejects(isolated.receive(second), { code: 'inbox_capacity' });
        await assert.rejects(isolated.status(second), { code: 'peer_not_found' });
        isolated.inbox.config.maxJobs = 10;
        await isolated.inbox.enqueue(peerJob(second)); // ordinary route won the race
        assert.equal((await isolated.receive(second)).requestId, second.requestId);
        const collision = await makeHere();
        await isolated.inbox.enqueue(peerJob(await makeHere({ requestId: collision.requestId, text: 'other signed job' })));
        await assert.rejects(isolated.receive(collision), { code: 'request_id_conflict' });
        await assert.rejects(isolated.status(collision), { code: 'peer_not_found' });
        assert.equal((await isolated.pool.query('SELECT count(*)::int AS count FROM oya_inbox_jobs WHERE target=$1', [isolated.config.target])).rows[0].count, 3);
    });
    await t.test('CLI prepare→real inbox startup→HTTP→database; restart adopts registry revocation', async () => {
        const target = `cli-${randomUUID()}`;
        const portServer = createServer();
        await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
        const port = portServer.address().port;
        await new Promise(resolve => portServer.close(resolve));
        const origin = `http://127.0.0.1:${port}`;
        const file = name => join(dir, name);
        await writeFile(file('registry.json'), JSON.stringify([{ nodeAddress: sender.address, url: 'https://sender.example/v1/jobs', target: 'sender' }]));
        await writeFile(file('inbox.json'), JSON.stringify({ target, port, allowedSigners: [receiver.address], execution: { mode: 'ipfs' }, databaseTls: false,
            peers: { networkId: config.networkId, nodeAddress: receiver.address, registryFile: 'registry.json' } }));
        await writeFile(file('secrets.json'), JSON.stringify({ workerToken: randomBytes(32).toString('base64url'),
            databaseUrl: `postgres://postgres:${password}@127.0.0.1:${database.port}/postgres` }), { mode: 0o600 });
        await writeFile(file('key'), sender.privateKey, { mode: 0o600 });
        await writeFile(file('text'), 'CLI exact bytes\n');
        const cli = async args => JSON.parse((await execute(process.execPath, [join(runtime, 'src/peers/cli.mjs'), ...args], { timeout: 15000 })).stdout);
        const start = async () => {
            const child = spawn(process.execPath, [join(runtime, 'src/inbox/main.mjs'), file('inbox.json'), file('secrets.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
            children.push(child); let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.resume();
            for (let i = 0; i < 100; i++) {
                if (output.includes('inbox_listening')) return child;
                if (child.exitCode !== null) throw new Error('Inbox startup failed');
                await delay(50);
            }
            throw new Error('Inbox startup timeout');
        };
        const stop = async child => { child.kill('SIGTERM'); await once(child, 'exit'); };
        const prepared = await cli(['prepare', config.networkId, receiver.address, target, file('text'), file('key'), String(Date.now() + 60000), file('envelope')]);
        assert.equal(prepared.status, 'prepared');
        await assert.rejects(cli(['prepare', config.networkId, receiver.address, target, file('text'), file('key'), String(Date.now() + 60000), file('envelope')]));
        const bytes = await readFile(file('envelope'), 'utf8');
        let child = await start();
        const accepted = await cli(['submit', origin, file('envelope')]);
        assert.equal(accepted.scope, 'inbox');
        assert.deepEqual(await cli(['submit', origin, file('envelope')]), accepted);
        const ordinary = await fetch(origin + '/v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(peerJob(JSON.parse(bytes))) });
        assert.equal(ordinary.status, 202, 'registry grants ordinary admission too');
        assert.equal((await ordinary.json()).requestId, accepted.requestId);
        // Real worker startup must independently adopt the installed registry grant.
        let uploaded;
        const ipfs = httpServer(async (request, response) => {
            try {
                const chunks = [];
                for await (const chunk of request) chunks.push(chunk);
                const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers['content-type'] } }).formData();
                uploaded = JSON.parse(await form.get('file').text());
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ Hash: cid }));
            } catch { response.writeHead(500); response.end(); }
        });
        await new Promise(resolve => ipfs.listen(0, '127.0.0.1', resolve));
        const health = createServer();
        await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
        const healthPort = health.address().port;
        await new Promise(resolve => health.close(resolve));
        await writeFile(file('node.json'), JSON.stringify({ mode: 'ipfs', port: healthPort, allowedSigners: [receiver.address],
            ipfsUrl: `http://127.0.0.1:${ipfs.address().port}` }));
        await writeFile(file('node.env'), '');
        await writeFile(file('worker.json'), JSON.stringify({ url: origin, target, pollIntervalMs: 1000,
            peers: { networkId: config.networkId, nodeAddress: receiver.address, registryFile: 'registry.json' } }));
        const worker = spawn(process.execPath, [join(runtime, 'src/inbox/worker.mjs'), file('node.json'), file('node.env'), file('worker.json'), file('secrets.json')],
            { stdio: ['ignore', 'ignore', 'ignore'] });
        children.push(worker);
        try {
            let status;
            for (let i = 0; i < 100; i++) {
                status = (await store.pool.query('SELECT status FROM oya_inbox_jobs WHERE target=$1 AND request_id=$2', [target, accepted.requestId])).rows[0]?.status;
                if (status === 'published' || worker.exitCode !== null) break;
                await delay(50);
            }
            assert.equal(status, 'published');
            assert.deepEqual(uploaded, JSON.parse(bytes).message);
            assert.deepEqual(await cli(['submit', origin, file('envelope')]), accepted);
        } finally {
            if (worker.exitCode === null && worker.signalCode === null) await stop(worker);
            await new Promise(resolve => ipfs.close(resolve));
        }
        await stop(child);
        const lowered = JSON.parse(await readFile(file('inbox.json'), 'utf8'));
        lowered.maxTextBytes = 1;
        await writeFile(file('inbox.json'), JSON.stringify(lowered));
        child = await start();
        assert.deepEqual(await cli(['status', origin, file('envelope')]), accepted);
        await assert.rejects(cli(['submit', origin, file('envelope')]));
        assert.equal(await readFile(file('envelope'), 'utf8'), bytes);
        const rows = await store.pool.query('SELECT envelope FROM oya_peer_messages WHERE target=$1', [target]);
        assert.deepEqual(rows.rows[0].envelope, JSON.parse(bytes));
        const queued = await store.pool.query('SELECT payload FROM oya_inbox_jobs WHERE target=$1', [target]);
        assert.deepEqual(queued.rows.map(row => row.payload), [peerJob(JSON.parse(bytes))]);
        await writeFile(file('registry.json'), '[]');
        assert.deepEqual(await sendPeer(origin, bytes, 'status'), accepted); // snapshot, not a live fetch
        await stop(child); child = await start();
        await assert.rejects(cli(['status', origin, file('envelope')]));
        await assert.rejects(cli(['submit', origin, file('envelope')]));
        await stop(child);
    });
});
