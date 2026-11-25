import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverLedger } from './discover-ledger.mjs';
import { checkSavedContent, readEvidenceJson, verifyLedgerSnapshot } from './ledger-evidence.mjs';
import { saveContent } from './verify-ledger.mjs';

async function retain(record, settings, directory, from, to) {
    let local;
    const { report, content } = await verifyLedgerSnapshot(record, settings, {
        returnContent: true,
        async shouldFetchContent(cid, block) {
            if (block < from || block > to) local = 'outside_range';
            else {
                const check = await checkSavedContent(cid, directory);
                if (check.status === 'verified') local = 'already_saved';
                else if (check.status === 'mismatch') local = 'saved_conflict';
                else if (check.status === 'partial') local = check.reason;
            }
            return local === undefined;
        },
    });
    if (local) return local;
    if (report.status !== 'verified') return report.reason;
    try { await saveContent(directory, report.cid, content); }
    catch { return 'save_failed'; }
    return 'saved';
}

export async function retainRange(from, to, settings, directory) {
    const path = resolve(directory);
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o077)) {
        throw new Error('Choose an existing private directory');
    }
    const records = await discoverLedger(from, to, settings);
    if (records.length > 32) throw new Error('Too many records');
    const results = [];
    for (const record of records) {
        results.push({ ...record, outcome: await retain(record, settings, path, from, to) });
    }
    return { from, to, complete: results.every(r => ['saved', 'already_saved'].includes(r.outcome)), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const [from, to, settings, directory, ...extra] = process.argv.slice(2);
        if (!directory || !settings || extra.length || ![from, to].every(v => /^(0|[1-9][0-9]*)$/.test(v))) throw new Error();
        const report = await retainRange(Number(from), Number(to), await readEvidenceJson(settings), directory);
        console.log(JSON.stringify(report, null, 2));
        if (!report.complete) process.exitCode = 2;
    } catch {
        console.error('Retention failed. Pass FROM TO SETTINGS DIRECTORY. Check the private directory, settings and RPC, or narrow the range (1024 blocks, 32 records maximum).');
        process.exitCode = 1;
    }
}
