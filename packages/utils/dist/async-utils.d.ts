interface AbortSignalHandle {
    signal: AbortSignal | undefined;
    cleanup: (() => void) | null;
}
interface RunWithRetryAttemptContext {
    attempt: number;
    signal: AbortSignal | undefined;
}
interface RunWithRetryOptions<TResult> {
    maxRetries: number;
    retryDelayMs: number;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    abortErrorMessage: string;
    shouldRetry(error: unknown): boolean;
    normalizeError(error: unknown): Error;
    run(context: RunWithRetryAttemptContext): Promise<TResult>;
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
declare function runWithRetry<TResult>({ maxRetries, retryDelayMs, timeoutMs, signal, abortErrorMessage, shouldRetry, normalizeError, run, }: RunWithRetryOptions<TResult>): Promise<TResult>;
export { combineAbortSignals, createTimeoutSignal, invokeWithAbort, runWithRetry, throwIfSignalAborted, waitForRetryDelay, };
export type { AbortSignalHandle, RunWithRetryAttemptContext, RunWithRetryOptions, };
