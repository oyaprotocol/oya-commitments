const DEFAULT_IPFS_API_URL = 'http://127.0.0.1:5001';
const DEFAULT_IPFS_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_IPFS_MAX_RETRIES = 1;
const DEFAULT_IPFS_RETRY_DELAY_MS = 250;
const RETRYABLE_ERROR_CODES = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
]);

function normalizeNonNegativeInteger(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.floor(parsed);
}

function normalizeIpfsApiUrl(url) {
    return (url ?? DEFAULT_IPFS_API_URL).replace(/\/+$/, '');
}

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = canonicalize(value[key]);
        }
        return out;
    }
    return value;
}

function buildContentString({ content, json }) {
    const hasContent = typeof content === 'string';
    const hasJson = Boolean(json) && typeof json === 'object' && !Array.isArray(json);
    if (hasContent === hasJson) {
        throw new Error('ipfs_publish requires exactly one of content or json.');
    }
    if (hasContent) {
        return String(content);
    }
    return JSON.stringify(canonicalize(json));
}

function resolveMediaType({ mediaType, json }) {
    if (typeof mediaType === 'string' && mediaType.trim()) {
        return mediaType.trim();
    }
    if (json && typeof json === 'object' && !Array.isArray(json)) {
        return 'application/json';
    }
    return 'text/plain; charset=utf-8';
}

function resolveFilename({ filename, mediaType }) {
    if (typeof filename === 'string' && filename.trim()) {
        return filename.trim();
    }
    if (String(mediaType).toLowerCase().includes('json')) {
        return 'artifact.json';
    }
    return 'artifact.txt';
}

function buildRequestHeaders(headers = {}, { stripContentType = false } = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null) continue;
        if (stripContentType && String(key).toLowerCase() === 'content-type') continue;
        out[key] = String(value);
    }
    return out;
}

function shouldRetryResponseStatus(status) {
    return status === 429 || status >= 500;
}

function shouldRetryError(error) {
    if (!error) return false;
    const code = String(error.code ?? '').toUpperCase();
    if (RETRYABLE_ERROR_CODES.has(code)) {
        return true;
    }
    if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'TypeError') {
        return true;
    }
    const message = String(error?.message ?? '').toLowerCase();
    return (
        message.includes('timed out') ||
        message.includes('timeout') ||
        message.includes('network error') ||
        message.includes('failed to fetch') ||
        message.includes('connection refused') ||
        message.includes('connection reset') ||
        message.includes('service unavailable') ||
        message.includes('gateway timeout') ||
        message.includes('too many requests') ||
        message.includes('429')
    );
}

async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ipfsRequest({
    config,
    method,
    path,
    body,
    headers = {},
}) {
    const host = normalizeIpfsApiUrl(config.ipfsApiUrl);
    const timeoutMs = normalizeNonNegativeInteger(
        config.ipfsRequestTimeoutMs,
        DEFAULT_IPFS_REQUEST_TIMEOUT_MS
    );
    const maxRetries = normalizeNonNegativeInteger(
        config.ipfsMaxRetries,
        DEFAULT_IPFS_MAX_RETRIES
    );
    const retryDelayMs = normalizeNonNegativeInteger(
        config.ipfsRetryDelayMs,
        DEFAULT_IPFS_RETRY_DELAY_MS
    );

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            const response = await fetch(`${host}${path}`, {
                method,
                headers,
                body,
                signal: AbortSignal.timeout(timeoutMs),
            });
            const text = await response.text();
            if (!response.ok) {
                if (attempt < maxRetries && shouldRetryResponseStatus(response.status)) {
                    await sleep(retryDelayMs);
                    continue;
                }
                throw new Error(
                    `IPFS request failed (${method} ${path}): ${response.status} ${response.statusText} ${text}`
                );
            }
            return text;
        } catch (error) {
            if (attempt < maxRetries && shouldRetryError(error)) {
                await sleep(retryDelayMs);
                continue;
            }
            throw error;
        }
    }

    throw new Error(`IPFS request failed (${method} ${path}) after retries.`);
}

function parseJsonText(text, label) {
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`${label} response was not valid JSON.`);
    }
}

function parseAddResponse(text) {
    const lines = String(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) {
        throw new Error('IPFS add response was empty.');
    }
    return parseJsonText(lines[lines.length - 1], 'IPFS add');
}

function extractCid(payload) {
    if (!payload || typeof payload !== 'object') {
        return undefined;
    }
    if (typeof payload.Hash === 'string' && payload.Hash.trim()) {
        return payload.Hash.trim();
    }
    if (typeof payload.IpfsHash === 'string' && payload.IpfsHash.trim()) {
        return payload.IpfsHash.trim();
    }
    if (typeof payload.cid === 'string' && payload.cid.trim()) {
        return payload.cid.trim();
    }
    if (payload.Cid && typeof payload.Cid === 'object' && typeof payload.Cid['/'] === 'string') {
        return payload.Cid['/'].trim();
    }
    if (payload.cid && typeof payload.cid === 'object' && typeof payload.cid['/'] === 'string') {
        return payload.cid['/'].trim();
    }
    return undefined;
}

async function pinIpfsCid({ config, cid }) {
    if (typeof cid !== 'string' || !cid.trim()) {
        throw new Error('pinIpfsCid requires a non-empty cid.');
    }
    const path = `/api/v0/pin/add?arg=${encodeURIComponent(cid.trim())}`;
    const responseText = await ipfsRequest({
        config,
        method: 'POST',
        path,
        headers: buildRequestHeaders(config.ipfsHeaders),
    });
    return parseJsonText(responseText, 'IPFS pin');
}

async function publishIpfsContent({
    config,
    content,
    json,
    filename,
    mediaType,
    pin = true,
}) {
    const normalizedContent = buildContentString({ content, json });
    const normalizedMediaType = resolveMediaType({ mediaType, json });
    const normalizedFilename = resolveFilename({
        filename,
        mediaType: normalizedMediaType,
    });
    const form = new FormData();
    form.append(
        'file',
        new Blob([normalizedContent], { type: normalizedMediaType }),
        normalizedFilename
    );

    const publishText = await ipfsRequest({
        config,
        method: 'POST',
        path: '/api/v0/add?cid-version=1&pin=false&progress=false',
        body: form,
        headers: buildRequestHeaders(config.ipfsHeaders, { stripContentType: true }),
    });
    const publishResult = parseAddResponse(publishText);
    const cid = extractCid(publishResult);
    if (!cid) {
        throw new Error('IPFS add response did not include a CID.');
    }

    let pinResult = null;
    if (pin !== false) {
        pinResult = await pinIpfsCid({ config, cid });
    }

    return {
        cid,
        uri: `ipfs://${cid}`,
        pinned: pin !== false,
        publishResult,
        pinResult,
    };
}

export { pinIpfsCid, publishIpfsContent };
