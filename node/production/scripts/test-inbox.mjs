import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { Wallet, keccak256 } from 'ethers';
import { encodeLedgerCall } from '@oyaprotocol/ethereum';
import { InboxStore } from '../src/inbox/store.mjs';
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
        return { server, url, api: createInboxClient(url, workerToken), publicApi: createInboxClient(url) };
    };
    const expireLease = store => store.pool.query(`UPDATE oya_inbox_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE target=$1`, [store.config.target]);

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
        await t.test(`Ledger recovery after ${boundary} loss keeps one prepared transaction`, async t => {
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
            if (boundary !== 'completion_ack') {
                assert.equal(first.status, 'processing');
                assert.equal(first.error, 'awaiting_reconciliation');
                assert.equal(await store.claim(identity), null, 'unresolved transaction blocks later work');
                assert.equal(f.state.sends, boundary === 'checkpoint_ack' ? 0 : 1);
                await expireLease(store);
                f.state.onReceipt = async () => { f.state.receiptMode = f.state.sends ? 'mined' : 'pending'; };
                await runOne({ ...options, api: service.api });
            }
            const final = await store.status(job);
            assert.equal(final.status, 'logged');
            assert.equal(final.transactionHash, first.transactionHash);
            assert.equal(f.state.signs, 1);
            assert.equal(f.state.sends, 1);
            assert.equal(f.state.uploads, 1);
            assert.equal((await service.publicApi('/v1/jobs', job)).status, 'logged');
        });
    }
});
