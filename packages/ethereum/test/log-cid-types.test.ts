import { logCid, LogCidError } from '@oyaprotocol/ethereum';
import type {
    LogCidOptions, LogCidResult, PrepareLoggerTransaction,
    PreparedLoggerTransaction, LoggerTransactionRequest, LogCidStage,
} from '@oyaprotocol/ethereum';

declare const cid: string;
declare const options: LogCidOptions;
declare const prepared: PreparedLoggerTransaction;
declare const failure: LogCidError;

const prepare: PrepareLoggerTransaction = (request: LoggerTransactionRequest) => {
    const value: 0n = request.value;
    const to: string = request.to;
    const data: string = request.data;
    const signal: AbortSignal | undefined = request.signal;
    // @ts-expect-error The call request is immutable.
    request.data = '0x';
    void [value, to, data, signal];
    return prepared;
};
const asyncPrepare: PrepareLoggerTransaction = async () => prepared;
const result: Promise<LogCidResult> = logCid(cid, { ...options, prepareTransaction: prepare });
const hash: string | null = failure.transactionHash;
const stage: LogCidStage = failure.stage;

// @ts-expect-error The host must return the hash along with the signed bytes.
const incompletePrepare: PrepareLoggerTransaction = () => ({ rawTransaction: '0x02abcd' });
// @ts-expect-error Logger submission requires explicit preparation/signing.
logCid(cid, { config: options.config, fetch: options.fetch, loggerAddress: options.loggerAddress, expectedNode: options.expectedNode, timeoutMs: 1000, pollIntervalMs: 1 });
// @ts-expect-error No implicit expected node is inferred from the message signer.
logCid(cid, { config: options.config, fetch: options.fetch, loggerAddress: options.loggerAddress, prepareTransaction: prepare, timeoutMs: 1000, pollIntervalMs: 1 });
void [asyncPrepare, incompletePrepare, result, hash, stage];
