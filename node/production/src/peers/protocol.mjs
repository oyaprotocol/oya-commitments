import { randomUUID } from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';
import { digest, reject, targetName, validId } from '../inbox/protocol.mjs';

export const MAX_AGE = 7 * 86400_000;
export const DOMAIN = 'Oya informational peer receive v1';
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
        value.target, value.requestId, value.expiresAt, value.text, value.sender]);
}
export async function signPeer(wallet, { networkId, receiver, target, text, requestId = randomUUID(), expiresAt = Date.now() + MAX_AGE }) {
    const value = { version: 1, operation: 'receive', networkId: network(networkId), receiver: address(receiver),
        target: targetName(target), requestId, expiresAt, text, sender: address(wallet.address) };
    return Object.freeze({ ...value, signature: await wallet.signMessage(peerText(value)) });
}
// Return a detached immutable value: storage never keeps caller-owned mutable data.
export function validatePeer(input, config, { checkExpiry = true, now = Date.now() } = {}) {
    let value;
    try {
        if (!input || Object.keys(input).sort().join() !== 'expiresAt,networkId,operation,receiver,requestId,sender,signature,target,text,version') throw new Error();
        value = { ...input };
        if (value.version !== 1 || value.operation !== 'receive' || network(value.networkId) !== config.networkId ||
            value.receiver !== address(config.nodeAddress) || value.target !== config.target || !validId(value.requestId) ||
            !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1 || value.expiresAt > 8640000000000000 ||
            typeof value.text !== 'string' || value.text.includes('\0') || !value.text.isWellFormed() ||
            Buffer.byteLength(value.text) > config.maxTextBytes || value.sender !== address(value.sender) ||
            value.sender === value.receiver || !config.members.includes(value.sender) ||
            typeof value.signature !== 'string' || !/^0x[0-9a-f]{130}$/.test(value.signature) ||
            verifyMessage(peerText(value), value.signature).toLowerCase() !== value.sender) throw new Error();
    } catch { reject(403, 'invalid_peer_envelope'); }
    if (checkExpiry && (value.expiresAt <= now || value.expiresAt > now + MAX_AGE)) reject(400, 'invalid_peer_expiry');
    return Object.freeze(value);
}
export const peerDigest = value => digest(value);
export function receiptFor(value, acceptedAt, retainedUntil) {
    return { version: 1, status: 'received', scope: 'inbox', networkId: value.networkId, receiver: value.receiver,
        target: value.target, sender: value.sender, requestId: value.requestId, digest: peerDigest(value), acceptedAt, retainedUntil };
}
