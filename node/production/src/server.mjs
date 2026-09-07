import { createServer } from 'node:http';
import { handleSignedMessage } from '@oyaprotocol/messages';
import { PublicationUnavailable, publicRecord } from './publication.mjs';

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
            reject(Object.assign(new Error(code), { status, code }));
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

export function createNodeServer({ config, publisher, nodeAddress }) {
    const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
        // A disconnected upload can emit an error after the body reader has detached.
        request.on('error', () => {});
        try {
            if (request.url === '/healthz' && request.method === 'GET') {
                const status = publisher.status();
                return respond(response, status.pendingMessageId && !status.busy ? 503 : 200, {
                    status: status.pendingMessageId && !status.busy ? 'recovery_required' : 'ready',
                    chainId: config.chainId, loggerContract: config.loggerContract, nodeAddress, ...status,
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
                onAcceptedMessage: publisher.publish,
            });
            respond(response, result.status, {
                ...result.body,
                ...(result.status === 202 ? { publication: result.handleSignedMessageResult } : {}),
            });
        } catch (error) {
            if (error instanceof PublicationUnavailable) {
                return respond(response, 503, {
                    code: error.code,
                    ...(error.record ? { publication: publicRecord(error.record) } : {}),
                }, { 'retry-after': '5' });
            }
            if (error.status && error.code) {
                return respond(response, error.status, { code: error.code }, { connection: 'close' });
            }
            respond(response, 500, { code: 'internal_error' }, { connection: 'close' });
        }
    });
    server.requestTimeout = config.bodyTimeoutMs;
    server.headersTimeout = Math.min(config.bodyTimeoutMs, 10_000);
    server.keepAliveTimeout = 5000;
    server.maxConnections = 64;
    return server;
}
