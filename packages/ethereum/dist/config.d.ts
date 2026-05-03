export interface CreateEthereumRpcConfigOptions {
    rpcUrl: string;
    headers: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryDelayMs: number;
}
export interface EthereumRpcConfig {
    readonly rpcUrl: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryDelayMs: number;
}
declare function createEthereumRpcConfig({ rpcUrl, headers, timeoutMs, maxRetries, retryDelayMs, }: CreateEthereumRpcConfigOptions): EthereumRpcConfig;
export { createEthereumRpcConfig };
