import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { token } from './config.mjs';

// One statement gives counts and head the same snapshot and expiry boundary.
const snapshotSql = `WITH jobs AS MATERIALIZED (
    SELECT request_id, status, attempts, created_at, updated_at, expires_at,
        lease_until, lease IS NOT NULL AS has_lease,
        cid IS NOT NULL AS has_cid, transaction_data IS NOT NULL AS has_transaction
    FROM oya_inbox_jobs WHERE target=$1
), counts AS (
    SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status='queued')::int AS queued,
        count(*) FILTER (WHERE status='processing')::int AS processing,
        count(*) FILTER (WHERE status='published')::int AS published,
        count(*) FILTER (WHERE status='logged')::int AS logged,
        count(*) FILTER (WHERE status='failed')::int AS failed,
        count(*) FILTER (WHERE status='expired')::int AS expired,
        count(*) FILTER (WHERE status='queued' AND expires_at>statement_timestamp())::int AS ready,
        count(*) FILTER (WHERE status='queued' AND expires_at<=statement_timestamp())::int AS overdue,
        min(created_at) FILTER (WHERE status='queued' AND expires_at>statement_timestamp()) AS oldest
    FROM jobs
), head AS (
    SELECT * FROM jobs WHERE status='processing' OR (status='queued' AND expires_at>statement_timestamp())
    ORDER BY (status='processing') DESC, created_at, request_id LIMIT 1
)
SELECT json_build_object(
    'target', $1::text, 'observedAt', statement_timestamp(),
    'capacity', json_build_object('maxJobs', $2::int, 'retainedJobs', total,
        'availableJobs', greatest(0, $2::int-total)),
    'counts', json_build_object('queued', queued, 'processing', processing,
        'published', published, 'logged', logged, 'failed', failed, 'expired', expired),
    'queued', json_build_object('ready', ready, 'expiredPendingSweep', overdue, 'oldestCreatedAt', oldest),
    'head', (SELECT json_build_object('requestId', request_id, 'status', status, 'attempts', attempts,
        'createdAt', created_at, 'updatedAt', updated_at, 'expiresAt', expires_at,
        'leaseUntil', lease_until,
        'leaseState', CASE WHEN lease_until>statement_timestamp()
            THEN CASE WHEN has_lease THEN 'active' ELSE 'backoff' END ELSE 'available' END,
        'checkpoint', CASE WHEN has_transaction THEN 'transaction' WHEN has_cid THEN 'cid' ELSE 'none' END)
        FROM head)
) AS snapshot FROM counts`;

export async function inspectQueue(pool, { target, maxJobs }) {
    const client = await pool.connect();
    let broken = false;
    try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '2s'");
        const { rows: [row] } = await client.query(snapshotSql, [target, maxJobs]);
        await client.query('COMMIT');
        return row.snapshot;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { broken = true; }
        throw error;
    } finally { client.release(broken); }
}

export async function readWorkerToken(path) {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        if (!(await file.stat()).isFile()) throw new Error('Worker token requires a regular file.');
        const bytes = Buffer.alloc(131);
        let size = 0;
        while (size < bytes.length) {
            const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
            if (!bytesRead) return token(bytes.subarray(0, size).toString('utf8').trim());
            size += bytesRead;
        }
        throw new Error('Worker token file too large.');
    } finally { await file.close(); }
}

// Reject unexpected server output rather than printing arbitrary remote content.
export function validateInspection(value, target) {
    const fields = (object, names) => object && typeof object === 'object' && !Array.isArray(object) &&
        Object.keys(object).sort().join() === names.split(',').sort().join();
    const count = n => Number.isSafeInteger(n) && n >= 0;
    const date = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s));
    const fail = () => { throw new Error('Invalid inspection response.'); };
    if (!fields(value, 'target,observedAt,capacity,counts,queued,head') || value.target !== target || !date(value.observedAt)) fail();
    const { capacity, counts, queued, head } = value;
    if (!fields(capacity, 'maxJobs,retainedJobs,availableJobs') || !Object.values(capacity).every(count) ||
        capacity.maxJobs < 1 || capacity.maxJobs > 1000000 ||
        capacity.availableJobs !== Math.max(0, capacity.maxJobs - capacity.retainedJobs)) fail();
    if (!fields(counts, 'queued,processing,published,logged,failed,expired') || !Object.values(counts).every(count) ||
        Object.values(counts).reduce((a, b) => a + b, 0) !== capacity.retainedJobs || counts.processing > 1) fail();
    if (!fields(queued, 'ready,expiredPendingSweep,oldestCreatedAt') || !count(queued.ready) || !count(queued.expiredPendingSweep) ||
        queued.ready + queued.expiredPendingSweep !== counts.queued ||
        (queued.ready ? !date(queued.oldestCreatedAt) : queued.oldestCreatedAt !== null)) fail();
    if (head === null) { if (counts.processing || queued.ready) fail(); }
    else if (!fields(head, 'requestId,status,attempts,createdAt,updatedAt,expiresAt,leaseUntil,leaseState,checkpoint') ||
        typeof head.requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(head.requestId) ||
        head.status !== (counts.processing ? 'processing' : 'queued') || (!counts.processing && !queued.ready) ||
        !count(head.attempts) || ![head.createdAt, head.updatedAt, head.expiresAt].every(date) ||
        !(head.leaseUntil === null || date(head.leaseUntil)) ||
        !['active', 'backoff', 'available'].includes(head.leaseState) || !['none', 'cid', 'transaction'].includes(head.checkpoint)) fail();
    return value;
}
