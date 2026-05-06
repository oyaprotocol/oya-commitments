import { HttpStatusError } from '@oyaprotocol/utils';
import { combineAbortSignals, createTimeoutSignal, invokeWithAbort, normalizeIpfsOperationError, shouldRetryError, throwIfSignalAborted, waitForRetryDelay, } from './request-utils.js';
import { assertNonEmptyString, assertPositiveInteger } from '@oyaprotocol/utils';
function combineChunks(chunks, byteLength) {
    const combined = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return combined;
}
async function readBoundedBytes({ body, maxBytes, signal, }) {
    if (!body || typeof body.getReader !== 'function') {
        throw new Error('IPFS cat response body must be a ReadableStream.');
    }
    const reader = body.getReader();
    const chunks = [];
    let byteLength = 0;
    let completed = false;
    try {
        while (true) {
            const readResult = await invokeWithAbort(() => reader.read(), signal);
            if (readResult.done) {
                completed = true;
                break;
            }
            const chunk = readResult.value;
            if (!(chunk instanceof Uint8Array)) {
                throw new Error('IPFS cat response body chunks must be Uint8Array values.');
            }
            byteLength += chunk.byteLength;
            if (byteLength > maxBytes) {
                throw new Error(`IPFS cat response exceeded maxBytes (${maxBytes}).`);
            }
            chunks.push(chunk);
        }
    }
    catch (error) {
        reader.cancel(error).catch(() => { });
        throw error;
    }
    finally {
        if (completed) {
            reader.releaseLock();
        }
    }
    return combineChunks(chunks, byteLength);
}
async function readIpfsBytesWithMessages({ config, fetch, cid, maxBytes, signal, }, messages) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('config must be an object.');
    }
    if (typeof fetch !== 'function') {
        throw new Error('fetch must be provided as a function.');
    }
    const trimmedCid = assertNonEmptyString(cid, 'cid');
    const byteLimit = assertPositiveInteger(maxBytes, 'maxBytes');
    let lastError = null;
    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(config.timeoutMs);
        const requestSignal = combineAbortSignals([signal, timeoutSignal.signal]);
        try {
            const response = await invokeWithAbort(() => fetch(`${config.url}/api/v0/cat?arg=${encodeURIComponent(trimmedCid)}`, {
                method: 'POST',
                headers: config.headers,
                signal: requestSignal.signal,
            }), requestSignal.signal);
            if (!response.ok) {
                const httpError = new HttpStatusError({
                    operation: 'IPFS cat',
                    status: response.status,
                    statusText: response.statusText,
                });
                response.body?.cancel(httpError).catch(() => { });
                throw httpError;
            }
            const bytes = await readBoundedBytes({
                body: response.body,
                maxBytes: byteLimit,
                signal: requestSignal.signal,
            });
            return {
                cid: trimmedCid,
                uri: `ipfs://${trimmedCid}`,
                bytes,
                byteLength: bytes.byteLength,
                attemptCount: attempt,
            };
        }
        catch (error) {
            lastError = error;
            throwIfSignalAborted(signal, messages.abortErrorMessage, error);
            if (attempt <= config.maxRetries && shouldRetryError(error)) {
                await waitForRetryDelay({
                    retryDelayMs: config.retryDelayMs,
                    signal,
                    abortErrorMessage: messages.abortErrorMessage,
                });
                continue;
            }
            break;
        }
        finally {
            requestSignal.cleanup?.();
            timeoutSignal.cleanup?.();
        }
    }
    throw normalizeIpfsOperationError(lastError, messages);
}
async function readIpfsBytes(options) {
    return await readIpfsBytesWithMessages(options, {
        abortErrorMessage: 'readIpfsBytes was aborted by the caller.',
        fallbackErrorBaseMessage: 'IPFS bytes read failed',
    });
}
export { readBoundedBytes, readIpfsBytes, readIpfsBytesWithMessages };
//# sourceMappingURL=read-bytes.js.map