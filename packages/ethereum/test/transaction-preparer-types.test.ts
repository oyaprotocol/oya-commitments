import { createTransactionPreparer, logCid } from '@oyaprotocol/ethereum';
import type {
    CreateTransactionPreparerOptions, SignedTransaction, TransactionPreparer,
    TransactionRequest, TransactionSigner, UnsignedTransaction, LogCidOptions,
} from '@oyaprotocol/ethereum';

declare const options: CreateTransactionPreparerOptions;
declare const signed: SignedTransaction;
declare const request: TransactionRequest;
declare const loggerOptions: LogCidOptions;

const signer: TransactionSigner = {
    address: '0x1111111111111111111111111111111111111111',
    signTransaction(transaction, signal) {
        const fields: readonly [2, bigint, number, bigint, bigint, bigint] = [
            transaction.type, transaction.chainId, transaction.nonce, transaction.gasLimit,
            transaction.maxFeePerGas, transaction.maxPriorityFeePerGas,
        ];
        const cancellation: AbortSignal | undefined = signal;
        // @ts-expect-error Signing must preserve the supplied fields.
        transaction.to = '0x';
        // @ts-expect-error Cancellation is passed separately from transaction fields.
        transaction.signal;
        void [fields, cancellation];
        return signed;
    },
};
const asynchronousSigner: TransactionSigner = { ...signer, signTransaction: async () => signed };
const preparer: TransactionPreparer = createTransactionPreparer({
    ...options, signer, chainId: 1n, gasLimitMarginPercent: 20, baseFeeMultiplier: 2,
    limits: { gasLimit: 100_000n, feePerGas: 30_000_000_000n }, timeoutMs: 30_000, id: 'prepare',
});
const result: SignedTransaction = await preparer(request);
const logging = logCid('cid', { ...loggerOptions, transactionPreparer: preparer });
declare const transaction: UnsignedTransaction;
const call: Omit<TransactionRequest, 'signal'> = transaction;
// @ts-expect-error Chain IDs use bigint to preserve precision.
createTransactionPreparer({ ...options, chainId: 1 });
// @ts-expect-error A signing adapter must provide its address and signing method.
createTransactionPreparer({ ...options, signer: { address: signer.address } });
// @ts-expect-error Fee limits are denominated in integer wei.
createTransactionPreparer({ ...options, limits: { feePerGas: 10 } });
void [asynchronousSigner, result, logging, call];
