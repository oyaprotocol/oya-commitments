import { createHash, randomUUID } from 'node:crypto';
import { verifyMessage, Transaction } from 'ethers';
import { createSignedMessageAuthorizer } from '@oyaprotocol/messages';
import { encodeLedgerCall } from '@oyaprotocol/ethereum';

export class InboxError extends Error {
    constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export const reject = (status, code) => { throw new InboxError(status, code); };
const canonical = value => value && typeof value === 'object' ? (Array.isArray(value) ? value.map(canonical) :
    Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function targetName(value) {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid inbox target.');
    return value;
}
export function jobText(job) {
    return 'Oya inbox job v1\n' + JSON.stringify([job.target, job.requestId, job.expiresAt,
        job.message.text, job.message.signer.toLowerCase(), job.message.signature]);
}
export async function signJob(wallet, target, text, { requestId = randomUUID(), expiresAt = Date.now() + 86400_000 } = {}) {
    const job = { version: 1, target: targetName(target), requestId, expiresAt,
        message: { text, signer: wallet.address, signature: await wallet.signMessage(text) } };
    return { ...job, requestSignature: await wallet.signMessage(jobText(job)) };
}
export async function validateJob(job, { target, allowedSigners, maxTextBytes = 8192, checkExpiry = true, now = Date.now() }) {
    try {
        if (!job || job.version !== 1 || job.target !== target || !validId(job.requestId) ||
            !Number.isSafeInteger(job.expiresAt) || job.expiresAt < 1 ||
            Object.keys(job).sort().join() !== 'expiresAt,message,requestId,requestSignature,target,version' ||
            Object.keys(job.message).sort().join() !== 'signature,signer,text' ||
            typeof job.message.text !== 'string' || Buffer.byteLength(job.message.text) > maxTextBytes) throw new Error();
        const authorize = createSignedMessageAuthorizer(allowedSigners);
        if (!await authorize(job.message)) throw new Error();
        if (verifyMessage(jobText(job), job.requestSignature).toLowerCase() !== job.message.signer.toLowerCase()) throw new Error();
    } catch { reject(403, 'invalid_signed_job'); }
    if (checkExpiry && (job.expiresAt <= now || job.expiresAt > now + 7 * 86400_000)) reject(400, 'invalid_job_expiry');
    return job;
}
export function executionIdentity(config, nodeAddress) {
    return config.mode === 'ipfs' ? { mode: 'ipfs' } : { mode: 'ledger', chainId: config.chainId,
        ledgerContract: config.ledgerContract.toLowerCase(), nodeAddress: nodeAddress.toLowerCase() };
}
export function validateTransaction(transaction, cid, identity, limits) {
    try {
        const tx = Transaction.from(transaction.rawTransaction);
        if (identity.mode !== 'ledger' || tx.type !== 2 || tx.hash !== transaction.transactionHash ||
            tx.chainId !== BigInt(identity.chainId) || tx.from?.toLowerCase() !== identity.nodeAddress ||
            tx.to?.toLowerCase() !== identity.ledgerContract || tx.value !== 0n ||
            tx.data !== encodeLedgerCall(cid) || tx.accessList.length !== 0 ||
            (limits && (tx.gasLimit > limits.gasLimit || tx.maxFeePerGas > limits.feePerGas))) throw new Error();
    } catch { reject(409, 'invalid_transaction_checkpoint'); }
}
