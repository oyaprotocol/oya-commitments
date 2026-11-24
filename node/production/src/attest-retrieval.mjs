import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';
import { installationNodeKey } from './peers/local.mjs';
import { readEvidenceJson } from './ledger-evidence.mjs';
import { attestRetrieval, MAX_CONTENT_BYTES, MAX_RECEIPT_BYTES, receiptBlockCid,
    verifyRetrievalAttestation, verifyStoredRetrieval } from './retrieval-attestation.mjs';

const usage = 'Usage: attest-retrieval.mjs create CID SETTINGS | verify RECEIPT_CID CID SETTINGS | verify-files RECEIPT_FILE CONTENT_FILE CID NODE_ADDRESS';

async function readRegularFile(path, limit) {
    if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new Error('Safe file reads unavailable.');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error('Invalid input file.');
        // Probe one byte beyond the reported length so growth cannot be silently truncated.
        const buffer = Buffer.alloc(stat.size + 1);
        let size = 0;
        while (size < buffer.length) {
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
        }
        if (size !== stat.size) throw new Error('Input file size changed.');
        return buffer.subarray(0, size);
    } finally { await file.close(); }
}

export async function runRetrievalCli(args, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
    const [mode] = args;
    if (mode === 'verify-files') {
        if (args.length !== 5) throw new Error(usage);
        const [, receiptPath, contentPath, cid, nodeAddress] = args;
        const bytes = await readRegularFile(receiptPath, MAX_RECEIPT_BYTES);
        const content = await readRegularFile(contentPath, MAX_CONTENT_BYTES);
        const receipt = verifyRetrievalAttestation(bytes, content, { cid, nodeAddress });
        return { receiptCid: receiptBlockCid(bytes), receipt };
    }
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
