import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { inboxUrl } from '../inbox/config.mjs';
import { receiptFor, validatePeer } from './protocol.mjs';

export function inspectEnvelope(value, checkExpiry = false) {
    return validatePeer(value, { networkId: value?.networkId, nodeAddress: value?.receiver, target: value?.target,
        maxTextBytes: 8192, members: [value?.sender] }, { checkExpiry });
}
export function validateReceipt(result, envelope) {
    const expected = receiptFor(envelope, result?.acceptedAt, result?.retainedUntil);
    if (!result || Object.keys(result).sort().join() !== Object.keys(expected).sort().join() ||
        Object.keys(expected).some(key => result[key] !== expected[key]) ||
        !Number.isSafeInteger(result.acceptedAt) || result.acceptedAt < 1 || result.acceptedAt >= envelope.expiresAt ||
        !Number.isSafeInteger(result.retainedUntil) || result.retainedUntil < envelope.expiresAt ||
        result.retainedUntil <= result.acceptedAt) throw new Error('Invalid peer receipt.');
    return expected;
}
// Direct Node transport: no ambient proxy credentials, redirect handling or cookies.
export function requestPeer(url, bytes, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
            method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) }
        });
        const timer = setTimeout(() => request.destroy(new Error('Peer deadline exceeded.')), timeoutMs);
        const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
        request.on('error', error => finish(error));
        request.on('response', response => {
            const chunks = [];
            let size = 0;
            response.on('error', error => finish(error));
            response.on('data', chunk => {
                size += chunk.length;
                if (size > 16384) { request.destroy(new Error('Peer response exceeds limit.')); return; }
                chunks.push(chunk);
            });
            response.on('end', () => {
                try {
                    if (!/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')) throw new Error('Invalid peer response type.');
                    finish(null, { status: response.statusCode, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) });
                } catch (error) { finish(error); }
            });
        });
        request.end(bytes);
    });
}
export async function sendPeer(origin, bytes, operation, transport = requestPeer) {
    if (!['submit', 'status'].includes(operation)) throw new Error('Invalid peer command.');
    const envelope = inspectEnvelope(JSON.parse(bytes), operation === 'submit');
    const url = new URL(`/v1/peers/${operation === 'submit' ? 'receive' : 'status'}`, inboxUrl(origin));
    const result = await transport(url, bytes);
    if (result.status !== (operation === 'submit' ? 202 : 200)) throw new Error('Peer request failed; query status with the saved envelope.');
    return validateReceipt(result.body, envelope);
}
