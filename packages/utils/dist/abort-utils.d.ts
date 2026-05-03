interface AbortSignalHandle {
    signal: AbortSignal | undefined;
    cleanup: (() => void) | null;
}
declare function createTimeoutSignal(timeoutMs: number): AbortSignalHandle;
declare function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignalHandle;
declare function invokeWithAbort<T>(createPromise: () => Promise<T>, signal: AbortSignal | undefined): Promise<T>;
declare function throwIfSignalAborted(signal: AbortSignal | undefined, message: string, cause: unknown): void;
export { combineAbortSignals, createTimeoutSignal, invokeWithAbort, throwIfSignalAborted, };
export type { AbortSignalHandle };
