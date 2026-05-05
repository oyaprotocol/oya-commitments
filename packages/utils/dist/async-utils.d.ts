interface AbortSignalHandle {
    signal: AbortSignal | undefined;
    cleanup: (() => void) | null;
}
declare function createTimeoutSignal(timeoutMs: number): AbortSignalHandle;
declare function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignalHandle;
declare function invokeWithAbort<T>(createPromise: () => Promise<T>, signal: AbortSignal | undefined): Promise<T>;
declare function throwIfSignalAborted(signal: AbortSignal | undefined, message: string, cause: unknown): void;
declare function waitForRetryDelay({ retryDelayMs, signal, abortErrorMessage, }: {
    retryDelayMs: number;
    signal: AbortSignal | undefined;
    abortErrorMessage: string;
}): Promise<void>;
export { combineAbortSignals, createTimeoutSignal, invokeWithAbort, throwIfSignalAborted, waitForRetryDelay, };
export type { AbortSignalHandle };
