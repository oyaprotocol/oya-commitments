interface CreateHttpConfigOptions {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
}
interface HttpConfig {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryDelayMs: number;
}
declare function createHttpConfig({ url, headers, timeoutMs, maxRetries, retryDelayMs }: CreateHttpConfigOptions, normalizeConfigUrl?: (url: string) => string): HttpConfig;
export { createHttpConfig };
export type { CreateHttpConfigOptions, HttpConfig };
