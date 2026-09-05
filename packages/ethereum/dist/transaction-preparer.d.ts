import type { HttpConfig, HttpPostFetchLike } from '@oyaprotocol/utils';
import type { TransactionPreparer, TransactionSigner } from './transactions.js';
interface CreateTransactionPreparerOptions {
    config: HttpConfig;
    fetch: HttpPostFetchLike<string>;
    chainId: bigint;
    signer: TransactionSigner;
    /** Whole percent added to the estimate, rounded up. Default: 20. */
    gasLimitMarginPercent?: number;
    /** Integer multiplier for the latest base fee. Default: 2. */
    baseFeeMultiplier?: number;
    /** Exceeding either optional ceiling rejects before signing. */
    limits?: {
        gasLimit?: bigint;
        feePerGas?: bigint;
    };
    /** Overall preparation deadline, including signing. Default: 30,000 ms. */
    timeoutMs?: number;
    /** JSON-RPC ID for preparation reads. Default: 1. */
    id?: string | number;
}
/** Prepare direct account calls; the host coordinates nonces through submission. */
declare function createTransactionPreparer({ config, fetch, chainId, signer, gasLimitMarginPercent, baseFeeMultiplier, limits, timeoutMs, id, }: CreateTransactionPreparerOptions): TransactionPreparer;
export { createTransactionPreparer };
export type { CreateTransactionPreparerOptions };
