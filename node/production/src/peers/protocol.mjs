import { randomUUID } from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';
import { verifySignedMessage } from '@oyaprotocol/messages';
import { digest, reject, targetName, validId, jobText, signJob } from '../inbox/protocol.mjs';

// This ordinary signed job is queued and consumed without re-signing its message.
export function peerJob(value) {
    return { version: 1, target: value.target, requestId: value.requestId, expiresAt: value.expiresAt,
        message: value.message, requestSignature: value.requestSignature };
}

export const MAX_AGE = 7 * 86400_000;
export const DOMAIN = 'Oya peer publication receive v2';
export function address(value) {
    const result = getAddress(value).toLowerCase();
    if (/^0x0{40}$/.test(result)) throw new Error('Zero peer address.');
    return result;
}
export function network(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(value)) throw new Error('Invalid peer network.');
    return value;
}
export function peerText(value) {
    return DOMAIN + '\n' + JSON.stringify([value.version, value.operation, value.networkId, value.receiver,
        value.target, value.requestId, value.expiresAt, value.message.text, value.message.signer,
        value.message.signature, value.requestSignature, value.sender]);
}
export async function signPeer(wallet, { networkId, receiver, target, text, requestId = randomUUID(), expiresAt = Date.now() + MAX_AGE }) {
    const job = await signJob(wallet, target, text, { requestId, expiresAt });
    const value = { version: 2, operation: 'receive', networkId: network(networkId), receiver: address(receiver),
        target: targetName(target), requestId, expiresAt, message: Object.freeze(job.message),
        requestSignature: job.requestSignature, sender: address(wallet.address) };
    return Object.freeze({ ...value, signature: await wallet.signMessage(peerText(value)) });
}
// Return a detached immutable value: storage never keeps caller-owned mutable data.
export function validatePeer(input, config, { checkExpiry = true, now = Date.now() } = {}) {
    let value;
    try {
        if (!input || Object.keys(input).sort().join() !== 'expiresAt,message,networkId,operation,receiver,requestId,requestSignature,sender,signature,target,version' ||
            !input.message || Object.keys(input.message).sort().join() !== 'signature,signer,text') throw new Error();
        value = { ...input, message: Object.freeze({ ...input.message }) };
        if (value.version !== 2 || value.operation !== 'receive' || network(value.networkId) !== config.networkId ||
            value.receiver !== address(config.nodeAddress) || value.target !== config.target || !validId(value.requestId) ||
            !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1 || value.expiresAt > 8640000000000000 ||
            typeof value.message.text !== 'string' || value.message.text.includes('\0') || !value.message.text.isWellFormed() ||
            Buffer.byteLength(value.message.text) > config.maxTextBytes || value.sender !== address(value.sender) ||
            address(value.message.signer) !== value.sender ||
            verifyMessage(jobText(peerJob(value)), value.requestSignature).toLowerCase() !== value.sender ||
            value.sender === value.receiver || !config.members.includes(value.sender) ||
            typeof value.signature !== 'string' || !/^0x[0-9a-f]{130}$/.test(value.signature) ||
            verifyMessage(peerText(value), value.signature).toLowerCase() !== value.sender) throw new Error();
        verifySignedMessage(value.message);
    } catch { reject(403, 'invalid_peer_envelope'); }
    if (checkExpiry && (value.expiresAt <= now || value.expiresAt > now + MAX_AGE)) reject(400, 'invalid_peer_expiry');
    return Object.freeze(value);
}
export const peerDigest = value => digest(value);
export function receiptFor(value, acceptedAt, retainedUntil) {
    return { version: 1, status: 'received', scope: 'inbox', networkId: value.networkId, receiver: value.receiver,
        target: value.target, sender: value.sender, requestId: value.requestId, digest: peerDigest(value), acceptedAt, retainedUntil };
}
