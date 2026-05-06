import type { HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';
import { HttpStatusError } from '@oyaprotocol/utils';
import {
    runWithRetry,
    shouldRetryError,
} from './request-utils.js';

export type PublishableContent = string | Uint8Array | ArrayBuffer | Blob;

export interface PublishToIpfsOptions {
    config: HttpConfig;
    fetch: HttpPostFetchLike<FormData>;
    content: PublishableContent;
    filename: string;
    mediaType: string;
    signal?: AbortSignal;
}

export interface PublishToIpfsResult {
    cid: string;
    uri: string;
    pinned: true;
    filename: string;
    mediaType: string;
    contentByteLength: number;
    providerSize: number | null;
    attemptCount: number;
    providerResponse: unknown;
}

function normalizeContent(content: unknown): { blob: Blob; byteLength: number } {
    if (typeof content === 'string') {
        return {
            blob: new Blob([content]),
            byteLength: new TextEncoder().encode(content).byteLength,
        };
    }
    if (content instanceof Uint8Array) {
        return {
            blob: new Blob([content as unknown as ArrayBufferView<ArrayBuffer>]),
            byteLength: content.byteLength,
        };
    }
    if (content instanceof ArrayBuffer) {
        return {
            blob: new Blob([content]),
            byteLength: content.byteLength,
        };
    }
    if (content instanceof Blob) {
        return {
            blob: content,
            byteLength: content.size,
        };
    }
    throw new Error('content must be a string, Uint8Array, ArrayBuffer, or Blob.');
}

function buildFormData({
    content,
    mediaType,
    filename,
}: {
    content: unknown;
    mediaType: string;
    filename: string;
}): { form: FormData; contentByteLength: number } {
    const normalizedContent = normalizeContent(content);
    const form = new FormData();
    form.append(
        'file',
        normalizedContent.blob.type === mediaType
            ? normalizedContent.blob
            : new Blob([normalizedContent.blob], { type: mediaType }),
        filename
    );
    return {
        form,
        contentByteLength: normalizedContent.byteLength,
    };
}

function parseAddResponse(text: string): unknown {
    const lines = String(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) {
        throw new Error('IPFS add response was empty.');
    }
    try {
        return JSON.parse(lines[lines.length - 1]) as unknown;
    } catch {
        throw new Error('IPFS add response was not valid JSON.');
    }
}

function extractNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    return value.trim();
}

function extractSlashLink(value: unknown): string | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return extractNonEmptyString((value as Record<string, unknown>)['/']);
}

function extractCid(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const record = payload as Record<string, unknown>;
    return (
        extractNonEmptyString(record.Hash) ??
        extractNonEmptyString(record.IpfsHash) ??
        extractNonEmptyString(record.cid) ??
        extractSlashLink(record.Cid) ??
        extractSlashLink(record.cid)
    );
}

function extractProviderSize(payload: unknown): number | null {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const candidate = (payload as Record<string, unknown>).Size ?? (payload as Record<string, unknown>).size;
    if (candidate === undefined || candidate === null || candidate === '') {
        return null;
    }
    const parsed = Number(candidate);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizePublishError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    if (!error) {
        return new Error('IPFS publish failed.');
    }
    return new Error(`IPFS publish failed: ${String(error)}`);
}

async function publishToIpfs({
    config,
    fetch,
    content,
    filename,
    mediaType,
    signal,
}: PublishToIpfsOptions): Promise<PublishToIpfsResult> {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('config must be an object.');
    }
    if (typeof fetch !== 'function') {
        throw new Error('fetch must be provided as a function.');
    }
    if (typeof filename !== 'string' || !filename.trim()) {
        throw new Error('filename must be a non-empty string.');
    }
    if (typeof mediaType !== 'string' || !mediaType.trim()) {
        throw new Error('mediaType must be a non-empty string.');
    }
    const trimmedFilename = filename.trim();
    const trimmedMediaType = mediaType.trim();
    const abortErrorMessage = 'publishToIpfs was aborted by the caller.';

    return await runWithRetry({
        maxRetries: config.maxRetries,
        retryDelayMs: config.retryDelayMs,
        timeoutMs: config.timeoutMs,
        signal,
        abortErrorMessage,
        shouldRetry: shouldRetryError,
        normalizeError: normalizePublishError,
        run: async ({ attempt, signal: requestSignal }) => {
            const { form, contentByteLength } = buildFormData({
                content,
                filename: trimmedFilename,
                mediaType: trimmedMediaType,
            });
            const response = await fetch(
                `${config.url}/api/v0/add?cid-version=1&pin=true&progress=false`,
                {
                    method: 'POST',
                    headers: config.headers,
                    body: form,
                    signal: requestSignal,
                }
            );
            const responseText = await response.text();

            if (!response.ok) {
                const httpError = new HttpStatusError({
                    operation: 'IPFS add',
                    status: response.status,
                    statusText: response.statusText,
                    responseText,
                });
                throw httpError;
            }

            const providerResponse = parseAddResponse(responseText);
            const cid = extractCid(providerResponse);
            if (!cid) {
                throw new Error('IPFS add response did not include a CID.');
            }

            return {
                cid,
                uri: `ipfs://${cid}`,
                pinned: true,
                filename: trimmedFilename,
                mediaType: trimmedMediaType,
                contentByteLength,
                providerSize: extractProviderSize(providerResponse),
                attemptCount: attempt,
                providerResponse,
            };
        },
    });
}

export { publishToIpfs };
