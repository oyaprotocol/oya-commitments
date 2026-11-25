import { open, link, unlink, mkdir, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkSavedContent, verifyLedgerSnapshot, readEvidenceJson, evidenceExitCode, evidenceInputFailure } from './ledger-evidence.mjs';

async function syncDirectory(path) {
    const directory = await open(path, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
}

// Publish only after verification. The decoded event supplies the canonical CID.
export async function saveContent(directory, cid, content) {
    const path = resolve(directory ?? 'oya-history');
    if (directory === undefined) {
        try { await mkdir(path, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const entry = await lstat(path);
        if (!entry.isDirectory() || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid()) throw new Error();
        await syncDirectory(dirname(path));
    }
    const destination = join(path, cid);
    const temp = join(path, `.ledger-save-${randomUUID()}`);
    const file = await open(temp, 'wx', 0o600);
    try {
        try {
            await file.writeFile(content);
            await file.sync();
        } finally { await file.close(); }
        await link(temp, destination);
    } finally { await unlink(temp); }
    await syncDirectory(path);
}

async function run(args) {
    if (args[0] === '--check-saved') {
        if (args.length !== 2 && !(args.length === 3 && args[2])) throw new Error();
        return checkSavedContent(args[1], args[2] ?? 'oya-history');
    }
    const saving = args[2] === '--save' && (args.length === 3 || (args.length === 4 && args[3] !== ''));
    if (args.length !== 2 && !saving) throw new Error();
    const [record, settings] = await Promise.all(args.slice(0, 2).map(readEvidenceJson));
    const snapshot = await verifyLedgerSnapshot(record, settings, { returnContent: saving });
    const report = snapshot.report;
    if (saving && report.status === 'verified') {
        try { await saveContent(args[3], report.cid, snapshot.content); }
        catch { Object.assign(report, { status: 'unavailable', stage: 'save', reason: 'save_failed' }); }
    }
    return report;
}

export async function main(args = process.argv.slice(2)) {
    let report;
    try { report = await run(args); }
    catch (error) { report = evidenceInputFailure(error); }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = evidenceExitCode(report);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
