const RETRYABLE_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
]);

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

function buildFormData({ content, filename, mediaType }) {
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
    } catch {
        throw new Error('IPFS add response was not valid JSON.');
    }
}

function extractCid(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
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
    return null;
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

function shouldRetryError(error) {
    if (!error) {
        return false;
    }
    if (error.name === 'TimeoutError' || error.name === 'TypeError') {
        return true;
    }
    const code = String(error.code ?? '').toUpperCase();
    if (RETRYABLE_ERROR_CODES.has(code)) {
        return true;
    }
    const message = String(error.message ?? '').toLowerCase();
    return (
        message.includes('failed to fetch') ||
        message.includes('network error') ||
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('connection refused') ||
        message.includes('connection reset')
    );
}

function createTimeoutSignal(timeoutMs) {
    if (typeof AbortSignal?.timeout === 'function') {
        return {
            signal: AbortSignal.timeout(timeoutMs),
            cleanup: null,
        };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
    };
}

function combineAbortSignals(signals) {
    const presentSignals = signals.filter(Boolean);
    if (presentSignals.length === 0) {
        return undefined;
    }
    if (presentSignals.length === 1) {
        return presentSignals[0];
    }
    if (typeof AbortSignal?.any === 'function') {
        return AbortSignal.any(presentSignals);
    }
    const controller = new AbortController();
    const abort = (event) => {
        controller.abort(event?.target?.reason);
    };
    for (const signal of presentSignals) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            return controller.signal;
        }
        signal.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
}

async function publishToIpfs({
    config,
    fetch,
    content,
    filename,
    mediaType,
    signal,
} = {}) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('config must be an object.');
    }
    if (typeof fetch !== 'function') {
        throw new Error('fetch must be provided as a function.');
    }
    const resolvedConfig = config;
    const resolvedFetch = fetch;
    if (typeof filename !== 'string' || !filename.trim()) {
        throw new Error('filename must be a non-empty string.');
    }
    if (typeof mediaType !== 'string' || !mediaType.trim()) {
        throw new Error('mediaType must be a non-empty string.');
    }
    const resolvedFilename = filename.trim();
    const resolvedMediaType = mediaType.trim();
    const throwIfCallerAborted = (cause) => {
        if (signal?.aborted) {
            throw new Error('publishToIpfs was aborted by the caller.', { cause });
        }
    };
    const waitForRetryDelay = async () => {
        if (resolvedConfig.retryDelayMs <= 0) {
            return;
        }
        throwIfCallerAborted(signal?.reason);
        await new Promise((resolve) => {
            if (!signal) {
                setTimeout(resolve, resolvedConfig.retryDelayMs);
                return;
            }

            let settled = false;
            let timer = null;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer !== null) {
                    clearTimeout(timer);
                }
                signal.removeEventListener('abort', finish);
                resolve();
            };

            signal.addEventListener('abort', finish, { once: true });
            if (signal.aborted) {
                finish();
                return;
            }
            timer = setTimeout(finish, resolvedConfig.retryDelayMs);
        });
        throwIfCallerAborted(signal?.reason);
    };

    let lastError = null;

    for (let attempt = 1; attempt <= resolvedConfig.maxRetries + 1; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(resolvedConfig.timeoutMs);
        try {
            const { form, contentByteLength } = buildFormData({
                content,
                filename: resolvedFilename,
                mediaType: resolvedMediaType,
            });
            const response = await resolvedFetch(
                `${resolvedConfig.apiUrl}/api/v0/add?cid-version=1&pin=false&progress=false`,
                {
                    method: 'POST',
                    headers: resolvedConfig.headers,
                    body: form,
                    signal: combineAbortSignals([signal, timeoutSignal.signal]),
                }
            );
            const responseText = await response.text();

            if (!response.ok) {
                const httpError = new Error(
                    `IPFS add failed with ${response.status} ${response.statusText || 'Unknown Status'}.`
                );
                httpError.status = response.status;
                httpError.responseText = responseText;
                if (
                    attempt <= resolvedConfig.maxRetries &&
                    (response.status === 429 || response.status >= 500)
                ) {
                    await waitForRetryDelay();
                    continue;
                }
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
                filename: resolvedFilename,
                mediaType: resolvedMediaType,
                contentByteLength,
                providerSize: extractProviderSize(providerResponse),
                attemptCount: attempt,
                providerResponse,
            };
        } catch (error) {
            lastError = error;
            throwIfCallerAborted(error);
            if (attempt <= resolvedConfig.maxRetries && shouldRetryError(error)) {
                await waitForRetryDelay();
                continue;
            }
            break;
        } finally {
            timeoutSignal.cleanup?.();
        }
    }

    throw lastError ?? new Error('IPFS publish failed.');
}

export { publishToIpfs };
