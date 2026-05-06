import {
    normalizeIpfsOperationError,
    runWithRetry,
    shouldRetryError,
} from './request-utils.js';
import type { IpfsOperationErrorMessages } from './request-utils.js';
import { readBoundedBytes, type ReadIpfsBytesResult } from './read-bytes.js';
import {
    HttpStatusError,
    assertHeadersObject,
    assertNonEmptyString,
    assertNonNegativeInteger,
    assertPositiveInteger,
} from '@oyaprotocol/utils';

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

function buildGatewayReadUrl(gatewayUrl: string, cid: string): string {
    const url = new URL(gatewayUrl);
    if (url.hash) {
        throw new Error('gatewayUrl must not include a fragment.');
    }

    const basePath = url.pathname.replace(/\/+$/, '').replace(/\/ipfs$/, '');
    url.pathname = `${basePath}/ipfs/${encodeURIComponent(cid)}`;
    return url.toString();
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
    const trimmedCid = assertNonEmptyString(cid, 'cid');
    const gatewayReadUrl = buildGatewayReadUrl(
        assertNonEmptyString(gatewayUrl, 'gatewayUrl'),
        trimmedCid
    );
    const validatedHeaders = assertHeadersObject(headers, 'headers');
    const requestTimeoutMs = assertPositiveInteger(timeoutMs, 'timeoutMs');
    const retryLimit = assertNonNegativeInteger(maxRetries, 'maxRetries');
    const retryDelay = assertNonNegativeInteger(retryDelayMs, 'retryDelayMs');
    if (typeof fetch !== 'function') {
        throw new Error('fetch must be provided as a function.');
    }
    const byteLimit = assertPositiveInteger(maxBytes, 'maxBytes');

    return await runWithRetry({
        maxRetries: retryLimit,
        retryDelayMs: retryDelay,
        timeoutMs: requestTimeoutMs,
        signal,
        abortErrorMessage: messages.abortErrorMessage,
        shouldRetry: shouldRetryError,
        normalizeError: (error) => normalizeIpfsOperationError(error, messages),
        run: async ({ attempt, signal: requestSignal }) => {
            const response = await fetch(gatewayReadUrl, {
                method: 'GET',
                headers: validatedHeaders,
                signal: requestSignal,
            });

            if (!response.ok) {
                const httpError = new HttpStatusError({
                    operation: 'IPFS public gateway read',
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

async function readIpfsPublicGatewayBytes(
    options: ReadIpfsPublicGatewayOptions
): Promise<ReadIpfsBytesResult> {
    return await readIpfsPublicGatewayBytesWithMessages(options, {
        abortErrorMessage: 'readIpfsPublicGatewayBytes was aborted by the caller.',
        fallbackErrorBaseMessage: 'IPFS public gateway bytes read failed',
    });
}

export { readIpfsPublicGatewayBytes, readIpfsPublicGatewayBytesWithMessages };
