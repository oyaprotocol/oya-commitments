import { createHash } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { assertCanonicalCid } from '@oyaprotocol/utils';
import { evidenceAddress, evidenceEndpoint, evidenceJson, evidenceKeys, evidenceLimit,
    rawCidDigest, readEvidenceBytes } from './ledger-evidence.mjs';

const KIND = 'oya.retrieval-attestation';
export const MAX_CONTENT_BYTES = 1048576;
export const MAX_RECEIPT_BYTES = 1024;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const encode = value => Buffer.from(JSON.stringify(value), 'utf8');

// CIDv1, raw codec, SHA2-256 multihash; unpadded lowercase multibase base32.
function receiptBlockCid(bytes) {
    const block = Buffer.concat([Buffer.from([1, 0x55, 0x12, 32]), createHash('sha256').update(bytes).digest()]);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let result = 'b', bits = 0, acc = 0;
    for (const byte of block) {
        acc = (acc << 8) | byte;
        bits += 8;
        while (bits >= 5) { bits -= 5; result += alphabet[(acc >>> bits) & 31]; }
    }
    return bits ? result + alphabet[(acc << (5 - bits)) & 31] : result;
}

export class ReceiptPublicationUncertain extends Error {
    constructor(receiptCid) {
        super('Receipt publication uncertain. Verify before creating another receipt.');
        this.status = 'publication_uncertain';
        this.receiptCid = receiptCid;
    }
}

function rawDigest(cid) {
    const digest = rawCidDigest(assertCanonicalCid(cid, 'cid'));
    check(digest !== null, 'Expected a raw CID.');
    return digest;
}

function matchBytes(cid, bytes) {
    check(rawDigest(cid) === createHash('sha256').update(bytes).digest('hex'), 'CID/content mismatch.');
}

function metadata(cid, nodeAddress, completedAt, byteLength) {
    check(typeof completedAt === 'string' && new Date(completedAt).toISOString() === completedAt,
        'Expected a canonical UTC timestamp.');
    return { kind: KIND, version: 1, cid, nodeAddress, completedAt, byteLength };
}

// EIP-191 personal_sign of the 32 binary SHA-256 bytes (not their hex text).
// Preimage: fixed-order compact UTF-8 JSON metadata, NUL, then every source byte.
function signingDigest(fields, bytes) {
    return createHash('sha256').update(encode(fields)).update(Buffer.from([0])).update(bytes).digest();
}

/** Offline verification. Both expectations must come from outside the receipt. */
export function verifyRetrievalAttestation(receiptBytes, contentBytes, { cid, nodeAddress }) {
    check(receiptBytes instanceof Uint8Array && receiptBytes.length <= MAX_RECEIPT_BYTES, 'Invalid receipt size.');
    check(contentBytes instanceof Uint8Array && contentBytes.length <= MAX_CONTENT_BYTES, 'Invalid content size.');
    matchBytes(cid, contentBytes);
    const receipt = evidenceJson(receiptBytes);
    const fields = metadata(cid, evidenceAddress(nodeAddress), receipt.completedAt, contentBytes.length);
    const { signature } = receipt;
    check(typeof signature === 'string' && /^0x[0-9a-f]{128}(1b|1c)$/.test(signature), 'Invalid signature.');
    // Exact encoding also rejects duplicate/extra fields, invalid versions and noncanonical JSON.
    check(encode({ ...fields, signature }).equals(receiptBytes), 'Receipt metadata mismatch.');
    check(verifyMessage(signingDigest(fields, contentBytes), signature).toLowerCase() === fields.nodeAddress,
        'Unauthorized signature.');
    return receipt;
}

function kubo(settings, fetchImpl) {
    evidenceKeys(settings, ['ipfsUrl', 'ipfsAuthorization', 'nodeAddress', 'timeoutMs', 'maxBytes']);
    const endpoint = evidenceEndpoint(settings.ipfsUrl, settings.ipfsAuthorization, true);
    endpoint.url = endpoint.url.replace(/\/api\/v0$/, '');
    const timeout = evidenceLimit(settings.timeoutMs, 30000, 120000);
    const signal = AbortSignal.timeout(timeout);
    const request = (path, body, maxBytes) => readEvidenceBytes(endpoint, path, body, signal, timeout,
        { fetchImpl, maxBytes });
    return { nodeAddress: evidenceAddress(settings.nodeAddress),
        limit: evidenceLimit(settings.maxBytes, MAX_CONTENT_BYTES, MAX_CONTENT_BYTES),
        async read(cid, limit) {
            rawDigest(cid);
            const bytes = await request(`/api/v0/cat?arg=${cid}`, undefined, limit);
            matchBytes(cid, bytes);
            return bytes;
        },
        async publish(bytes, receiptCid) {
            const form = new FormData();
            form.append('file', new Blob([bytes]), 'receipt.json');
            signal.throwIfAborted();
            try {
                const reply = evidenceJson(await request('/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&pin=true&cid-base=base32',
                    form, 4096));
                check(reply?.Key === receiptCid && reply.Size === bytes.length, 'Invalid block acknowledgement.');
                await this.read(receiptCid, MAX_RECEIPT_BYTES);
            } catch {
                // The write may have landed. Never retry, or trust a peer-supplied CID for recovery.
                throw new ReceiptPublicationUncertain(receiptCid);
            }
        } };
}

/** Read once, timestamp after validation, sign, then pin the compact receipt. */
export async function attestRetrieval(cid, settings, { signer, fetchImpl = fetch, now = Date.now }) {
    const api = kubo(settings, fetchImpl);
    check(evidenceAddress(signer.address) === api.nodeAddress, 'Unauthorized node signer.');
    const content = await api.read(cid, api.limit);
    const fields = metadata(cid, api.nodeAddress, new Date(now()).toISOString(), content.length);
    const signature = await signer.signMessage(signingDigest(fields, content));
    const receiptBytes = encode({ ...fields, signature });
    const receipt = verifyRetrievalAttestation(receiptBytes, content, fields);
    const receiptCid = receiptBlockCid(receiptBytes);
    await api.publish(receiptBytes, receiptCid);
    return { receiptCid, receipt };
}

/** Fetch both blocks without a signing key. Forward the original bytes only after verification. */
export async function verifyStoredRetrieval(receiptCid, cid, settings, { fetchImpl = fetch, onVerified } = {}) {
    rawDigest(cid);
    const api = kubo(settings, fetchImpl);
    const receiptBytes = await api.read(receiptCid, MAX_RECEIPT_BYTES);
    const content = await api.read(cid, api.limit);
    const receipt = verifyRetrievalAttestation(receiptBytes, content, { cid, nodeAddress: api.nodeAddress });
    await onVerified?.(receiptBytes, content);
    return { receiptCid, receipt };
}
