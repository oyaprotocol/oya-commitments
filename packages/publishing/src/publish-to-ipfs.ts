import type { IpfsPublishConfig } from './ipfs-publish-config.js';

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

export type PublishableContent = string | Uint8Array | ArrayBuffer | Blob;

export interface FetchRequestOptions {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: FormData;
    signal?: AbortSignal | undefined;
}

export interface FetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
}

export interface FetchLike {
    (url: string, options: FetchRequestOptions): Promise<FetchResponse>;
}

export interface PublishToIpfsOptions {
    config: IpfsPublishConfig;
    fetch: FetchLike;
    content: PublishableContent;
    filename: string;
    mediaType: string;
    signal?: AbortSignal;
}

export interface PublishToIpfsResult {
    cid: string;
    uri: string;
    filename: string;
    mediaType: string;
    contentByteLength: number;
    providerSize: number | null;
    attemptCount: number;
    providerResponse: unknown;
}

interface TimeoutSignalHandle {
    signal: AbortSignal;
    cleanup: (() => void) | null;
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
    filename,
    mediaType,
}: {
    content: unknown;
    filename: string;
    mediaType: string;
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

function readErrorStringChain(error: unknown, key: string): string[] {
    const values: string[] = [];
    let current: unknown = error;
    while (current && typeof current === 'object') {
        const value = (current as Record<string, unknown>)[key];
        if (typeof value === 'string' && value) {
            values.push(value);
        }
        current = (current as Record<string, unknown>).cause;
    }
    return values;
}

function shouldRetryError(error: unknown): boolean {
    if (!error) {
        return false;
    }
    const names = readErrorStringChain(error, 'name');
    if (names.includes('TimeoutError')) {
        return true;
    }
    const codes = readErrorStringChain(error, 'code');
    for (const code of codes) {
        if (RETRYABLE_ERROR_CODES.has(code.toUpperCase())) {
            return true;
        }
    }
    const message = readErrorStringChain(error, 'message').join(' ').toLowerCase();
    return (
        message.includes('fetch failed') ||
        message.includes('failed to fetch') ||
        message.includes('network error') ||
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('connection refused') ||
        message.includes('connection reset')
    );
}

function createTimeoutSignal(timeoutMs: number): TimeoutSignalHandle {
    if (typeof AbortSignal.timeout === 'function') {
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

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
    const presentSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    if (presentSignals.length === 0) {
        return undefined;
    }
    if (presentSignals.length === 1) {
        return presentSignals[0];
    }
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any(presentSignals);
    }
    const controller = new AbortController();
    for (const signal of presentSignals) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            return controller.signal;
        }
        signal.addEventListener(
            'abort',
            () => {
                controller.abort(signal.reason);
            },
            { once: true }
        );
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
}: PublishToIpfsOptions): Promise<PublishToIpfsResult> {
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
    const throwIfCallerAborted = (cause: unknown): void => {
        if (signal?.aborted) {
            throw new Error('publishToIpfs was aborted by the caller.', { cause });
        }
    };
    const waitForRetryDelay = async (): Promise<void> => {
        if (resolvedConfig.retryDelayMs <= 0) {
            return;
        }
        throwIfCallerAborted(signal?.reason);
        await new Promise<void>((resolve) => {
            if (!signal) {
                setTimeout(resolve, resolvedConfig.retryDelayMs);
                return;
            }

            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
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

    let lastError: unknown = null;

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
                ) as Error & { status?: number; responseText?: string };
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
