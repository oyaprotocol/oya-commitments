import type { IpfsConfig } from './ipfs-config.js';
import { shouldRetryError } from './ipfs-request-utils.js';

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

interface AbortSignalHandle {
    signal: AbortSignal | undefined;
    cleanup: (() => void) | null;
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

function createTimeoutSignal(timeoutMs: number): AbortSignalHandle {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
    };
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignalHandle {
    const presentSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
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
    const listeners: Array<{ signal: AbortSignal; listener: EventListener }> = [];
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

async function invokeWithAbort<T>(
    createPromise: () => Promise<T>,
    signal: AbortSignal | undefined
): Promise<T> {
    if (!signal) {
        return await createPromise();
    }
    if (signal.aborted) {
        throw signal.reason ?? new Error('Operation aborted.');
    }
    return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const finishResolve = (value: T) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const finishReject = (error: unknown) => {
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
        let promise: Promise<T>;
        try {
            promise = createPromise();
        } catch (error) {
            finishReject(error);
            return;
        }
        promise.then(finishResolve, finishReject);
    });
}

function cancelReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    reason: unknown
): void {
    reader.cancel(reason).catch(() => {});
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
    const throwIfCallerAborted = (cause: unknown): void => {
        if (signal?.aborted) {
            throw new Error('readIpfsText was aborted by the caller.', { cause });
        }
    };
    const waitForRetryDelay = async (): Promise<void> => {
        if (config.retryDelayMs <= 0) {
            return;
        }
        throwIfCallerAborted(signal?.reason);
        await new Promise<void>((resolve) => {
            if (!signal) {
                setTimeout(resolve, config.retryDelayMs);
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
            timer = setTimeout(finish, config.retryDelayMs);
        });
        throwIfCallerAborted(signal?.reason);
    };

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
                if (
                    attempt <= config.maxRetries &&
                    (response.status === 429 || response.status >= 500)
                ) {
                    await waitForRetryDelay();
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
            throwIfCallerAborted(error);
            if (
                attempt <= config.maxRetries &&
                !isHttpReadError(error) &&
                shouldRetryError(error)
            ) {
                await waitForRetryDelay();
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
