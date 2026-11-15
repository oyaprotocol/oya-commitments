import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { address, network } from './protocol.mjs';

export async function readBounded(file, limit) {
    const handle = await open(file, 'r');
    try {
        if (!(await handle.stat()).isFile()) throw new Error('Expected regular file.');
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
        }
        if (size > limit) throw new Error('File exceeds limit.');
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
    } finally { await handle.close(); }
}
const bounded = (value, fallback, max) => {
    value ??= fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid peer bound.');
    return value;
};
export function parsePeers(input) {
    if (input === undefined) return undefined;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['networkId', 'nodeAddress', 'registryFile', 'maxMessages', 'retentionMs'].includes(key)) ||
        typeof input.registryFile !== 'string' || !input.registryFile.trim() || input.registryFile.length > 4096) throw new Error('Invalid peers settings.');
    return Object.freeze({ networkId: network(input.networkId), nodeAddress: address(input.nodeAddress), registryFile: input.registryFile,
        maxMessages: bounded(input.maxMessages, 1000, 100000), retentionMs: bounded(input.retentionMs, 7 * 86400_000, 30 * 86400_000) });
}
export function publicationSigners(allowedSigners, peers) {
    return [...new Set([...allowedSigners.map(value => value.toLowerCase()), ...(peers?.members ?? []).filter(member => member !== peers.nodeAddress)])];
}
export async function loadPeers(config, configFile) {
    if (!config.peers) return undefined;
    const records = JSON.parse(await readBounded(resolve(dirname(resolve(configFile)), config.peers.registryFile), 1048576));
    if (!Array.isArray(records) || records.length > 1000) throw new Error('Invalid peer registry.');
    const members = records.map(record => {
        if (!record || !['nodeAddress', 'url', 'target'].every(key => typeof record[key] === 'string' && record[key].length > 0 && record[key].length <= 4096)) throw new Error('Invalid peer record.');
        return address(record.nodeAddress);
    });
    return Object.freeze({ ...config.peers, target: config.target, maxTextBytes: config.maxTextBytes, members: Object.freeze([...new Set(members)]) });
}
