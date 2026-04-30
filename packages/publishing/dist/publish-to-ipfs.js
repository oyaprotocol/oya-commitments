import { shouldRetryError } from './ipfs-request-utils.js';
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
    return value.trim();
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
function isHttpPublishError(error) {
    return error instanceof Error && typeof error.status === 'number';
}
function createTimeoutSignal(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
    };
}
function combineAbortSignals(signals) {
    const presentSignals = signals.filter((signal) => signal !== undefined);
    if (presentSignals.length === 0) {
        return {
            signal: undefined,
            cleanup: null,
        };
    }
    if (presentSignals.length === 1) {
        return {
            signal: presentSignals[0],
            cleanup: null,
        };
    }
    if (typeof AbortSignal.any === 'function') {
        return {
            signal: AbortSignal.any(presentSignals),
            cleanup: null,
        };
    }
    const controller = new AbortController();
    const listeners = [];
    for (const signal of presentSignals) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            return {
                signal: controller.signal,
                cleanup: null,
            };
        }
        const listener = () => {
            controller.abort(signal.reason);
        };
        signal.addEventListener('abort', listener, { once: true });
        listeners.push({ signal, listener });
    }
    return {
        signal: controller.signal,
        cleanup: () => {
            for (const { signal, listener } of listeners) {
                signal.removeEventListener('abort', listener);
            }
        },
    };
}
async function invokeWithAbort(createPromise, signal) {
    if (!signal) {
        return await createPromise();
    }
    if (signal.aborted) {
        throw signal.reason ?? new Error('Operation aborted.');
    }
    return await new Promise((resolve, reject) => {
        let settled = false;
        const finishResolve = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const finishReject = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        };
        const onAbort = () => {
            finishReject(signal.reason ?? new Error('Operation aborted.'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        let promise;
        try {
            promise = createPromise();
        }
        catch (error) {
            finishReject(error);
            return;
        }
        promise.then(finishResolve, finishReject);
    });
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
    const trimmedMediaType = mediaType.trim();
    const throwIfCallerAborted = (cause) => {
        if (signal?.aborted) {
            throw new Error('publishToIpfs was aborted by the caller.', { cause });
        }
    };
    const waitForRetryDelay = async () => {
        if (config.retryDelayMs <= 0) {
            return;
        }
        throwIfCallerAborted(signal?.reason);
        await new Promise((resolve) => {
            if (!signal) {
                setTimeout(resolve, config.retryDelayMs);
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
            timer = setTimeout(finish, config.retryDelayMs);
        });
        throwIfCallerAborted(signal?.reason);
    };
    let lastError = null;
    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
        const timeoutSignal = createTimeoutSignal(config.timeoutMs);
        const requestSignal = combineAbortSignals([signal, timeoutSignal.signal]);
        try {
            const { form, contentByteLength } = buildFormData({
                content,
                filename: trimmedFilename,
                mediaType: trimmedMediaType,
            });
            const response = await invokeWithAbort(() => fetch(`${config.apiUrl}/api/v0/add?cid-version=1&pin=true&progress=false`, {
                method: 'POST',
                headers: config.headers,
                body: form,
                signal: requestSignal.signal,
            }), requestSignal.signal);
            const responseText = await invokeWithAbort(() => response.text(), requestSignal.signal);
            if (!response.ok) {
                const httpError = Object.assign(new Error(`IPFS add failed with ${response.status} ${response.statusText || 'Unknown Status'}.`), {
                    status: response.status,
                    responseText,
                });
                if (attempt <= config.maxRetries &&
                    (response.status === 429 || response.status >= 500)) {
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
                pinned: true,
                filename: trimmedFilename,
                mediaType: trimmedMediaType,
                contentByteLength,
                providerSize: extractProviderSize(providerResponse),
                attemptCount: attempt,
                providerResponse,
            };
        }
        catch (error) {
            lastError = error;
            throwIfCallerAborted(error);
            if (attempt <= config.maxRetries &&
                !isHttpPublishError(error) &&
                shouldRetryError(error)) {
                await waitForRetryDelay();
                continue;
            }
            break;
        }
        finally {
            requestSignal.cleanup?.();
            timeoutSignal.cleanup?.();
        }
    }
    throw normalizePublishError(lastError);
}
export { publishToIpfs };
//# sourceMappingURL=publish-to-ipfs.js.map