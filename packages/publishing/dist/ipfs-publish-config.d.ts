export interface CreateIpfsPublishConfigOptions {
    apiUrl: string;
    headers: Record<string, unknown>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
}
export interface IpfsPublishConfig {
    readonly apiUrl: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryDelayMs: number;
}
declare function createIpfsPublishConfig({ apiUrl, headers, timeoutMs, maxRetries, retryDelayMs, }: CreateIpfsPublishConfigOptions): IpfsPublishConfig;
export { createIpfsPublishConfig };
