import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getAddress } from 'ethers';

function address(value) {
    const result = getAddress(value).toLowerCase();
    if (/^0x0{40}$/.test(result)) throw new Error('Zero registry address.');
    return result;
}

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
export function parsePeers(input) {
    if (input === undefined) return undefined;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => key !== 'registryFile') ||
        typeof input.registryFile !== 'string' || !input.registryFile.trim() || input.registryFile.length > 4096) throw new Error('Invalid peers settings.');
    return Object.freeze({ registryFile: input.registryFile });
}
export function publicationSigners(allowedSigners, peers) {
    return [...new Set([...allowedSigners.map(value => value.toLowerCase()), ...(peers?.members ?? [])])];
}
export async function loadPeers(config, configFile) {
    if (!config.peers) return undefined;
    const records = JSON.parse(await readBounded(resolve(dirname(resolve(configFile)), config.peers.registryFile), 1048576));
    if (!Array.isArray(records) || records.length > 1000) throw new Error('Invalid peer registry.');
    const members = records.map(record => {
        if (!record || !['nodeAddress', 'url', 'target'].every(key => typeof record[key] === 'string' && record[key].length > 0 && record[key].length <= 4096)) throw new Error('Invalid peer record.');
        return address(record.nodeAddress);
    });
    return Object.freeze({ ...config.peers, members: Object.freeze([...new Set(members)]) });
}
