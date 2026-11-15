import { readFile } from 'node:fs/promises';
import { digest, reject } from '../inbox/protocol.mjs';
import { validatePeer, peerDigest, receiptFor } from './protocol.mjs';

export class PeerStore {
    constructor(pool, config) {
        this.pool = pool;
        this.config = config;
        this.identity = { version: 1, networkId: config.networkId, receiver: config.nodeAddress, target: config.target };
    }
    async transaction(action) {
        const client = await this.pool.connect();
        let broken = false;
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL synchronous_commit = on');
            const result = await action(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            // A failed COMMIT is ambiguous; propagate it and let signed status recover.
            try { await client.query('ROLLBACK'); } catch { broken = true; }
            throw error;
        } finally { client.release(broken); }
    }
    async initialize() {
        await this.transaction(async client => {
            await client.query('SELECT pg_advisory_xact_lock(1869242722)');
            await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
            await client.query('INSERT INTO oya_peer_targets(target,identity) VALUES ($1,$2) ON CONFLICT DO NOTHING', [this.config.target, this.identity]);
            await this.checkIdentity(client);
        });
    }
    async checkIdentity(client) {
        const { rows: [row] } = await client.query('SELECT identity FROM oya_peer_targets WHERE target=$1 FOR UPDATE', [this.config.target]);
        if (!row || digest(row.identity) !== digest(this.identity)) throw new Error('Peer identity changed. Use a new target.');
    }
    async locked(action) {
        return this.transaction(async client => { await this.checkIdentity(client); return action(client); });
    }
    async receive(input) {
        const envelope = validatePeer(input, this.config);
        return this.locked(async client => {
            const now = Date.now();
            validatePeer(envelope, this.config, { now });
            const { rows: [existing] } = await client.query('SELECT digest,receipt,retained_until FROM oya_peer_messages WHERE target=$1 AND request_id=$2', [this.config.target, envelope.requestId]);
            if (existing && Number(existing.retained_until) > now) {
                if (existing.digest !== peerDigest(envelope)) reject(409, 'peer_id_conflict');
                return existing.receipt;
            }
            await this.pruneRows(client, now);
            const { rows: [count] } = await client.query('SELECT count(*)::int AS count FROM oya_peer_messages WHERE target=$1', [this.config.target]);
            if (count.count >= this.config.maxMessages) reject(429, 'peer_capacity');
            const retainedUntil = Math.max(envelope.expiresAt, now + this.config.retentionMs);
            const receipt = receiptFor(envelope, now, retainedUntil);
            await client.query(`INSERT INTO oya_peer_messages(target,request_id,envelope,digest,receipt,retained_until)
                VALUES ($1,$2,$3,$4,$5,$6)`, [this.config.target, envelope.requestId, envelope, peerDigest(envelope), receipt, retainedUntil]);
            return receipt;
        });
    }
    async status(input) {
        const envelope = validatePeer(input, this.config, { checkExpiry: false });
        return this.locked(async client => {
            const { rows: [row] } = await client.query('SELECT digest,receipt FROM oya_peer_messages WHERE target=$1 AND request_id=$2 AND retained_until>$3',
                [this.config.target, envelope.requestId, Date.now()]);
            if (!row || row.digest !== peerDigest(envelope)) reject(404, 'peer_not_found');
            return row.receipt;
        });
    }
    async pruneRows(client, now) {
        const result = await client.query('DELETE FROM oya_peer_messages WHERE target=$1 AND retained_until<=$2', [this.config.target, now]);
        return { deleted: result.rowCount };
    }
    async prune() { return this.locked(client => this.pruneRows(client, Date.now())); }
}
