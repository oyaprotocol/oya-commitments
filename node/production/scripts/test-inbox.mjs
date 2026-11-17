import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { Wallet, keccak256 } from 'ethers';
import { encodeLedgerCall } from '@oyaprotocol/ethereum';
import { InboxStore } from '../src/inbox/store.mjs';
import { validateInspection } from '../src/inbox/inspection.mjs';
import { createInboxServer, createInboxClient } from '../src/inbox/http.mjs';
import { parseInboxConfig } from '../src/inbox/config.mjs';
import { signJob, executionIdentity } from '../src/inbox/protocol.mjs';
import { runOne } from '../src/inbox/worker.mjs';
import { fixture, cid } from '../test/runtime-fixture.mjs';
import { waitForPostgres } from './postgres-readiness.mjs';

const execute = promisify(execFile);
const postgresImage = 'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';

test('PostgreSQL inbox persists offline work and fences competing workers and transaction retries', { timeout: 300000 }, async t => {
    const name = `oya-inbox-test-${randomUUID()}`;
    const password = randomBytes(32).toString('hex');
    const docker = async args => (await execute('docker', args, { encoding: 'utf8', timeout: 180000,
        env: { ...process.env, POSTGRES_PASSWORD: password }, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
    const stores = [];
    const servers = [];
    t.after(async () => {
        for (const server of servers) await new Promise(resolve => server.close(resolve));
        for (const store of stores) if (!store.pool.ended) await store.close();
        await docker(['rm', '-f', '-v', name]).catch(() => {});
    });
    await docker(['run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD', '-p', '127.0.0.1::5432', postgresImage]);
    const port = Number((await docker(['port', name, '5432'])).split(':').at(-1));
    const database = { host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', max: 5, connectionTimeoutMillis: 1000 };
    const waitForDatabase = async () => {
        const pool = new Pool({ ...database, max: 1, statement_timeout: 1000, query_timeout: 1000 });
        pool.on('error', () => {});
        try { await waitForPostgres(pool, { signal: t.signal }); }
        finally { await pool.end(); }
    };
    // docker run returns before PostgreSQL is ready. Linux runners can reset TCP
    // connections during that interval; wait once before starting any subtests.
    await waitForDatabase();
    const agent = Wallet.createRandom();
    const newStore = async (overrides = {}) => {
        const config = parseInboxConfig({ target: `test-${randomUUID()}`, allowedSigners: [agent.address],
            execution: { mode: 'ipfs' }, leaseMs: 3000, ...overrides });
        const store = new InboxStore(database, config);
        stores.push(store);
        // Readiness is separate from schema setup: initialization errors must fail immediately.
        await store.initialize();
        return store;
    };
    const serve = async store => {
        const workerToken = randomBytes(32).toString('base64url');
        const server = createInboxServer({ config: store.config, workerToken, store });
        servers.push(server);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}`;
        return { server, url, workerToken, api: createInboxClient(url, workerToken), publicApi: createInboxClient(url) };
    };
    const expireLease = store => store.pool.query(`UPDATE oya_inbox_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE target=$1`, [store.config.target]);

    await t.test('inspection snapshots are target-scoped, bounded and do not advance expired or leased work', async () => {
        const store = await newStore({ maxJobs: 6 });
        const service = await serve(store);
        const inspect = async () => validateInspection(await service.api('/v1/worker/inspect', { target: store.config.target }), store.config.target);
        const empty = await inspect();
        assert.equal(empty.head, null);
        assert.deepEqual(empty.capacity, { maxJobs: 6, retainedJobs: 0, availableJobs: 6 });
        const other = await newStore();
        await other.enqueue(await signJob(agent, other.config.target, 'other target'));
        const jobs = [];
        for (const status of ['queued', 'queued', 'published', 'logged', 'failed', 'expired']) {
            const job = await signJob(agent, store.config.target, status);
            jobs.push(job);
            await store.enqueue(job);
            if (status !== 'queued') await store.pool.query('UPDATE oya_inbox_jobs SET status=$3 WHERE target=$1 AND request_id=$2',
                [store.config.target, job.requestId, status]);
        }
        await store.pool.query(`UPDATE oya_inbox_jobs SET expires_at=clock_timestamp()-interval '1 second'
            WHERE target=$1 AND request_id=$2`, [store.config.target, jobs[0].requestId]);
        const rows = async () => (await store.pool.query('SELECT * FROM oya_inbox_jobs WHERE target=$1 ORDER BY request_id', [store.config.target])).rows;
        const before = await rows();
        const full = await inspect();
        assert.deepEqual(await rows(), before, 'inspection must not expire, prune or otherwise mutate rows');
        assert.deepEqual(full.counts, { queued: 2, processing: 0, published: 1, logged: 1, failed: 1, expired: 1 });
        assert.deepEqual(full.capacity, { maxJobs: 6, retainedJobs: 6, availableJobs: 0 });
        assert.equal(full.queued.ready, 1);
        assert.equal(full.queued.expiredPendingSweep, 1);
        assert.equal(full.head.requestId, jobs[1].requestId);
        assert.equal(full.head.leaseState, 'available');
        assert.equal(full.head.checkpoint, 'none');
        const directory = await mkdtemp(join(tmpdir(), 'oya-inspect-postgres-'));
        try {
            const tokenFile = join(directory, 'token');
            await writeFile(tokenFile, service.workerToken, { mode: 0o600 });
            const output = await execute(process.execPath, [new URL('../src/inbox/client.mjs', import.meta.url).pathname,
                'inspect', service.url, store.config.target, tokenFile], { timeout: 15000 });
            assert.equal(output.stderr, '');
            const cli = validateInspection(JSON.parse(output.stdout), store.config.target);
            assert.deepEqual(cli.counts, full.counts);
            assert.deepEqual(cli.head, full.head);
            assert.deepEqual(await rows(), before);
        } finally { await rm(directory, { recursive: true, force: true }); }
        assert.equal(JSON.stringify(full).includes('payload'), false);
        assert.equal(JSON.stringify(full).includes('signature'), false);
        await assert.rejects(service.publicApi('/v1/worker/inspect', { target: store.config.target }), { status: 401 });
        await assert.rejects(service.api('/v1/worker/inspect', { target: other.config.target }), { status: 409 });
        const work = await store.claim({ mode: 'ipfs' });
        const active = await inspect();
        assert.equal(active.head.requestId, work.requestId);
        assert.equal(active.head.leaseState, 'active');
        assert.equal(active.counts.expired, 2);
        assert.equal(active.queued.expiredPendingSweep, 0);
        await store.checkpoint(work.requestId, work.lease, { cid });
        assert.equal((await inspect()).head.checkpoint, 'cid');
        await store.retry(work.requestId, work.lease);
        assert.equal((await inspect()).head.leaseState, 'backoff');
        await expireLease(store);
        const retry = await inspect();
        assert.equal(retry.head.leaseState, 'available');
        assert.equal(retry.head.checkpoint, 'cid');
        assert.equal(retry.head.attempts, 1);
        const recovered = await store.claim({ mode: 'ipfs' });
        await store.complete(recovered.requestId, recovered.lease, { status: 'published', cid });
        const done = await inspect();
        assert.equal(done.head, null);
        assert.equal(done.counts.published, 2);
        assert.equal(done.capacity.availableJobs, 0, 'terminal replay records still occupy capacity');
    });

    await t.test('inspection uses claim ordering and keeps expired processing work ahead of queued work', async () => {
        const store = await newStore();
        const ids = ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'];
        for (const requestId of ids) await store.enqueue(await signJob(agent, store.config.target, 'ordered', { requestId }));
        await store.pool.query(`UPDATE oya_inbox_jobs SET created_at='2026-01-01T00:00:00Z' WHERE target=$1`, [store.config.target]);
        assert.equal((await store.inspect()).head.requestId, ids[1]);
        const work = await store.claim({ mode: 'ipfs' });
        assert.equal(work.requestId, ids[1]);
        await store.pool.query(`UPDATE oya_inbox_jobs SET expires_at=clock_timestamp()-interval '1 second',
            created_at=clock_timestamp(), lease_until=clock_timestamp()-interval '1 second'
            WHERE target=$1 AND request_id=$2`, [store.config.target, work.requestId]);
        store.config.maxJobs = 1;
        const snapshot = validateInspection(await store.inspect(), store.config.target);
        assert.deepEqual(snapshot.capacity, { maxJobs: 1, retainedJobs: 2, availableJobs: 0 });
        assert.equal(snapshot.head.requestId, work.requestId);
        assert.equal(snapshot.head.leaseState, 'available');
        assert.equal(snapshot.queued.ready, 1);
        assert.equal((await store.claim({ mode: 'ipfs' })).requestId, snapshot.head.requestId);
    });

    await t.test('inspection does not acquire writer locks and recovers after its SQL deadline', async () => {
        const store = await newStore();
        await store.enqueue(await signJob(agent, store.config.target, 'inspect through writer lock'));
        const writer = await store.pool.connect();
        try {
            await writer.query('BEGIN');
            await writer.query('SELECT target FROM oya_inbox_targets WHERE target=$1 FOR UPDATE', [store.config.target]);
            assert.equal((await store.inspect()).counts.queued, 1);
            // An exclusive table lock simulates a long schema operation. The inspection's
            // statement deadline must roll back, return its pool client and permit a retry.
            await writer.query('LOCK TABLE oya_inbox_jobs IN ACCESS EXCLUSIVE MODE');
            await assert.rejects(store.inspect(), { code: '57014' });
        } finally { await writer.query('ROLLBACK'); writer.release(); }
        assert.equal((await store.inspect()).counts.queued, 1);
        const client = await store.pool.connect();
        try {
            assert.notEqual((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, '2s');
            assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off');
        } finally { client.release(); }
    });

    await t.test('offline submission, idempotency, authorization, capacity, and service/database restart', async () => {
        let store = await newStore({ maxJobs: 2 });
        const service = await serve(store);
        const job = await signJob(agent, store.config.target, 'queued while offline');
        const accepted = await service.publicApi('/v1/jobs', job);
        assert.equal(accepted.status, 'queued');
        assert.equal((await service.publicApi('/v1/jobs', JSON.parse(JSON.stringify(job)))).requestId, accepted.requestId);
        const changed = await signJob(agent, store.config.target, 'new content', { requestId: job.requestId });
        await assert.rejects(service.publicApi('/v1/jobs', changed), { status: 409 });
        await assert.rejects(service.publicApi('/v1/status', changed), { status: 404 });
        await assert.rejects(service.publicApi('/v1/jobs', { ...job, requestId: randomUUID() }), { status: 403 });
        await assert.rejects(service.publicApi('/v1/worker/claim', { execution: { mode: 'ipfs' } }), { status: 401 });
        await service.publicApi('/v1/jobs', await signJob(agent, store.config.target, 'second'));
        await assert.rejects(service.publicApi('/v1/jobs', await signJob(agent, store.config.target, 'capacity')), { status: 429 });
        await new Promise(resolve => service.server.close(resolve));
        await store.close();
        await docker(['restart', name]);
        // Docker Desktop may allocate a new published ephemeral port on restart.
        database.port = Number((await docker(['port', name, '5432'])).split(':').at(-1));
        await waitForDatabase();
        store = await newStore({ target: store.config.target, maxJobs: 2 });
        const restarted = await serve(store);
        assert.equal((await restarted.publicApi('/v1/status', job)).status, 'queued');
        const afterRestart = validateInspection(await store.inspect(), store.config.target);
        assert.equal(afterRestart.counts.queued, 2);
        assert.equal(afterRestart.head.requestId, job.requestId);
        await assert.rejects(restarted.api('/v1/worker/claim', { target: 'wrong-target', execution: { mode: 'ipfs' } }), { status: 409 });
        const claim = await restarted.api('/v1/worker/claim', { target: store.config.target, execution: { mode: 'ipfs' } });
        await restarted.api('/v1/worker/checkpoint', { requestId: claim.work.requestId, lease: claim.work.lease, checkpoint: { cid } });
        await restarted.api('/v1/worker/complete', { requestId: claim.work.requestId, lease: claim.work.lease, result: { status: 'published', cid } });
        assert.equal((await restarted.publicApi('/v1/status', job)).status, 'published');
        const row = await restarted.publicApi('/v1/status', job);
        assert.equal('job' in row || 'lease' in row || 'rawTransaction' in row, false);
    });

    await t.test('concurrent claims serialize, expired claims retain checkpoints, and stale workers cannot mutate', async () => {
        const store = await newStore();
        const job = await signJob(agent, store.config.target, 'first');
        await store.enqueue(job);
        await store.enqueue(await signJob(agent, store.config.target, 'second'));
        const claims = await Promise.all(Array.from({ length: 6 }, () => store.claim({ mode: 'ipfs' })));
        assert.equal(claims.filter(Boolean).length, 1);
        const first = claims.find(Boolean);
        await store.checkpoint(first.requestId, first.lease, { cid });
        await assert.rejects(store.claim({ mode: 'ledger' }), { code: 'execution_identity_mismatch' });
        await expireLease(store);
        const second = await store.claim({ mode: 'ipfs' });
        assert.equal(second.requestId, first.requestId);
        assert.notEqual(second.lease, first.lease);
        assert.equal(second.checkpoint.cid, cid);
        await assert.rejects(store.complete(first.requestId, first.lease, { status: 'published', cid }), { code: 'lease_lost' });
        await assert.rejects(store.renew(first.requestId, first.lease), { code: 'lease_lost' });
        await store.complete(second.requestId, second.lease, { status: 'published', cid });
        assert.notEqual((await store.claim({ mode: 'ipfs' })).requestId, first.requestId);
    });

    await t.test('a default job prepared two days ago can still be admitted and claimed', async t => {
        const store = await newStore();
        const service = await serve(store);
        const preparedAt = Date.now() - 2 * 86400_000;
        const clock = t.mock.method(Date, 'now', () => preparedAt);
        const job = await signJob(agent, store.config.target, 'laptop offline for two days');
        clock.mock.restore();
        assert.equal(job.expiresAt, preparedAt + 604800_000);
        assert.equal((await service.publicApi('/v1/jobs', job)).status, 'queued');
        const work = await store.claim({ mode: 'ipfs' });
        assert.deepEqual(work.job, job);
        await store.checkpoint(work.requestId, work.lease, { cid });
        await store.complete(work.requestId, work.lease, { status: 'published', cid });
        assert.equal((await service.publicApi('/v1/status', job)).status, 'published');
        assert.equal((await store.prune()).deleted, 0, 'terminal jobs retain their signed replay protection');
    });

    await t.test('expired signed jobs remain queryable until pruning and cannot be replayed afterward', async t => {
        const store = await newStore();
        const service = await serve(store);
        const past = Date.now() - 14 * 86400_000;
        // Seed as if admitted in the past; the database still uses its real current clock.
        const clock = t.mock.method(Date, 'now', () => past);
        const job = await signJob(agent, store.config.target, 'old signed job');
        await store.enqueue(job);
        clock.mock.restore();
        assert.equal(await store.claim({ mode: 'ipfs' }), null);
        assert.equal((await service.publicApi('/v1/status', job)).status, 'expired');
        await assert.rejects(service.publicApi('/v1/jobs', job), { status: 400 });
        // Test both sides of the retention cutoff without a seven-day wall-clock wait.
        await store.pool.query(`UPDATE oya_inbox_jobs SET expires_at=clock_timestamp()-interval '7 days'+interval '1 minute'
            WHERE target=$1`, [store.config.target]);
        assert.equal((await store.prune()).deleted, 0);
        await store.pool.query(`UPDATE oya_inbox_jobs SET expires_at=clock_timestamp()-interval '7 days'-interval '1 minute'
            WHERE target=$1`, [store.config.target]);
        assert.equal((await store.prune()).deleted, 1);
        await assert.rejects(service.publicApi('/v1/status', job), { status: 404 });
        await assert.rejects(service.publicApi('/v1/jobs', job), { status: 400 });
    });

    await t.test('queued expiry, retry exhaustion, and pruning retain unexpired replay records', async () => {
        const store = await newStore();
        const job = await signJob(agent, store.config.target, 'expire');
        await store.enqueue(job);
        await store.pool.query(`UPDATE oya_inbox_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE target=$1`, [store.config.target]);
        assert.equal(await store.claim({ mode: 'ipfs' }), null);
        assert.equal((await store.status(job)).status, 'expired');
        assert.equal((await store.prune()).deleted, 0);
        await store.pool.query(`UPDATE oya_inbox_jobs SET expires_at=clock_timestamp()-interval '8 days' WHERE target=$1`, [store.config.target]);
        assert.equal((await store.prune()).deleted, 1);
        const retryJob = await signJob(agent, store.config.target, 'retry');
        await store.enqueue(retryJob);
        for (let i = 0; i < 10; i++) {
            const work = await store.claim({ mode: 'ipfs' });
            await store.retry(work.requestId, work.lease);
            await expireLease(store);
        }
        assert.equal((await store.status(retryJob)).status, 'failed');
    });

    await t.test('transaction checkpoints reject replacement, wrong execution, and stale leases', async t => {
        const f = await fixture(t);
        const identity = executionIdentity(f.config, f.signer.address);
        const store = await newStore({ execution: identity, allowedSigners: [f.agent.address] });
        const job = await signJob(f.agent, store.config.target, 'immutable transaction');
        await store.enqueue(job);
        const work = await store.claim(identity);
        await store.checkpoint(work.requestId, work.lease, { cid });
        const transaction = async (nonce, chainId = 31337) => {
            const rawTransaction = await f.wallet.signTransaction({ type: 2, chainId, nonce, to: f.config.ledgerContract,
                data: encodeLedgerCall(cid), value: 0n, gasLimit: 50000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
            return { rawTransaction, transactionHash: keccak256(rawTransaction) };
        };
        const first = await transaction(0);
        await store.checkpoint(work.requestId, work.lease, { transaction: first });
        await store.checkpoint(work.requestId, work.lease, { transaction: first });
        await assert.rejects(store.checkpoint(work.requestId, work.lease, { transaction: await transaction(1) }), { code: 'checkpoint_conflict' });
        await assert.rejects(store.checkpoint(work.requestId, work.lease, { transaction: await transaction(0, 1) }), { code: 'invalid_transaction_checkpoint' });
        await store.pool.query('UPDATE oya_inbox_jobs SET attempts=100 WHERE target=$1', [store.config.target]);
        assert.equal((await store.retry(work.requestId, work.lease)).status, 'processing');
        await expireLease(store);
        const reclaimed = await store.claim(identity);
        await assert.rejects(store.checkpoint(work.requestId, work.lease, { transaction: first }), { code: 'lease_lost' });
        assert.deepEqual(reclaimed.checkpoint.transaction, first);
        const differentConfig = new InboxStore(database, { ...store.config, execution: { mode: 'ipfs' } });
        stores.push(differentConfig);
        await assert.rejects(differentConfig.initialize(), /execution identity changed/);
    });

    await t.test('long-running work renews its lease and stays unavailable to competing claims', async t => {
        const f = await fixture(t);
        const store = await newStore({ allowedSigners: [f.agent.address] });
        const service = await serve(store);
        const job = await signJob(f.agent, store.config.target, 'long IPFS publication');
        await service.publicApi('/v1/jobs', job);
        let renewals = 0;
        const api = async (path, body, signal) => {
            const result = await service.api(path, body, signal);
            if (path.endsWith('/renew')) renewals++;
            return result;
        };
        f.state.onUpload = async () => {
            await delay(3500);
            assert.equal(await store.claim({ mode: 'ipfs' }), null);
        };
        await runOne({ api, config: { ...f.config, mode: 'ipfs', operationTimeoutMs: 10000 }, target: store.config.target,
            allowedSigners: [f.agent.address], fetch: f.transport });
        assert.ok(renewals >= 2);
        assert.equal((await store.status(job)).status, 'published');
    });

    for (const boundary of ['checkpoint_ack', 'broadcast_receipt', 'completion_ack']) {
        await t.test(`${boundary === 'completion_ack' ? 'Ledger completion status' : 'Ledger recovery'} after ${boundary} loss and job expiry keeps one prepared transaction`, async t => {
            const f = await fixture(t, { receiptTimeoutMs: 30 });
            const identity = executionIdentity(f.config, f.signer.address);
            const store = await newStore({ execution: identity, allowedSigners: [f.agent.address] });
            const service = await serve(store);
            const job = await signJob(f.agent, store.config.target, `recovery ${boundary}`);
            await service.publicApi('/v1/jobs', job);
            await service.publicApi('/v1/jobs', await signJob(f.agent, store.config.target, 'later work'));
            let interrupted = false;
            const api = async (path, body, signal) => {
                const result = await service.api(path, body, signal);
                if (!interrupted && ((boundary === 'checkpoint_ack' && body.checkpoint?.transaction) ||
                    (boundary === 'completion_ack' && path.endsWith('/complete')))) {
                    interrupted = true;
                    throw new Error('Simulated lost acknowledgement');
                }
                return result;
            };
            f.state.onReceipt = async () => {
                f.state.receiptMode = f.state.sends && boundary !== 'broadcast_receipt' ? 'mined' : 'pending';
            };
            const options = { api, config: f.config, target: store.config.target, allowedSigners: [f.agent.address],
                signer: f.signer, fetch: f.transport };
            await runOne(options);
            assert.equal(f.state.signs, 1);
            const first = await store.status(job);
            assert.ok(first.transactionHash);
            // Advance host expiry and the database deadline without changing signed bytes.
            t.mock.method(Date, 'now', () => job.expiresAt + 1);
            await store.pool.query(`UPDATE oya_inbox_jobs SET expires_at=clock_timestamp()-interval '1 second'
                WHERE target=$1 AND request_id=$2`, [store.config.target, job.requestId]);
            if (boundary !== 'completion_ack') {
                assert.equal(first.status, 'processing');
                assert.equal(first.error, 'awaiting_reconciliation');
                const snapshot = validateInspection(await store.inspect(), store.config.target);
                assert.equal(snapshot.head.requestId, job.requestId);
                assert.equal(snapshot.head.checkpoint, 'transaction');
                assert.equal(snapshot.head.leaseState, 'backoff');
                assert.equal(snapshot.queued.ready, 1);
                assert.equal('rawTransaction' in snapshot.head, false);
                assert.equal(await store.claim(identity), null, 'unresolved transaction blocks later work');
                assert.equal(f.state.sends, boundary === 'checkpoint_ack' ? 0 : 1);
                await expireLease(store);
                f.state.onReceipt = async () => { f.state.receiptMode = f.state.sends ? 'mined' : 'pending'; };
                await runOne({ ...options, api: service.api });
            }
            const final = await store.status(job);
            assert.equal(final.status, 'logged');
            const snapshot = validateInspection(await store.inspect(), store.config.target);
            assert.equal(snapshot.counts.logged, 1);
            assert.equal(snapshot.head.status, 'queued');
            assert.equal(snapshot.head.checkpoint, 'none');
            assert.equal(final.transactionHash, first.transactionHash);
            assert.equal(f.state.signs, 1);
            assert.equal(f.state.sends, 1);
            assert.equal(f.state.uploads, 1);
            assert.equal((await service.publicApi('/v1/status', job)).status, 'logged');
            await assert.rejects(service.publicApi('/v1/jobs', job), { status: 400 });
        });
    }
});
