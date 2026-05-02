import {
    combineAbortSignals,
    createTimeoutSignal,
    invokeWithAbort,
    IpfsHttpError,
    normalizeIpfsOperationError,
    shouldRetryError,
    throwIfSignalAborted,
    waitForRetryDelay,
} from './ipfs-request-utils.js';
import type { IpfsOperationErrorMessages } from './ipfs-request-utils.js';
import { readBoundedBytes, type ReadIpfsBytesResult } from './read-ipfs-bytes.js';
import {
    assertNonEmptyString,
    assertNonNegativeInteger,
    assertPositiveInteger,
} from './validation-utils.js';

export type ReadIpfsPublicGatewayFetchLike = (
    url: string,
    options: ReadIpfsPublicGatewayFetchOptions
) => Promise<ReadIpfsPublicGatewayResponse>;

export interface ReadIpfsPublicGatewayFetchOptions {
    method: 'GET';
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal | undefined;
}

export interface ReadIpfsPublicGatewayResponse {
    ok: boolean;
    status: number;
    statusText: string;
    body: ReadableStream<Uint8Array> | null;
}

export interface ReadIpfsPublicGatewayOptions {
    gatewayUrl: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
    fetch: ReadIpfsPublicGatewayFetchLike;
    cid: string;
    maxBytes: number;
    signal?: AbortSignal;
}

function assertHeadersObject(headers: unknown, label: string): Readonly<Record<string, string>> {
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new Error(`${label} must be an object.`);
    }
    const validated: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (typeof value !== 'string') {
            throw new Error(`${label}.${key} must be a string.`);
        }
        validated[key] = value;
    }
    return Object.freeze(validated);
}

function normalizeGatewayUrl(gatewayUrl: string): string {
    return gatewayUrl.replace(/\/+$/, '').replace(/\/ipfs$/, '');
}

async function readIpfsPublicGatewayBytesWithMessages(
    {
        gatewayUrl,
        headers,
        timeoutMs,
        maxRetries,
        retryDelayMs,
        fetch,
        cid,
        maxBytes,
        signal,
    }: ReadIpfsPublicGatewayOptions,
    messages: IpfsOperationErrorMessages
): Promise<ReadIpfsBytesResult> {
    const normalizedGatewayUrl = normalizeGatewayUrl(
        assertNonEmptyString(gatewayUrl, 'gatewayUrl')
    );
    const validatedHeaders = assertHeadersObject(headers, 'headers');
    const requestTimeoutMs = assertPositiveInteger(timeoutMs, 'timeoutMs');
    const retryLimit = assertNonNegativeInteger(maxRetries, 'maxRetries');
    const retryDelay = assertNonNegativeInteger(retryDelayMs, 'retryDelayMs');
    if (typeof fetch !== 'function') {
        throw new Error('fetch must be provided as a function.');
    }
    const trimmedCid = assertNonEmptyString(cid, 'cid');
    const byteLimit = assertPositiveInteger(maxBytes, 'maxBytes');

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(requestTimeoutMs);
        const requestSignal = combineAbortSignals([signal, timeoutSignal.signal]);
        try {
            const response = await invokeWithAbort(
                () =>
                    fetch(
                        `${normalizedGatewayUrl}/ipfs/${encodeURIComponent(trimmedCid)}`,
                        {
                            method: 'GET',
                            headers: validatedHeaders,
                            signal: requestSignal.signal,
                        }
                    ),
                requestSignal.signal
            );

            if (!response.ok) {
                const httpError = new IpfsHttpError(
                    `IPFS public gateway read failed with ${response.status} ${
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
            if (attempt <= retryLimit && shouldRetryError(error)) {
                await waitForRetryDelay({
                    retryDelayMs: retryDelay,
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

    throw normalizeIpfsOperationError(lastError, messages);
}

async function readIpfsPublicGatewayBytes(
    options: ReadIpfsPublicGatewayOptions
): Promise<ReadIpfsBytesResult> {
    return await readIpfsPublicGatewayBytesWithMessages(options, {
        abortErrorMessage: 'readIpfsPublicGatewayBytes was aborted by the caller.',
        fallbackErrorBaseMessage: 'IPFS public gateway bytes read failed',
    });
}

export { readIpfsPublicGatewayBytes, readIpfsPublicGatewayBytesWithMessages };
