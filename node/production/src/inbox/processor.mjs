import { publishSignedMessage } from '@oyaprotocol/messages';
import { createTransactionPreparer, decodeLedgerEvent, encodeLedgerCall, ethGetTransactionReceipt,
    ethSendRawTransaction, ethWaitForTransactionReceipt, requestEthereumJsonRpc } from '@oyaprotocol/ethereum';
import { hasBytecode } from '../bytecode.mjs';
import { executionIdentity, validateJob, validateTransaction } from './protocol.mjs';

export async function checkLedger(config, fetch = globalThis.fetch, signal) {
    const rpc = async (method, params = []) => (await requestEthereumJsonRpc({ config: config.rpc, fetch, method, params, signal })).result;
    if (BigInt(await rpc('eth_chainId')) !== BigInt(config.chainId) ||
        !hasBytecode(await rpc('eth_getCode', [config.ledgerContract, 'latest']))) throw new Error('Ledger configuration mismatch.');
}

export async function processWork({ work, config, target, allowedSigners, signer, save,
    fetch = globalThis.fetch, signal, log = () => {} }) {
    await validateJob(work.job, { target, allowedSigners, maxTextBytes: config.maxTextBytes, checkExpiry: false });
    signal?.throwIfAborted();
    const identity = executionIdentity(config, signer?.address);
    let { cid, transaction } = work.checkpoint;
    if (!cid) {
        const publication = await publishSignedMessage(work.job.message, { config: config.ipfs, fetch, signal });
        cid = publication.cid;
        await save({ cid });
        log({ event: 'ipfs_published', requestId: work.requestId, cid });
    }
    if (config.mode === 'ipfs') return { status: 'published', cid };
    await checkLedger(config, fetch, signal);
    if (!transaction) {
        const prepare = createTransactionPreparer({ config: config.rpc, fetch, chainId: config.chainId, signer, limits: config.limits });
        const prepared = await prepare({ to: config.ledgerContract, data: encodeLedgerCall(cid), value: 0n, signal });
        transaction = { rawTransaction: prepared.rawTransaction, transactionHash: prepared.transactionHash };
        // Only a durable, acknowledged checkpoint permits a subsequent broadcast.
        await save({ transaction });
    }
    validateTransaction(transaction, cid, identity, config.limits);
    const receiptOptions = { config: config.rpc, fetch, transactionHash: transaction.transactionHash, signal };
    let { receipt } = await ethGetTransactionReceipt(receiptOptions);
    if (!receipt) {
        signal?.throwIfAborted();
        try { await ethSendRawTransaction({ ...receiptOptions, rawTransaction: transaction.rawTransaction }); }
        catch {
            // Duplicate, timeout and nonce errors are not proof of failure. Reconcile the known hash.
            signal?.throwIfAborted();
        }
        log({ event: 'ledger_pending', requestId: work.requestId, cid, transactionHash: transaction.transactionHash });
        ({ receipt } = await ethWaitForTransactionReceipt({ ...receiptOptions,
            timeoutMs: config.receiptTimeoutMs, pollIntervalMs: config.pollIntervalMs }));
    }
    if (receipt.status === 'reverted') return { status: 'failed', cid, transactionHash: transaction.transactionHash, error: 'transaction_reverted' };
    if (receipt.status !== 'success' || !receipt.logs.map(entry => decodeLedgerEvent(entry, config.ledgerContract)).some(event =>
        event && !event.removed && event.cid === cid && event.node.toLowerCase() === signer.address.toLowerCase())) {
        throw new Error('Ledger receipt could not be verified.');
    }
    return { status: 'logged', cid, transactionHash: transaction.transactionHash };
}
