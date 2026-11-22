import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';
import { installationNodeKey } from './peers/local.mjs';
import { readEvidenceJson } from './ledger-evidence.mjs';
import { attestRetrieval, verifyStoredRetrieval } from './retrieval-attestation.mjs';

const usage = 'Usage: attest-retrieval.mjs create CID SETTINGS | verify RECEIPT_CID CID SETTINGS';

export async function runRetrievalCli(args, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
    const [mode] = args;
    if (!((mode === 'create' && args.length === 3) || (mode === 'verify' && args.length === 4))) {
        throw new Error(usage);
    }
    const settings = await readEvidenceJson(args.at(-1));
    if (mode === 'verify') return verifyStoredRetrieval(args[1], args[2], settings, { fetchImpl });
    let signer;
    try { signer = new Wallet(await installationNodeKey(env)); }
    catch { throw new Error('Invalid node signing key.'); }
    return attestRetrieval(args[1], settings, { signer, fetchImpl, now });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { console.log(JSON.stringify(await runRetrievalCli(process.argv.slice(2)))); }
    catch (error) {
        // Endpoint errors and signer errors can contain private settings.
        const { ReceiptPublicationUncertain } = await import('./retrieval-attestation.mjs');
        if (error instanceof ReceiptPublicationUncertain) {
            console.error(JSON.stringify({ status: error.status, receiptCid: error.receiptCid,
                action: 'Run verify with this receipt CID, the original CID and settings before retrying create.' }));
            process.exitCode = 2;
        } else {
            console.error(error?.message === usage ? usage : 'Retrieval attestation failed. Check settings, CIDs and node identity.');
            process.exitCode = 1;
        }
    }
}
