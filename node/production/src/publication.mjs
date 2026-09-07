import { publishSignedMessage } from '@oyaprotocol/messages';
import {
    createTransactionPreparer, decodeLoggerEvent, ethGetTransactionReceipt,
    ethWaitForTransactionReceipt, logCid,
} from '@oyaprotocol/ethereum';
import { messageId } from './store.mjs';

export class PublicationUnavailable extends Error {
    constructor(code, record) {
        super(code);
        this.code = code;
        this.record = record;
    }
}

export function publicRecord(record) {
    return {
        messageId: record.id,
        status: record.result ? 'logged' : 'pending',
        ...(record.cid ? { cid: record.cid, uri: `ipfs://${record.cid}` } : {}),
        ...(record.signed ? { transactionHash: record.signed.transactionHash } : {}),
        ...record.result,
    };
}

export function createPublisher({ config, signer, store, fetch: transport = globalThis.fetch }) {
    const prepare = createTransactionPreparer({
        config: config.rpc, fetch: transport, chainId: config.chainId, signer, limits: config.limits,
    });
    let active = null;
    let idle = Promise.resolve();
    let unfinished = [...store.records.values()].find((record) => !record.result) ?? null;
    if ([...store.records.values()].filter((record) => !record.result).length > 1) {
        throw new Error('Multiple unfinished records require operator reconciliation.');
    }
    const processMessage = async (message) => {
        const id = messageId(message);
        let record = store.records.get(id);
        if (record?.result) return publicRecord(record);
        if (active) throw new PublicationUnavailable('node_busy', record);
        if (unfinished && unfinished.id !== id) throw new PublicationUnavailable('recovery_required', unfinished);
        // Set the guard before the first await, spanning publication through receipt and persistence.
        active = id;
        let resolveIdle;
        idle = new Promise((resolve) => { resolveIdle = resolve; });
        record ??= { id, message, createdAt: new Date().toISOString() };
        unfinished = record;
        try {
            await store.save(record);
            if (!record.cid) {
                const publication = await publishSignedMessage(record.message, { config: config.ipfs, fetch: transport });
                record = { ...record, cid: publication.cid };
                unfinished = record;
                await store.save(record);
            }
            const loggerOptions = {
                config: config.rpc, fetch: transport, loggerContract: config.loggerContract,
                nodeAddress: signer.address, timeoutMs: config.receiptTimeoutMs, pollIntervalMs: config.pollIntervalMs,
                transactionPreparer: async (request) => {
                    if (record.signed) return record.signed;
                    const signed = await prepare(request);
                    record = { ...record, signed };
                    unfinished = record;
                    // The kernel cannot broadcast until the signed bytes are durable.
                    await store.save(record);
                    return signed;
                },
            };
            const checkReceipt = (receipt) => {
                if (receipt.status !== 'success') throw new Error('Logger transaction did not succeed.');
                const event = receipt.logs.map((log) => decodeLoggerEvent(log, config.loggerContract)).find((entry) =>
                    entry && entry.removed !== true && entry.cid === record.cid &&
                    entry.node.toLowerCase() === signer.address.toLowerCase());
                if (!event) throw new Error('Receipt has no matching Logger event.');
                return { receipt, event };
            };
            // A restart may find a transaction already mined. Do not rebroadcast it.
            const observed = record.signed ? await ethGetTransactionReceipt({
                config: config.rpc, fetch: transport, transactionHash: record.signed.transactionHash,
            }) : null;
            let logging;
            if (observed?.receipt) {
                logging = checkReceipt(observed.receipt);
            } else {
                try { logging = await logCid(record.cid, loggerOptions); } catch (error) {
                    if (!record.signed) throw error;
                    // Includes already-known / nonce-too-low races on exact-byte rebroadcast.
                    const { receipt } = await ethWaitForTransactionReceipt({
                        config: config.rpc, fetch: transport, transactionHash: record.signed.transactionHash,
                        timeoutMs: config.receiptTimeoutMs, pollIntervalMs: config.pollIntervalMs,
                    });
                    logging = checkReceipt(receipt);
                }
            }
            record = {
                ...record, result: {
                    blockNumber: logging.receipt.blockNumber.toString(),
                    nodeAddress: logging.event.node, loggerContract: config.loggerContract,
                },
            };
            await store.save(record);
            unfinished = null;
            return publicRecord(record);
        } catch {
            // Keep partial progress; provider error messages can contain credentials.
            throw new PublicationUnavailable('publication_incomplete', unfinished);
        } finally {
            active = null;
            resolveIdle();
        }
    };
    return {
        publish: processMessage,
        status: () => ({ busy: active !== null, pendingMessageId: unfinished?.id ?? null }),
        waitForIdle: () => idle,
        async recover() {
            if (unfinished) return await processMessage(unfinished.message);
        },
    };
}
