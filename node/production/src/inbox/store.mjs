import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { assertCanonicalCid } from '@oyaprotocol/utils';
import { digest, reject, validateTransaction, validId } from './protocol.mjs';

export function publicJob(row) {
    return { requestId: row.request_id, status: row.status,
        attempts: row.attempts, createdAt: row.created_at, updatedAt: row.updated_at,
        ...(row.cid ? { cid: row.cid } : {}),
        ...(row.transaction_data ? { transactionHash: row.transaction_data.transactionHash } : {}),
        ...(row.result ? { result: row.result } : {}), ...(row.last_error ? { error: row.last_error } : {}) };
}
const workJob = row => ({ ...publicJob(row), job: row.payload, lease: row.lease,
    leaseUntil: row.lease_until, checkpoint: { cid: row.cid, transaction: row.transaction_data } });

export class InboxStore {
    constructor(options, config) {
        this.pool = new Pool(options);
        // Idle connection errors must not dump connection details or crash the process.
        this.pool.on('error', () => {});
        this.config = config;
    }
    async initialize() {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(1869242721)');
            await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
            await client.query('INSERT INTO oya_inbox_targets(target,execution) VALUES ($1,$2) ON CONFLICT DO NOTHING',
                [this.config.target, this.config.execution]);
            const { rows: [row] } = await client.query('SELECT * FROM oya_inbox_targets WHERE target=$1', [this.config.target]);
            if (row.schema_version !== 1 || digest(row.execution) !== digest(this.config.execution)) throw new Error('Inbox execution identity changed. Use a new target.');
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async locked(action) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL synchronous_commit = on');
            await client.query('SELECT target FROM oya_inbox_targets WHERE target=$1 FOR UPDATE', [this.config.target]);
            const result = await action(client);
            await client.query('COMMIT');
            return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async enqueue(job) {
        return this.locked(async client => {
            const { rows: [existing] } = await client.query('SELECT * FROM oya_inbox_jobs WHERE target=$1 AND request_id=$2', [this.config.target, job.requestId]);
            if (existing) {
                if (existing.payload_hash !== digest(job)) reject(409, 'request_id_conflict');
                return publicJob(existing);
            }
            if (job.expiresAt <= Date.now()) reject(400, 'invalid_job_expiry');
            const { rows: [count] } = await client.query('SELECT count(*)::int AS count FROM oya_inbox_jobs WHERE target=$1', [this.config.target]);
            if (count.count >= this.config.maxJobs) reject(429, 'inbox_capacity');
            const { rows: [row] } = await client.query(`INSERT INTO oya_inbox_jobs(target,request_id,payload,payload_hash,expires_at)
                VALUES ($1,$2,$3,$4,$5) RETURNING *`, [this.config.target, job.requestId, job, digest(job), new Date(job.expiresAt)]);
            return publicJob(row);
        });
    }
    async status(job) {
        const { rows: [row] } = await this.pool.query('SELECT * FROM oya_inbox_jobs WHERE target=$1 AND request_id=$2', [this.config.target, job.requestId]);
        if (!row || row.payload_hash !== digest(job)) reject(404, 'job_not_found');
        return publicJob(row);
    }
    async claim(identity) {
        if (digest(identity) !== digest(this.config.execution)) reject(409, 'execution_identity_mismatch');
        return this.locked(async client => {
            await client.query(`UPDATE oya_inbox_jobs SET status='expired', updated_at=clock_timestamp()
                WHERE target=$1 AND status='queued' AND expires_at<=clock_timestamp()`, [this.config.target]);
            const { rows: [row] } = await client.query(`SELECT *, lease_until>clock_timestamp() AS leased FROM oya_inbox_jobs
                WHERE target=$1 AND status IN ('processing','queued')
                ORDER BY (status='processing') DESC, created_at, request_id LIMIT 1`, [this.config.target]);
            if (!row || row.leased) return null;
            const { rows: [claimed] } = await client.query(`UPDATE oya_inbox_jobs SET status='processing', attempts=attempts+1,
                lease=$3, lease_until=clock_timestamp()+$4*interval '1 millisecond', updated_at=clock_timestamp()
                WHERE target=$1 AND request_id=$2 RETURNING *`, [this.config.target, row.request_id, randomUUID(), this.config.leaseMs]);
            return workJob(claimed);
        });
    }
    async mutate(requestId, lease, action) {
        if (!validId(requestId) || !validId(lease)) reject(400, 'invalid_lease');
        return this.locked(async client => {
            const { rows: [row] } = await client.query(`SELECT * FROM oya_inbox_jobs WHERE target=$1 AND request_id=$2
                AND status='processing' AND lease=$3 AND lease_until>clock_timestamp()`, [this.config.target, requestId, lease]);
            if (!row) reject(409, 'lease_lost');
            return action(client, row);
        });
    }
    async renew(id, lease) {
        return this.mutate(id, lease, async client => {
            await client.query(`UPDATE oya_inbox_jobs SET lease_until=clock_timestamp()+$3*interval '1 millisecond'
                WHERE target=$1 AND request_id=$2`, [this.config.target, id, this.config.leaseMs]);
            return { renewed: true };
        });
    }
    async checkpoint(id, lease, checkpoint) {
        return this.mutate(id, lease, async (client, row) => {
            if (checkpoint?.cid) {
                try { assertCanonicalCid(checkpoint.cid, 'cid'); } catch { reject(400, 'invalid_cid'); }
                if (row.cid && row.cid !== checkpoint.cid) reject(409, 'checkpoint_conflict');
                if (Object.keys(checkpoint).join() !== 'cid') reject(400, 'invalid_checkpoint');
                await client.query('UPDATE oya_inbox_jobs SET cid=$3 WHERE target=$1 AND request_id=$2', [this.config.target, id, checkpoint.cid]);
            } else if (checkpoint?.transaction && row.cid) {
                const transaction = checkpoint.transaction;
                if (Object.keys(checkpoint).join() !== 'transaction' ||
                    Object.keys(transaction).sort().join() !== 'rawTransaction,transactionHash') reject(400, 'invalid_checkpoint');
                validateTransaction(transaction, row.cid, this.config.execution);
                if (row.transaction_data && digest(row.transaction_data) !== digest(transaction)) reject(409, 'checkpoint_conflict');
                await client.query('UPDATE oya_inbox_jobs SET transaction_data=$3 WHERE target=$1 AND request_id=$2', [this.config.target, id, transaction]);
            } else reject(400, 'invalid_checkpoint');
            return { saved: true };
        });
    }
    async complete(id, lease, result) {
        return this.mutate(id, lease, async (client, row) => {
            if (!row.cid || result?.cid !== row.cid ||
                !(this.config.execution.mode === 'ipfs' ? result.status === 'published' :
                    (['logged', 'failed'].includes(result.status) && row.transaction_data &&
                        result.transactionHash === row.transaction_data.transactionHash &&
                        (result.status !== 'failed' || result.error === 'transaction_reverted')))) reject(400, 'invalid_result');
            // Persist only the public result fields, never arbitrary worker input.
            const clean = { status: result.status, cid: row.cid, ...(row.transaction_data ? {
                transactionHash: row.transaction_data.transactionHash,
                ...(result.status === 'failed' ? { error: 'transaction_reverted' } : {}),
            } : {}) };
            await client.query(`UPDATE oya_inbox_jobs SET status=$3,result=$4,last_error=NULL,lease=NULL,lease_until=NULL,
                updated_at=clock_timestamp() WHERE target=$1 AND request_id=$2`, [this.config.target, id, clean.status, clean]);
            return clean;
        });
    }
    async retry(id, lease) {
        return this.mutate(id, lease, async (client, row) => {
            const error = row.transaction_data ? 'awaiting_reconciliation' : 'execution_retry';
            const failed = !row.transaction_data && row.attempts >= 10;
            await client.query(`UPDATE oya_inbox_jobs SET status=$3,last_error=$4,lease=NULL,
                lease_until=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp()
                WHERE target=$1 AND request_id=$2`, [this.config.target, id, failed ? 'failed' : 'processing', error]);
            return { status: failed ? 'failed' : 'processing', error };
        });
    }
    async prune() {
        return this.locked(async client => {
            const result = await client.query(`DELETE FROM oya_inbox_jobs WHERE target=$1
                AND status IN ('published','logged','failed','expired') AND expires_at<clock_timestamp()-interval '7 days'`, [this.config.target]);
            return { deleted: result.rowCount };
        });
    }
    async close() { await this.pool.end(); }
}
