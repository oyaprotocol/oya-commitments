import type { IpfsConfig } from './ipfs-config.js';
import {
    combineAbortSignals,
    createTimeoutSignal,
    invokeWithAbort,
    IpfsHttpError,
    shouldRetryError,
    throwIfSignalAborted,
    waitForRetryDelay,
} from './ipfs-request-utils.js';
import { assertNonEmptyString, assertPositiveInteger } from './validation-utils.js';

export type ReadIpfsFetchLike = (
    url: string,
    options: ReadIpfsRequestOptions
) => Promise<ReadIpfsResponse>;

export interface ReadIpfsRequestOptions {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal | undefined;
}

export interface ReadIpfsResponse {
    ok: boolean;
    status: number;
    statusText: string;
    body: ReadableStream<Uint8Array> | null;
}

export interface ReadIpfsOptions {
    config: IpfsConfig;
    fetch: ReadIpfsFetchLike;
    cid: string;
    maxBytes: number;
    signal?: AbortSignal;
}

export interface ReadIpfsBytesResult {
    cid: string;
    uri: string;
    bytes: Uint8Array;
    byteLength: number;
    attemptCount: number;
}

interface ReadIpfsErrorMessages {
    abortErrorMessage: string;
    fallbackErrorBaseMessage: string;
}

function normalizeReadError(error: unknown, messages: ReadIpfsErrorMessages): Error {
    if (error instanceof Error) {
        return error;
    }
    if (!error) {
        return new Error(`${messages.fallbackErrorBaseMessage}.`);
    }
    return new Error(`${messages.fallbackErrorBaseMessage}: ${String(error)}`);
}

function combineChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
    const combined = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return combined;
}

async function readBoundedBytes({
    body,
    maxBytes,
    signal,
}: {
    body: ReadableStream<Uint8Array> | null;
    maxBytes: number;
    signal: AbortSignal | undefined;
}): Promise<Uint8Array> {
    if (!body || typeof body.getReader !== 'function') {
        throw new Error('IPFS cat response body must be a ReadableStream.');
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
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
    } catch (error) {
        reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        if (completed) {
            reader.releaseLock();
        }
    }

    return combineChunks(chunks, byteLength);
}

async function readIpfsBytesWithMessages(
    {
        config,
        fetch,
        cid,
        maxBytes,
        signal,
    }: ReadIpfsOptions,
    messages: ReadIpfsErrorMessages
): Promise<ReadIpfsBytesResult> {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('config must be an object.');
    }
    if (typeof fetch !== 'function') {
        throw new Error('fetch must be provided as a function.');
    }
    const trimmedCid = assertNonEmptyString(cid, 'cid');
    const byteLimit = assertPositiveInteger(maxBytes, 'maxBytes');

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(config.timeoutMs);
        const requestSignal = combineAbortSignals([signal, timeoutSignal.signal]);
        try {
            const response = await invokeWithAbort(
                () =>
                    fetch(`${config.apiUrl}/api/v0/cat?arg=${encodeURIComponent(trimmedCid)}`, {
                        method: 'POST',
                        headers: config.headers,
                        signal: requestSignal.signal,
                    }),
                requestSignal.signal
            );

            if (!response.ok) {
                const httpError = new IpfsHttpError(
                    `IPFS cat failed with ${response.status} ${
                        response.statusText || 'Unknown Status'
                    }.`,
                    {
                        status: response.status,
                    }
                );
                response.body?.cancel(httpError).catch(() => {});
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
        } catch (error) {
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
        } finally {
            requestSignal.cleanup?.();
            timeoutSignal.cleanup?.();
        }
    }

    throw normalizeReadError(lastError, messages);
}

async function readIpfsBytes(options: ReadIpfsOptions): Promise<ReadIpfsBytesResult> {
    return await readIpfsBytesWithMessages(options, {
        abortErrorMessage: 'readIpfsBytes was aborted by the caller.',
        fallbackErrorBaseMessage: 'IPFS bytes read failed',
    });
}

export { readBoundedBytes, readIpfsBytes, readIpfsBytesWithMessages };
