import { readFile } from 'node:fs/promises';

const fields = new Set(['OYA_NODE_PRIVATE_KEY', 'OYA_RPC_AUTHORIZATION', 'OYA_IPFS_AUTHORIZATION']);

export function parseSecrets(text) {
    try {
        const secrets = Object.create(null);
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim() || line.trimStart().startsWith('#')) continue;
            const entry = /^([A-Z_]+)=([^\r\n\0]*)$/.exec(line);
            if (!entry || !fields.has(entry[1]) || Object.hasOwn(secrets, entry[1])) throw new Error();
            // Values are literal: no shell expansion, quote removal, or inline comments.
            secrets[entry[1]] = entry[2];
        }
        return Object.freeze(secrets);
    } catch {
        throw new Error('Cannot load node secrets. Check file access and literal KEY=value entries.');
    }
}

export async function loadSecrets(path) {
    try { return parseSecrets(await readFile(path, 'utf8')); }
    catch { throw new Error('Cannot load node secrets. Check file access and literal KEY=value entries.'); }
}
