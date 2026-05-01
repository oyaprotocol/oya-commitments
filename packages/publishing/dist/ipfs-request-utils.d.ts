interface AbortSignalHandle {
    signal: AbortSignal | undefined;
    cleanup: (() => void) | null;
}
interface IpfsHttpErrorOptions {
    status: number;
    responseText?: string;
}
declare class IpfsHttpError extends Error {
    readonly status: number;
    readonly responseText: string | undefined;
    constructor(message: string, { status, responseText }: IpfsHttpErrorOptions);
}
declare function isIpfsHttpError(error: unknown): error is IpfsHttpError;
declare function shouldRetryError(error: unknown): boolean;
declare function createTimeoutSignal(timeoutMs: number): AbortSignalHandle;
declare function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignalHandle;
declare function invokeWithAbort<T>(createPromise: () => Promise<T>, signal: AbortSignal | undefined): Promise<T>;
declare function throwIfSignalAborted(signal: AbortSignal | undefined, message: string, cause: unknown): void;
declare function waitForRetryDelay({ retryDelayMs, signal, abortErrorMessage, }: {
    retryDelayMs: number;
    signal: AbortSignal | undefined;
    abortErrorMessage: string;
}): Promise<void>;
export { combineAbortSignals, createTimeoutSignal, invokeWithAbort, IpfsHttpError, isIpfsHttpError, shouldRetryError, throwIfSignalAborted, waitForRetryDelay, };
export type { AbortSignalHandle };
