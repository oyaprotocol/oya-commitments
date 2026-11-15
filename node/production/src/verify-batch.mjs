import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEvidenceJson, evidenceExitCode } from './ledger-evidence.mjs';
import { verifyBatchEvidence, batchEvidenceInputFailure } from './batch-evidence.mjs';

export async function main(args = process.argv.slice(2)) {
    let report;
    try {
        if (args.length !== 2) throw new Error();
        const [record, settings] = await Promise.all(args.map(readEvidenceJson));
        report = await verifyBatchEvidence(record, settings);
    } catch (error) { report = batchEvidenceInputFailure(error); }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = evidenceExitCode(report);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
