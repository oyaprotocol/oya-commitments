import { isPlainObject, parseBytes } from '@oyaprotocol/utils';

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

function parseQuantity(value: unknown, name: string): bigint {
    if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
        throw new Error(`${name} must be an Ethereum quantity hex string without leading zeros.`);
    }
    return BigInt(value);
}

function assertMatchingHash(actual: string, expected: string, name: string): void {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`${name} did not match the expected hash.`);
    }
}

function parseReceiptLog(
    value: unknown,
    index: number,
    receipt: Pick<EthereumTransactionReceipt, 'transactionHash' | 'transactionIndex' | 'blockHash' | 'blockNumber'>
): EthereumReceiptLog {
    const name = `receipt.logs[${index}]`;
    if (!isPlainObject(value)) {
        throw new Error(`${name} must be a plain object.`);
    }
    if (!Array.isArray(value.topics) || value.topics.length > 4) {
        throw new Error(`${name}.topics must be an array of at most four topics.`);
    }
    if (value.removed !== undefined && typeof value.removed !== 'boolean') {
        throw new Error(`${name}.removed must be a boolean.`);
    }
    const log: EthereumReceiptLog = {
        address: parseBytes(value.address, `${name}.address`, 20),
        topics: value.topics.map((topic, topicIndex) =>
            parseBytes(topic, `${name}.topics[${topicIndex}]`, 32)
        ),
        data: parseBytes(value.data, `${name}.data`),
        blockHash: parseBytes(value.blockHash, `${name}.blockHash`, 32),
        blockNumber: parseQuantity(value.blockNumber, `${name}.blockNumber`),
        transactionHash: parseBytes(value.transactionHash, `${name}.transactionHash`, 32),
        transactionIndex: parseQuantity(value.transactionIndex, `${name}.transactionIndex`),
        logIndex: parseQuantity(value.logIndex, `${name}.logIndex`),
        ...(value.removed === undefined ? {} : { removed: value.removed }),
        ...(value.blockTimestamp === undefined ? {} : {
            blockTimestamp: parseQuantity(value.blockTimestamp, `${name}.blockTimestamp`),
        }),
    };
    assertMatchingHash(log.transactionHash, receipt.transactionHash, `${name}.transactionHash`);
    assertMatchingHash(log.blockHash, receipt.blockHash, `${name}.blockHash`);
    if (log.blockNumber !== receipt.blockNumber || log.transactionIndex !== receipt.transactionIndex) {
        throw new Error(`${name} blockNumber or transactionIndex did not match the receipt.`);
    }
    return log;
}

function parseTransactionReceipt(value: unknown, transactionHash: string): EthereumTransactionReceipt {
    if (!isPlainObject(value)) {
        throw new Error('eth_getTransactionReceipt result must be a receipt object or null.');
    }
    const returnedHash = parseBytes(value.transactionHash, 'receipt.transactionHash', 32);
    assertMatchingHash(returnedHash, transactionHash, 'receipt.transactionHash');
    if (!Array.isArray(value.logs)) {
        throw new Error('receipt.logs must be an array.');
    }
    let status: EthereumTransactionReceipt['status'] = null;
    if (value.status === '0x1') {
        status = 'success';
    } else if (value.status === '0x0') {
        status = 'reverted';
    } else if (value.status !== undefined || value.root === undefined) {
        throw new Error('receipt.status must be 0x0 or 0x1, or absent with a historical receipt.root.');
    }
    const location = {
        transactionHash: returnedHash,
        transactionIndex: parseQuantity(value.transactionIndex, 'receipt.transactionIndex'),
        blockHash: parseBytes(value.blockHash, 'receipt.blockHash', 32),
        blockNumber: parseQuantity(value.blockNumber, 'receipt.blockNumber'),
    };
    const type = value.type === undefined ? undefined : parseQuantity(value.type, 'receipt.type');
    if (type !== undefined && type > 255n) {
        throw new Error('receipt.type must fit in one byte.');
    }
    return {
        ...location,
        from: parseBytes(value.from, 'receipt.from', 20),
        to: value.to === null ? null : parseBytes(value.to, 'receipt.to', 20),
        contractAddress: value.contractAddress === null
            ? null
            : parseBytes(value.contractAddress, 'receipt.contractAddress', 20),
        cumulativeGasUsed: parseQuantity(value.cumulativeGasUsed, 'receipt.cumulativeGasUsed'),
        gasUsed: parseQuantity(value.gasUsed, 'receipt.gasUsed'),
        logs: value.logs.map((log, index) => parseReceiptLog(log, index, location)),
        logsBloom: parseBytes(value.logsBloom, 'receipt.logsBloom', 256),
        status,
        ...(value.root === undefined ? {} : { root: parseBytes(value.root, 'receipt.root', 32) }),
        ...(type === undefined ? {} : { type }),
        ...(value.effectiveGasPrice === undefined ? {} : {
            effectiveGasPrice: parseQuantity(value.effectiveGasPrice, 'receipt.effectiveGasPrice'),
        }),
        ...(value.blobGasUsed === undefined ? {} : {
            blobGasUsed: parseQuantity(value.blobGasUsed, 'receipt.blobGasUsed'),
        }),
        ...(value.blobGasPrice === undefined ? {} : {
            blobGasPrice: parseQuantity(value.blobGasPrice, 'receipt.blobGasPrice'),
        }),
    };
}

export { parseTransactionReceipt };
export type { EthereumReceiptLog, EthereumTransactionReceipt };
