interface EthereumReceiptLog {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly blockHash: string;
    readonly blockNumber: bigint;
    readonly transactionHash: string;
    readonly transactionIndex: bigint;
    readonly logIndex: bigint;
    readonly removed?: boolean;
    readonly blockTimestamp?: bigint;
}
interface EthereumTransactionReceipt {
    readonly transactionHash: string;
    readonly transactionIndex: bigint;
    readonly blockHash: string;
    readonly blockNumber: bigint;
    readonly from: string;
    readonly to: string | null;
    readonly contractAddress: string | null;
    readonly cumulativeGasUsed: bigint;
    readonly gasUsed: bigint;
    readonly logs: readonly EthereumReceiptLog[];
    readonly logsBloom: string;
    /** Null only for historical receipts that provide a state root instead. */
    readonly status: 'success' | 'reverted' | null;
    readonly root?: string;
    readonly type?: bigint;
    readonly effectiveGasPrice?: bigint;
    readonly blobGasUsed?: bigint;
    readonly blobGasPrice?: bigint;
}
declare function parseTransactionReceipt(value: unknown, transactionHash: string): EthereumTransactionReceipt;
export { parseTransactionReceipt };
export type { EthereumReceiptLog, EthereumTransactionReceipt };
