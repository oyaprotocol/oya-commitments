import { readFile } from 'node:fs/promises';
import { createSignedMessageAuthorizer } from '@oyaprotocol/messages';
import { getAddress } from 'ethers';
import { targetName } from './protocol.mjs';

export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
export function positive(value, fallback, max = 2147483647) {
    value ??= fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid positive integer setting.');
    return value;
}
export function token(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{43,128}$/.test(value)) throw new Error('Worker token must contain at least 43 random URL-safe characters.');
    return value;
}
export function inboxUrl(value) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('Use an HTTPS inbox origin (HTTP is allowed only on loopback).');
    }
    return url.origin;
}
export function parseInboxConfig(input) {
    const allowed = ['target', 'host', 'port', 'allowedSigners', 'execution', 'maxJobs', 'maxTextBytes', 'leaseMs', 'databaseTls', 'databaseCaFile'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Unknown inbox configuration field.');
    createSignedMessageAuthorizer(input.allowedSigners);
    if (!input.allowedSigners.length) throw new Error('Inbox requires allowed signers.');
    const execution = input.execution;
    if (execution?.mode === 'ipfs') {
        if (Object.keys(execution).join() !== 'mode') throw new Error('Unexpected IPFS execution setting.');
    } else if (execution?.mode === 'ledger') {
        if (Object.keys(execution).sort().join() !== 'chainId,ledgerContract,mode,nodeAddress') throw new Error('Invalid Ledger execution settings.');
        positive(execution.chainId, undefined, Number.MAX_SAFE_INTEGER);
        for (const key of ['ledgerContract', 'nodeAddress']) {
            execution[key] = getAddress(execution[key]).toLowerCase();
            if (/^0x0{40}$/.test(execution[key])) throw new Error('Zero execution address.');
        }
    } else throw new Error('Set execution mode to ipfs or ledger.');
    if (input.databaseTls !== undefined && typeof input.databaseTls !== 'boolean') throw new Error('databaseTls must be boolean.');
    const leaseMs = positive(input.leaseMs, 60000, 300000);
    if (leaseMs < 3000) throw new Error('leaseMs must be at least 3000.');
    return { target: targetName(input.target), host: input.host ?? '127.0.0.1', port: positive(input.port, 8788, 65535),
        allowedSigners: input.allowedSigners, execution, maxJobs: positive(input.maxJobs, 10000, 1000000),
        maxTextBytes: positive(input.maxTextBytes, 8192, 8192), leaseMs,
        databaseTls: input.databaseTls ?? true, databaseCaFile: input.databaseCaFile };
}
export async function databaseOptions(config, secrets) {
    const url = new URL(secrets.databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) {
        throw new Error('Database URL must be PostgreSQL without query options. Configure TLS separately.');
    }
    return { connectionString: url.href, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000,
        idle_in_transaction_session_timeout: 15000,
        ssl: config.databaseTls ? { rejectUnauthorized: true,
            ...(config.databaseCaFile ? { ca: await readFile(config.databaseCaFile, 'utf8') } : {}) } : false };
}
