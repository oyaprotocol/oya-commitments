import { createServer } from 'node:http';
import { handleSignedMessage, publishAndLogSignedMessage, PublishAndLogSignedMessageError } from '@oyaprotocol/messages';
import { EthereumTransactionReceiptTimeoutError, LogCidError } from '@oyaprotocol/ethereum';

class HttpFailure extends Error {
    constructor(status, body, headers = {}) {
        super(body.code);
        this.status = status;
        this.body = body;
        this.headers = headers;
    }
}

function operationFailure(error, timedOut) {
    const published = error instanceof PublishAndLogSignedMessageError ? error : null;
    const logging = published?.cause instanceof LogCidError ? published.cause : null;
    const cause = logging?.cause ?? error;
    // Node fetch uses TypeError for network failures; other programming faults are internal errors.
    const unexpected = cause instanceof ReferenceError || cause instanceof RangeError ||
        (cause instanceof TypeError && cause.message !== 'fetch failed') || (published && !logging) || !(error instanceof Error);
    const unknown = logging ? Boolean(logging.transactionHash && !logging.receipt) : Boolean(unexpected);
    const receiptTimeout = logging?.cause instanceof EthereumTransactionReceiptTimeoutError;
    const status = unexpected ? 500 : timedOut || receiptTimeout ? 504 : 502;
    return new HttpFailure(status, {
        code: unexpected ? 'internal_error' : timedOut ? 'operation_timeout' : receiptTimeout ? 'receipt_timeout' : 'publication_failed',
        started: true,
        loggingOutcome: unknown ? 'unknown' : logging?.receipt ? 'failed' : 'not_submitted',
        ...(published ? { publication: {
            cid: published.publication.cid, uri: published.publication.uri,
            ...(logging?.transactionHash ? { transactionHash: logging.transactionHash } : {}),
            ...(logging?.receipt ? { blockNumber: logging.receipt.blockNumber.toString() } : {}),
        } } : {}),
    });
}

function respond(response, status, body, headers = {}) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    response.end(JSON.stringify(body));
}

function readBody(request, maxBytes, timeoutMs) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        const cleanup = () => {
            clearTimeout(timer);
            request.off('data', onData);
            request.off('end', onEnd);
            request.off('error', onError);
            request.off('aborted', onAborted);
        };
        const fail = (status, code) => {
            cleanup();
            request.pause();
            reject(new HttpFailure(status, { code }, { connection: 'close' }));
        };
        const onData = (chunk) => {
            size += chunk.length;
            if (size > maxBytes) return fail(413, 'body_too_large');
            chunks.push(chunk);
        };
        const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
        const onError = () => fail(400, 'body_read_failed');
        const onAborted = () => fail(400, 'body_aborted');
        const timer = setTimeout(() => fail(408, 'body_timeout'), timeoutMs);
        request.on('data', onData);
        request.once('end', onEnd);
        request.once('error', onError);
        request.once('aborted', onAborted);
        const length = request.headers['content-length'];
        if (length !== undefined && Number(length) > maxBytes) fail(413, 'body_too_large');
    });
}

export function createNodeServer({ config, transactionPreparer, nodeAddress, fetch = globalThis.fetch,
    log = (record) => console.log(JSON.stringify(record)) }) {
    let active = null;
    let outcomeUnknown = false;
    let stopping = false;
    let closing;
    const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
        // A disconnected upload can emit an error after the body reader has detached.
        request.on('error', () => {});
        let release;
        let timer;
        let outcome;
        try {
            if (request.url === '/healthz' && request.method === 'GET') {
                return respond(response, stopping || outcomeUnknown ? 503 : 200, {
                    status: stopping ? 'shutting_down' : outcomeUnknown ? 'transaction_outcome_unknown' : active ? 'busy' : 'ready',
                    chainId: config.chainId, ledgerContract: config.ledgerContract, nodeAddress, busy: active !== null,
                }, { connection: 'close' });
            }
            if (request.url !== '/v1/messages') {
                return respond(response, 404, { code: 'not_found' }, { connection: 'close' });
            }
            if (request.method !== 'POST') {
                return respond(response, 405, { code: 'method_not_allowed' }, { allow: 'POST', connection: 'close' });
            }
            const body = await readBody(request, config.maxBodyBytes, config.bodyTimeoutMs);
            const result = await handleSignedMessage({ method: request.method, contentType: request.headers['content-type'], body }, {
                authorize: config.authorize, maxBodyBytes: config.maxBodyBytes, maxTextBytes: config.maxTextBytes,
                onAcceptedMessage: async (message) => {
                    // Ingress has already verified the signature and allowlist. No work is queued.
                    const unavailable = stopping ? 'shutting_down' : outcomeUnknown ? 'transaction_outcome_unknown' : active ? 'node_busy' : null;
                    if (unavailable) throw new HttpFailure(503, { code: unavailable, started: false },
                        outcomeUnknown ? {} : { 'retry-after': '5' });
                    active = new Promise((resolve) => { release = resolve; });
                    const controller = new AbortController();
                    timer = setTimeout(() => controller.abort(), config.operationTimeoutMs);
                    let completed;
                    try {
                        completed = await publishAndLogSignedMessage(message, {
                            ipfs: { config: config.ipfs, fetch },
                            ledger: {
                                config: config.rpc, fetch, ledgerContract: config.ledgerContract, nodeAddress,
                                transactionPreparer, timeoutMs: config.receiptTimeoutMs, pollIntervalMs: config.pollIntervalMs,
                            },
                            signal: controller.signal,
                        });
                    } catch (error) {
                        const failure = operationFailure(error, controller.signal.aborted);
                        outcomeUnknown = failure.body.loggingOutcome === 'unknown';
                        throw failure;
                    }
                    return {
                        status: 'logged', cid: completed.publication.cid, uri: completed.publication.uri,
                        transactionHash: completed.logging.transactionHash,
                        blockNumber: completed.logging.receipt.blockNumber.toString(),
                        nodeAddress, ledgerContract: config.ledgerContract,
                    };
                },
            });
            outcome = result.status === 202 ? { status: 200, body: {
                status: 'logged', signer: result.body.signer, publication: result.handleSignedMessageResult,
            } } : result;
        } catch (error) {
            if (error instanceof HttpFailure) {
                outcome = error;
            } else {
                if (release) outcomeUnknown = true;
                outcome = new HttpFailure(500, {
                    code: 'internal_error', ...(release ? { started: true, loggingOutcome: 'unknown' } : {}),
                }, { connection: 'close' });
            }
        }
        try {
            respond(response, outcome.status, outcome.body, {
                ...outcome.headers, ...(stopping ? { connection: 'close' } : {}),
            });
        } finally {
            if (release) {
                clearTimeout(timer);
                // Record only the final public result, including when its client disconnected.
                try { log({ event: 'message_result', httpStatus: outcome.status, ...outcome.body }); } catch {
                    // A failed output sink must not strand the active operation or shutdown.
                }
                active = null;
                release();
            }
        }
    });
    server.requestTimeout = config.bodyTimeoutMs;
    server.headersTimeout = Math.min(config.bodyTimeoutMs, 10_000);
    server.keepAliveTimeout = 5000;
    server.maxConnections = 64;
    return {
        server,
        close() {
            stopping = true;
            closing ??= Promise.all([
                new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
                active,
            ]).then(() => {});
            return closing;
        },
    };
}
