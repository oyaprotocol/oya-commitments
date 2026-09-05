import { assertCanonicalCid, HttpStatusError } from '@oyaprotocol/utils';
import { IPFS_ADD_QUERY } from './import-profile.js';
import { runWithRetry, shouldRetryError, } from './request-utils.js';
function normalizeContent(content) {
    if (typeof content === 'string') {
        return {
            blob: new Blob([content]),
            byteLength: new TextEncoder().encode(content).byteLength,
        };
    }
    if (content instanceof Uint8Array) {
        return {
            blob: new Blob([content]),
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
function buildFormData({ content, mediaType, filename, }) {
    const normalizedContent = normalizeContent(content);
    const form = new FormData();
    form.append('file', normalizedContent.blob.type === mediaType
        ? normalizedContent.blob
        : new Blob([normalizedContent.blob], { type: mediaType }), filename);
    return {
        form,
        contentByteLength: normalizedContent.byteLength,
    };
}
function parseAddResponse(text) {
    const lines = String(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) {
        throw new Error('IPFS add response was empty.');
    }
    try {
        return JSON.parse(lines[lines.length - 1]);
    }
    catch {
        throw new Error('IPFS add response was not valid JSON.');
    }
}
function extractNonEmptyString(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    return value;
}
function extractSlashLink(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return extractNonEmptyString(value['/']);
}
function extractCid(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const record = payload;
    return (extractNonEmptyString(record.Hash) ??
        extractNonEmptyString(record.IpfsHash) ??
        extractNonEmptyString(record.cid) ??
        extractSlashLink(record.Cid) ??
        extractSlashLink(record.cid));
}
function extractProviderSize(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const candidate = payload.Size ?? payload.size;
    if (candidate === undefined || candidate === null || candidate === '') {
        return null;
    }
    const parsed = Number(candidate);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function normalizePublishError(error) {
    if (error instanceof Error) {
        return error;
    }
    if (!error) {
        return new Error('IPFS publish failed.');
    }
    return new Error(`IPFS publish failed: ${String(error)}`);
}
async function publishToIpfs({ config, fetch, content, filename, mediaType, signal, }) {
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
    if (/[\\/\u0000\r\n]/.test(filename) || trimmedFilename === '.' || trimmedFilename === '..') {
        throw new Error('filename must be a single filename without a path or control separators.');
    }
    const trimmedMediaType = mediaType.trim();
    // Snapshot mutable inputs once so retries publish the same bytes and CID.
    const { blob } = normalizeContent(content);
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
                content: blob,
                filename: trimmedFilename,
                mediaType: trimmedMediaType,
            });
            const response = await fetch(`${config.url}/api/v0/add?${IPFS_ADD_QUERY}`, {
                method: 'POST',
                headers: config.headers,
                body: form,
                signal: requestSignal,
            });
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
            assertCanonicalCid(cid, 'IPFS add response CID');
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
//# sourceMappingURL=publish.js.map