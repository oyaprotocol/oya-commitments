import type { HttpConfig } from '@oyaprotocol/utils';
import { HttpStatusError } from '@oyaprotocol/utils';
import {
    invokeWithAbort,
    normalizeIpfsOperationError,
    runWithRetry,
    shouldRetryError,
} from './request-utils.js';
import type { IpfsOperationErrorMessages } from './request-utils.js';
import { assertNonEmptyString, assertPositiveInteger } from '@oyaprotocol/utils';

export type ReadIpfsFetchLike = (
    url: string,
    options: ReadIpfsFetchOptions
) => Promise<ReadIpfsResponse>;

export interface ReadIpfsFetchOptions {
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
    config: HttpConfig;
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
    messages: IpfsOperationErrorMessages
): Promise<ReadIpfsBytesResult> {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('config must be an object.');
    }
    if (typeof fetch !== 'function') {
        throw new Error('fetch must be provided as a function.');
    }
    const trimmedCid = assertNonEmptyString(cid, 'cid');
    const byteLimit = assertPositiveInteger(maxBytes, 'maxBytes');

    return await runWithRetry({
        maxRetries: config.maxRetries,
        retryDelayMs: config.retryDelayMs,
        timeoutMs: config.timeoutMs,
        signal,
        abortErrorMessage: messages.abortErrorMessage,
        shouldRetry: shouldRetryError,
        normalizeError: (error) => normalizeIpfsOperationError(error, messages),
        run: async ({ attempt, signal: requestSignal }) => {
            const response = await fetch(
                `${config.url}/api/v0/cat?arg=${encodeURIComponent(trimmedCid)}`,
                {
                    method: 'POST',
                    headers: config.headers,
                    signal: requestSignal,
                }
            );

            if (!response.ok) {
                const httpError = new HttpStatusError({
                    operation: 'IPFS cat',
                    status: response.status,
                    statusText: response.statusText,
                });
                response.body?.cancel(httpError).catch(() => {});
                throw httpError;
            }

            const bytes = await readBoundedBytes({
                body: response.body,
                maxBytes: byteLimit,
                signal: requestSignal,
            });

            return {
                cid: trimmedCid,
                uri: `ipfs://${trimmedCid}`,
                bytes,
                byteLength: bytes.byteLength,
                attemptCount: attempt,
            };
        },
    });
}

async function readIpfsBytes(options: ReadIpfsOptions): Promise<ReadIpfsBytesResult> {
    return await readIpfsBytesWithMessages(options, {
        abortErrorMessage: 'readIpfsBytes was aborted by the caller.',
        fallbackErrorBaseMessage: 'IPFS bytes read failed',
    });
}

export { readBoundedBytes, readIpfsBytes, readIpfsBytesWithMessages };
