import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';

// Deduplicate signature encodings/casing too: one publication per signer + exact text.
export function messageId(message) {
    return createHash('sha256').update(JSON.stringify([message.signer.toLowerCase(), message.text])).digest('hex');
}

async function writeAtomic(directory, filename, value) {
    const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
        await file.writeFile(`${JSON.stringify(value)}\n`);
        await file.sync();
    } finally {
        await file.close();
    }
    await rename(temporary, join(directory, filename));
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
}

export async function openStore(directory, identity) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = join(directory, 'runtime.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
        if (error.code === 'EEXIST') throw new Error('State directory is locked. Check runtime.lock and confirm the previous process has stopped before removing it.');
        throw error;
    }
    const close = async () => { await lock.close(); await unlink(lockPath); };
    try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }));
        await lock.sync();
        let existing;
        try { existing = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8')); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (existing && JSON.stringify(existing) !== JSON.stringify(identity)) {
            throw new Error('State directory belongs to a different chain, Logger, or node account.');
        }
        if (!existing) await writeAtomic(directory, 'identity.json', identity);
        const records = new Map();
        for (const filename of await readdir(directory)) {
            if (!/^[0-9a-f]{64}\.json$/.test(filename)) continue;
            const record = JSON.parse(await readFile(join(directory, filename), 'utf8'));
            if (record.id !== filename.slice(0, -5) || messageId(record.message) !== record.id) {
                throw new Error('Stored message identifier is invalid.');
            }
            records.set(record.id, record);
        }
        return {
            records,
            async save(record) {
                await writeAtomic(directory, `${record.id}.json`, record);
                records.set(record.id, record);
            },
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
