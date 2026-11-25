import { constants } from 'node:fs';
import fs, { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';
import { installationNodeKey } from './peers/local.mjs';
import { readEvidenceJson } from './ledger-evidence.mjs';
import { attestRetrieval, MAX_CONTENT_BYTES, MAX_RECEIPT_BYTES, receiptBlockCid,
    verifyRetrievalAttestation, verifyStoredRetrieval } from './retrieval-attestation.mjs';

const usage = 'Usage: attest-retrieval.mjs create CID SETTINGS | verify RECEIPT_CID CID SETTINGS [--export NEW_DIR] | verify-files RECEIPT_FILE CONTENT_FILE CID NODE_ADDRESS';

async function exportBlocks(dir, receiptBytes, content) {
    await fs.mkdir(dir, { mode: 0o700 }); // Exclusive reservation: never replace an existing path.
    const pending = join(dir, '.pending');
    try {
        await fs.mkdir(pending, { mode: 0o700 });
        await fs.writeFile(join(pending, 'receipt.json'), receiptBytes, { mode: 0o600 });
        await fs.writeFile(join(pending, 'content.bin'), content, { mode: 0o600 });
        await fs.rename(pending, join(dir, 'blocks'));
    } catch (error) {
        await fs.rm(dir, { recursive: true });
        throw error;
    }
}

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
    if (mode === 'verify') {
        const exporting = args.length === 6 && args[4] === '--export' && args[5] !== '';
        if (args.length !== 4 && !exporting) throw new Error(usage);
        return verifyStoredRetrieval(args[1], args[2], await readEvidenceJson(args[3]), { fetchImpl,
            onVerified: exporting ? (bytes, content) => exportBlocks(args[5], bytes, content) : undefined });
    }
    if (mode !== 'create' || args.length !== 3) throw new Error(usage);
    const settings = await readEvidenceJson(args[2]);
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
