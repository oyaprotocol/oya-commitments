import {
    EthereumTransactionReceiptTimeoutError,
    ethGetTransactionReceipt,
    ethWaitForTransactionReceipt,
} from '@oyaprotocol/ethereum';
import type {
    EthGetTransactionReceiptOptions,
    EthGetTransactionReceiptResult,
    EthWaitForTransactionReceiptOptions,
    EthWaitForTransactionReceiptResult,
    EthereumReceiptLog,
    EthereumTransactionReceipt,
} from '@oyaprotocol/ethereum';

declare const lookupOptions: EthGetTransactionReceiptOptions;
const lookup: Promise<EthGetTransactionReceiptResult> = ethGetTransactionReceipt(lookupOptions);
lookup.then(({ receipt }) => {
    // @ts-expect-error A lookup can return null until a receipt is available.
    const mined: EthereumTransactionReceipt = receipt;
    if (receipt !== null) {
        const blockNumber: bigint = receipt.blockNumber;
        const status: 'success' | 'reverted' | null = receipt.status;
        const logs: readonly EthereumReceiptLog[] = receipt.logs;
        // @ts-expect-error Quantities cannot be narrowed to imprecise numbers.
        const gas: number = receipt.gasUsed;
        // @ts-expect-error Receipt data is readonly to consumers.
        receipt.status = 'success';
        void [blockNumber, status, logs, gas];
    }
    void mined;
});

const waitOptions: EthWaitForTransactionReceiptOptions = {
    ...lookupOptions,
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
};
const wait: Promise<EthWaitForTransactionReceiptResult> = ethWaitForTransactionReceipt(waitOptions);
wait.then(({ receipt, pollCount, attemptCount, response }) => {
    const mined: EthereumTransactionReceipt = receipt;
    const polls: number = pollCount;
    const attempts: number = attemptCount;
    const raw: unknown = response;
    void [mined, polls, attempts, raw];
});

// @ts-expect-error Waiting requires an explicit deadline and interval.
ethWaitForTransactionReceipt(lookupOptions);

declare const error: unknown;
if (error instanceof EthereumTransactionReceiptTimeoutError) {
    const hash: string = error.transactionHash;
    const timeoutMs: number = error.timeoutMs;
    const polls: number = error.pollCount;
    void [hash, timeoutMs, polls];
}
