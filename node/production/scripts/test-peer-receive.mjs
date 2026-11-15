import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
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
import { signJob } from '../src/inbox/protocol.mjs';
import { createInboxClient } from '../src/inbox/http.mjs';
import { waitForPostgres } from './postgres-readiness.mjs';
import { cid } from '../test/runtime-fixture.mjs';

const execute = promisify(execFile);
const runtime = fileURLToPath(new URL('../', import.meta.url));
const postgresImage = 'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';

test('registry publication with real PostgreSQL, process restart and ordinary CLI', { timeout: 300000 }, async t => {
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
    const config = parseInboxConfig({ target: `registry-${randomUUID()}`, allowedSigners: [sender.address],
        execution: { mode: 'ipfs' }, maxJobs: 2 });
    const make = (overrides = {}) => signJob(sender, overrides.target ?? config.target,
        overrides.text ?? 'ordinary registry publication', overrides);
    const newStore = async (settings = config) => {
        const store = new InboxStore(database, settings);
        pools.push(store.pool); await store.initialize(); return store;
    };
    let store = await newStore();
    const original = await make();
    let accepted;
    await t.test('concurrent retries create one ordinary row; conflicting signed content fails', async () => {
        const results = await Promise.all(Array.from({ length: 8 }, () => store.enqueue(original)));
        accepted = results[0];
        for (const result of results) assert.deepEqual(result, accepted);
        const changed = await make({ requestId: original.requestId, text: 'changed' });
        await assert.rejects(store.enqueue(changed), { code: 'request_id_conflict' });
        await assert.rejects(store.status(changed), { status: 404 });
        const jobs = await store.pool.query('SELECT payload FROM oya_inbox_jobs WHERE target=$1', [config.target]);
        assert.deepEqual(jobs.rows.map(row => row.payload), [original]);
        const tables = await store.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'oya_peer_%'");
        assert.deepEqual(tables.rows, [], 'no second receipt store exists');
    });
    await t.test('independent pools serialize ordinary capacity and retain accepted work', async () => {
        const other = await newStore();
        const values = await Promise.all(Array.from({ length: 8 }, () => make()));
        const results = await Promise.allSettled(values.map((value, i) => (i % 2 ? store : other).enqueue(value)));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'inbox_capacity'));
        assert.deepEqual(await other.enqueue(original), accepted);
    });
    await t.test('lost acknowledgement survives database restart with one job and normal execution identity', async () => {
        const server = httpServer(async (request, response) => {
            request.resume();
            try { await store.enqueue(original); response.destroy(); }
            catch { response.writeHead(503); response.end(); }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            await assert.rejects(createInboxClient(`http://127.0.0.1:${server.address().port}`)('/v1/jobs', original));
        } finally { await new Promise(resolve => server.close(resolve)); }
        for (const pool of pools) if (!pool.ended) await pool.end();
        await docker(['restart', name]); await ready();
        store = await newStore();
        assert.deepEqual(await store.status(original), accepted);
        assert.deepEqual(await store.enqueue(original), accepted);
        await assert.rejects(newStore({ ...config, execution: { mode: 'ledger' } }), /identity changed/);
    });
    await t.test('database failure after insert rolls back ordinary admission', async () => {
        const isolated = await newStore({ ...config, target: `rollback-${randomUUID()}` });
        const value = await make({ target: isolated.config.target });
        const locked = isolated.locked.bind(isolated);
        isolated.locked = action => locked(async client => {
            await action(client);
            await client.query('SELECT 1/0');
        });
        await assert.rejects(isolated.enqueue(value), /division by zero/);
        assert.equal((await isolated.pool.query('SELECT count(*)::int AS count FROM oya_inbox_jobs WHERE target=$1', [isolated.config.target])).rows[0].count, 0);
        await assert.rejects(isolated.status(value), { status: 404 });
        isolated.locked = locked;
        assert.equal((await isolated.enqueue(value)).status, 'queued');
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
            peers: { registryFile: 'registry.json' } }));
        await writeFile(file('secrets.json'), JSON.stringify({ workerToken: randomBytes(32).toString('base64url'),
            databaseUrl: `postgres://postgres:${password}@127.0.0.1:${database.port}/postgres` }), { mode: 0o600 });
        await writeFile(file('key'), sender.privateKey, { mode: 0o600 });
        await writeFile(file('text'), 'CLI exact bytes\n');
        const cli = async args => JSON.parse((await execute(process.execPath, [join(runtime, 'src/inbox/client.mjs'), ...args], { timeout: 15000 })).stdout);
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
        const prepared = await cli(['prepare', file('key'), target, file('text'), file('envelope')]);
        assert.ok(prepared.requestId);
        await assert.rejects(cli(['prepare', file('key'), target, file('text'), file('envelope')]));
        const bytes = await readFile(file('envelope'), 'utf8');
        let child = await start();
        const accepted = await cli(['submit', origin, file('envelope')]);
        assert.equal(accepted.status, 'queued');
        assert.equal(JSON.parse(bytes).version, 1);
        assert.equal((await stat(file('envelope'))).mode & 0o777, 0o600);
        assert.deepEqual(await cli(['submit', origin, file('envelope')]), accepted);
        const ordinary = await fetch(origin + '/v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: bytes });
        assert.equal(ordinary.status, 202, 'registry grants ordinary admission');
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
            peers: { registryFile: 'registry.json' } }));
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
            const published = await cli(['status', origin, file('envelope')]);
            assert.equal(published.status, 'published');
            assert.equal(published.cid, cid);
            assert.equal((await cli(['submit', origin, file('envelope')])).status, 'published');
        } finally {
            if (worker.exitCode === null && worker.signalCode === null) await stop(worker);
            await new Promise(resolve => ipfs.close(resolve));
        }
        await stop(child);
        const lowered = JSON.parse(await readFile(file('inbox.json'), 'utf8'));
        lowered.maxTextBytes = 1;
        await writeFile(file('inbox.json'), JSON.stringify(lowered));
        child = await start();
        assert.equal((await cli(['status', origin, file('envelope')])).status, 'published');
        await assert.rejects(cli(['submit', origin, file('envelope')]));
        assert.equal(await readFile(file('envelope'), 'utf8'), bytes);
        const queued = await store.pool.query('SELECT payload FROM oya_inbox_jobs WHERE target=$1', [target]);
        assert.deepEqual(queued.rows.map(row => row.payload), [JSON.parse(bytes)]);
        await writeFile(file('registry.json'), '[]');
        assert.equal((await cli(['status', origin, file('envelope')])).status, 'published'); // snapshot, not a live fetch
        await stop(child); child = await start();
        await assert.rejects(cli(['status', origin, file('envelope')]));
        await assert.rejects(cli(['submit', origin, file('envelope')]));
        await stop(child);
    });
});
