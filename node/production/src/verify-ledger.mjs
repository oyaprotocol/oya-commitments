import { open, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyLedgerSnapshot, readEvidenceJson, evidenceExitCode, evidenceInputFailure } from './ledger-evidence.mjs';

// Publish a closed file in one no-replace operation, even for competing exports.
async function exportBytes(destination, bytes) {
    const temp = `${dirname(destination)}${sep}.ledger-export-${randomUUID()}`;
    const file = await open(temp, 'wx', 0o600);
    try {
        try {
            await file.writeFile(bytes);
            await file.sync();
        } finally { await file.close(); }
        await link(temp, destination);
    } finally { await unlink(temp); }
    const parent = await open(dirname(destination), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
}

export async function main(args = process.argv.slice(2)) {
    let report;
    try {
        const exporting = args.length === 4 && args[2] === '--export' && args[3] !== '';
        if (args.length !== 2 && !exporting) throw new Error();
        const [record, settings] = await Promise.all(args.slice(0, 2).map(readEvidenceJson));
        const snapshot = await verifyLedgerSnapshot(record, settings, { retainBytes: exporting });
        report = snapshot.report;
        if (exporting && report.status === 'verified') {
            try { await exportBytes(args[3], snapshot.verifiedBytes); }
            catch { Object.assign(report, { status: 'unavailable', stage: 'export', reason: 'export_failed' }); }
        }
    } catch (error) { report = evidenceInputFailure(error); }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = evidenceExitCode(report);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
