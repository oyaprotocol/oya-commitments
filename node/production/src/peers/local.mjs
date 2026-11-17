import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSecrets } from '../secrets.mjs';
import { parsePeers, readBounded } from './config.mjs';

export const bundledRegistry = fileURLToPath(new URL('../../peers/testnet-directory.json', import.meta.url));

function privateOwner(info) {
    if (typeof process.getuid !== 'function' || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error();
}

async function privateDirectory(path) {
    const info = await lstat(path);
    if (!info.isDirectory()) throw new Error();
    privateOwner(info);
}

async function readNodeSecrets(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1) throw new Error();
        privateOwner(info);
        const buffer = Buffer.alloc(16385);
        let size = 0;
        while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
        }
        if (size > 16384) throw new Error();
        return parseSecrets(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size)));
    } finally { await handle.close(); }
}

/** Select only the installation explicitly selected by the existing operator environment. */
export async function nodeSendSettings(env = process.env) {
    if (typeof env.OYA_LOCAL_DIR !== 'string' || !isAbsolute(env.OYA_LOCAL_DIR)) throw new Error();
    await privateDirectory(resolve(env.OYA_LOCAL_DIR));
    const directory = await realpath(env.OYA_LOCAL_DIR);
    const config = JSON.parse(await readBounded(join(directory, 'node.json'), 1048576));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    const peers = parsePeers(config.peers);
    const secrets = await readNodeSecrets(join(directory, 'node.env'));
    // Never merge ambient keys, agent credentials, or worker tokens into this identity.
    return { directory, key: secrets.OYA_NODE_PRIVATE_KEY,
        registryFile: peers ? resolve(directory, peers.registryFile) : bundledRegistry };
}

/** Sync the directory entry even when recovering from an earlier interrupted creation. */
export async function prepareOutbox(directory) {
    await privateDirectory(directory);
    const outbox = join(directory, 'peer-outbox');
    try { await mkdir(outbox, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await privateDirectory(outbox);
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return outbox;
}
