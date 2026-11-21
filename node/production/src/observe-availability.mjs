import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEvidenceJson, verifyLedgerEvidence, evidenceExitCode } from './ledger-evidence.mjs';

// Format only a fresh result from verifyLedgerEvidence, never a saved report.
export function observation(report) {
    if (report.status !== 'verified') return { code: evidenceExitCode(report), error: report.reason };
    if (report.checks.cidBinding !== 'verified') return { code: 4, error: 'raw_cid_required' };
    const ageMs = BigInt(Date.parse(report.observedAt)) - BigInt(report.block.timestamp) * 1000n;
    if (ageMs < 0n || ageMs >= 86400000n) return { code: 2, error: 'outside_observation_window' };
    const { chainId, ledgerContract } = report.expected;
    return { code: 0, text: `At ${report.observedAt} I retrieved ${report.contentBytes} bytes matching raw CID ${report.cid}. ` +
        `Publisher ${report.nodeAddress} logged it on chain ${chainId}, Ledger ${ledgerContract}, ` +
        `transaction ${report.transactionHash}, log ${report.logIndex}, block ${report.block.hash}.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = process.argv.slice(2);
    try {
        if (args.length !== 2) throw new Error();
        const [record, settings] = await Promise.all(args.map(readEvidenceJson));
        const result = observation(await verifyLedgerEvidence(record, settings));
        if (result.code === 0) console.log(result.text);
        else console.error(result.error);
        process.exitCode = result.code;
    } catch {
        console.error('Expected a readable Ledger record and verifier settings.');
        process.exitCode = 3;
    }
}
