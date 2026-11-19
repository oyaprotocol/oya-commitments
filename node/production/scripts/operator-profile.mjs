import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { projectGasPolicy } from '../src/gas-policy.mjs';
import { publicAddress, publicNodeSettings, workerTarget } from '../src/public-settings.mjs';

function pathValue(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('Invalid path.');
    return value;
}

async function readJson(file, privateFile = false) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const info = await handle.stat();
        if (!info.isFile() || (privateFile && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Error('Invalid file.');
        const limit = privateFile ? 16384 : 65536;
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
        }
        if (size > limit) throw new Error('File too large.');
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
    } finally { await handle.close(); }
}

export function healthUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid health URL.');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/healthz') throw new Error('Invalid health URL.');
    return url.href;
}

async function selectProfile(file) {
    const selected = resolve(pathValue(file));
    const directory = dirname(selected);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Invalid profile directory.');
    const profile = await readJson(selected, true);
    const fields = ['version', 'role', 'nodeConfig', 'workerConfig', 'healthUrl', 'nodeAddress'];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || profile.version !== 1 ||
        Object.keys(profile).some(key => !fields.includes(key)) || !['direct', 'worker'].includes(profile.role)) throw new Error('Invalid profile.');
    const url = healthUrl(profile.healthUrl);
    let workerFile;
    if (profile.role === 'worker') workerFile = resolve(directory, pathValue(profile.workerConfig));
    else if (Object.hasOwn(profile, 'workerConfig')) throw new Error('Unexpected worker config.');
    const input = await readJson(resolve(directory, pathValue(profile.nodeConfig)));
    const nodeAddress = input?.mode === 'ipfs' ? null : publicAddress(profile.nodeAddress);
    if (input?.mode === 'ipfs' && Object.hasOwn(profile, 'nodeAddress')) throw new Error('Unexpected node address.');
    return { input, role: profile.role, workerFile, nodeAddress, healthUrl: url };
}

export async function loadProfile(file) {
    const { input, role, workerFile, nodeAddress, healthUrl } = await selectProfile(file);
    const config = publicNodeSettings(input);
    const target = workerFile ? workerTarget(await readJson(workerFile)) : null;
    return Object.freeze({ ...config, role, target, nodeAddress, healthUrl });
}

export async function loadProfileGasPolicy(file) {
    const { input } = await selectProfile(file);
    return projectGasPolicy(input);
}
