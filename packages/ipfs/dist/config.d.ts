export interface CreateIpfsConfigOptions {
    apiUrl: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
}
export interface IpfsConfig {
    readonly apiUrl: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryDelayMs: number;
}
declare function createIpfsConfig({ apiUrl, headers, timeoutMs, maxRetries, retryDelayMs, }: CreateIpfsConfigOptions): IpfsConfig;
export { createIpfsConfig };
