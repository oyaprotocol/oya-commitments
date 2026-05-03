declare function waitForRetryDelay({ retryDelayMs, signal, abortErrorMessage, }: {
    retryDelayMs: number;
    signal: AbortSignal | undefined;
    abortErrorMessage: string;
}): Promise<void>;
export { waitForRetryDelay };
