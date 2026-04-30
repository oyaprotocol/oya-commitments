import type { IpfsConfig } from './ipfs-config.js';
import {
    combineAbortSignals,
    createTimeoutSignal,
    invokeWithAbort,
    shouldRetryError,
    throwIfSignalAborted,
    waitForRetryDelay,
} from './ipfs-request-utils.js';

export type ReadIpfsTextFetchLike = (
    url: string,
    options: ReadIpfsTextRequestOptions
) => Promise<ReadIpfsTextResponse>;

export interface ReadIpfsTextRequestOptions {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal | undefined;
}

export interface ReadIpfsTextResponse {
    ok: boolean;
    status: number;
    statusText: string;
    body: ReadableStream<Uint8Array> | null;
}

export interface ReadIpfsTextOptions {
    config: IpfsConfig;
    fetch: ReadIpfsTextFetchLike;
    cid: string;
    maxBytes: number;
    signal?: AbortSignal;
}

export interface ReadIpfsTextResult {
    cid: string;
    uri: string;
    text: string;
    byteLength: number;
    attemptCount: number;
}

type HttpReadError = Error & {
    status: number;
};

function assertNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}

function assertPositiveInteger(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return value;
}

function normalizeReadError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    if (!error) {
        return new Error('IPFS text read failed.');
    }
    return new Error(`IPFS text read failed: ${String(error)}`);
}

function isHttpReadError(error: unknown): error is HttpReadError {
    return error instanceof Error && typeof (error as { status?: unknown }).status === 'number';
}

function cancelReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    reason: unknown
): void {
    reader.cancel(reason).catch(() => {});
}

function cancelResponseBody(body: ReadableStream<Uint8Array> | null, reason: unknown): void {
    body?.cancel(reason).catch(() => {});
}

function assertAsciiChunk(chunk: Uint8Array): void {
    for (const byte of chunk) {
        if (byte > 0x7f) {
            throw new Error('IPFS cat response contained non-ASCII bytes.');
        }
    }
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

async function readBoundedAsciiText({
    body,
    maxBytes,
    signal,
}: {
    body: ReadableStream<Uint8Array> | null;
    maxBytes: number;
    signal: AbortSignal | undefined;
}): Promise<{ text: string; byteLength: number }> {
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
            assertAsciiChunk(chunk);
            chunks.push(chunk);
        }
    } catch (error) {
        cancelReader(reader, error);
        throw error;
    } finally {
        if (completed) {
            reader.releaseLock();
        }
    }

    const bytes = combineChunks(chunks, byteLength);
    return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        byteLength,
    };
}

async function readIpfsText({
    config,
    fetch,
    cid,
    maxBytes,
    signal,
}: ReadIpfsTextOptions): Promise<ReadIpfsTextResult> {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('config must be an object.');
    }
    if (typeof fetch !== 'function') {
        throw new Error('fetch must be provided as a function.');
    }
    const trimmedCid = assertNonEmptyString(cid, 'cid');
    const byteLimit = assertPositiveInteger(maxBytes, 'maxBytes');
    const abortErrorMessage = 'readIpfsText was aborted by the caller.';

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
                const httpError: HttpReadError = Object.assign(
                    new Error(
                        `IPFS cat failed with ${response.status} ${
                            response.statusText || 'Unknown Status'
                        }.`
                    ),
                    {
                        status: response.status,
                    }
                );
                cancelResponseBody(response.body, httpError);
                if (
                    attempt <= config.maxRetries &&
                    (response.status === 429 || response.status >= 500)
                ) {
                    await waitForRetryDelay({
                        retryDelayMs: config.retryDelayMs,
                        signal,
                        abortErrorMessage,
                    });
                    continue;
                }
                throw httpError;
            }

            const { text, byteLength } = await readBoundedAsciiText({
                body: response.body,
                maxBytes: byteLimit,
                signal: requestSignal.signal,
            });

            return {
                cid: trimmedCid,
                uri: `ipfs://${trimmedCid}`,
                text,
                byteLength,
                attemptCount: attempt,
            };
        } catch (error) {
            lastError = error;
            throwIfSignalAborted(signal, abortErrorMessage, error);
            if (
                attempt <= config.maxRetries &&
                !isHttpReadError(error) &&
                shouldRetryError(error)
            ) {
                await waitForRetryDelay({
                    retryDelayMs: config.retryDelayMs,
                    signal,
                    abortErrorMessage,
                });
                continue;
            }
            break;
        } finally {
            requestSignal.cleanup?.();
            timeoutSignal.cleanup?.();
        }
    }

    throw normalizeReadError(lastError);
}

export { readIpfsText };
