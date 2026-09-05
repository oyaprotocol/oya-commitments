import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import {
    createSignedMessageAuthorizer, handleSignedMessage, publishAndLogSignedMessage,
    PublishAndLogSignedMessageError, SignedMessageVerificationError,
} from '@oyaprotocol/messages';
import { createIpfsConfig, HttpStatusError } from '@oyaprotocol/ipfs';
import { LogCidError, EthereumTransactionReceiptTimeoutError } from '@oyaprotocol/ethereum';
import {
    sample, loggerContract, node, transactionHash, rawTransaction,
    createReceipt, response, createOptions as createLoggerOptions,
} from '../../ethereum/test/fixtures/logger-transaction.js';

const fixtures = JSON.parse(readFileSync(new URL('../../test/fixtures/cids.json', import.meta.url), 'utf8'));
const envelope = fixtures.cases.find(({ name }) => name === 'message');
const message = JSON.parse(envelope.text);

function ipfsResponse() {
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ Hash: sample.cid }) };
}

function createOptions(overrides = {}) {
    return {
        ipfs: {
            config: createIpfsConfig({
                url: 'https://ipfs.example', headers: {}, timeoutMs: 1_000, maxRetries: 0, retryDelayMs: 0,
            }),
            fetch: async () => ipfsResponse(),
        },
        logger: createLoggerOptions(), ...overrides,
    };
}

function createRequest(payload = message) {
    return {
        method: 'POST', contentType: 'application/json',
        body: new TextEncoder().encode(JSON.stringify(payload)),
    };
}

function createIngress(options, overrides = {}) {
    return {
        authorize: createSignedMessageAuthorizer([message.signer]), maxBodyBytes: 4096, maxTextBytes: 1024,
        onAcceptedMessage: (accepted) => publishAndLogSignedMessage(accepted, options), ...overrides,
    };
}

test('the allowlisted message callback awaits publication, signing, submission, and the expected Logger receipt in order', async () => {
    const uploadStarted = Promise.withResolvers();
    const uploaded = Promise.withResolvers();
    const signingStarted = Promise.withResolvers();
    const signed = Promise.withResolvers();
    const receiptRequested = Promise.withResolvers();
    const mined = Promise.withResolvers();
    const stages = [];
    const options = createOptions();
    options.ipfs.fetch = async (url, request) => {
        stages.push('publish');
        assert.deepEqual(Object.fromEntries(new URL(url).searchParams), fixtures.options);
        const file = request.body.get('file');
        assert.equal(file.name, 'message.json');
        assert.equal(file.type, 'application/json');
        assert.equal(await file.text(), envelope.text);
        uploadStarted.resolve();
        await uploaded.promise;
        return ipfsResponse();
    };
    options.logger.transactionPreparer = (request) => {
        stages.push('prepare');
        assert.deepEqual(request, { to: loggerContract, data: sample.calldata, value: 0n });
        signingStarted.resolve();
        return signed.promise;
    };
    options.logger.fetch = async (_url, request) => {
        const { method, params } = JSON.parse(request.body);
        stages.push(method);
        if (method === 'eth_sendRawTransaction') {
            assert.deepEqual(params, [rawTransaction]);
            return response(transactionHash);
        }
        assert.deepEqual(params, [transactionHash]);
        receiptRequested.resolve();
        await mined.promise;
        return response(createReceipt());
    };
    const request = createRequest();
    // Incoming JSON formatting/order is irrelevant; the authenticated payload is preserved.
    request.body = new TextEncoder().encode(JSON.stringify({
        signature: message.signature, text: message.text, signer: message.signer,
    }, null, 2));
    let settled = false;
    const resultPromise = handleSignedMessage(request, createIngress(options)).then((result) => {
        settled = true;
        return result;
    });
    await uploadStarted.promise;
    assert.deepEqual(stages, ['publish']);
    assert.equal(settled, false);
    uploaded.resolve();
    await signingStarted.promise;
    assert.deepEqual(stages, ['publish', 'prepare']);
    signed.resolve({ rawTransaction, transactionHash });
    await receiptRequested.promise;
    assert.equal(settled, false);
    mined.resolve();
    const result = await resultPromise;
    assert.deepEqual(stages, ['publish', 'prepare', 'eth_sendRawTransaction', 'eth_getTransactionReceipt']);
    assert.equal(result.status, 202);
    assert.deepEqual(result.message, message);
    assert.deepEqual(result.body, { status: 'accepted', signer: message.signer });
    const { publication, logging } = result.handleSignedMessageResult;
    assert.equal(publication.cid, envelope.cid);
    assert.equal(logging.cid, publication.cid);
    assert.equal(logging.transactionHash, transactionHash);
    assert.equal(logging.event.node, node);
    assert.notEqual(logging.event.node.toLowerCase(), message.signer.toLowerCase());
    assert.equal(logging.receipt.status, 'success');
});

test('rejected ingress requests never publish, prepare, or log a message', async () => {
    let calls = 0;
    const options = createOptions();
    options.ipfs.fetch = options.logger.fetch = async () => { calls++; throw new Error('Unexpected fetch'); };
    options.logger.transactionPreparer = () => { calls++; throw new Error('Unexpected signing'); };
    const cases = [
        [createRequest(), { authorize: createSignedMessageAuthorizer([]) }, 403],
        [createRequest({ ...message, text: `${message.text}!` }), {}, 401],
        [createRequest({ ...message, extra: 'untrusted' }), {}, 400],
        [{ ...createRequest(), method: 'GET' }, {}, 405],
        [{ ...createRequest(), contentType: 'text/plain' }, {}, 415],
        [createRequest(), { maxBodyBytes: 1 }, 413],
    ];
    for (const [request, overrides, expectedStatus] of cases) {
        const result = await handleSignedMessage(request, createIngress(options, overrides));
        assert.equal(result.status, expectedStatus);
        assert.equal('handleSignedMessageResult' in result, false);
    }
    assert.equal(calls, 0);
});

test('invalid direct messages and failed IPFS publication prevent all Logger actions', async () => {
    let loggerCalls = 0;
    let uploads = 0;
    const options = createOptions();
    options.logger.transactionPreparer = () => { loggerCalls++; };
    options.logger.fetch = async () => { loggerCalls++; };
    options.ipfs.fetch = async () => {
        uploads++;
        return { ok: false, status: 400, statusText: 'Bad Request', text: async () => '' };
    };
    await assert.rejects(publishAndLogSignedMessage({ ...message, text: 'tampered' }, options), SignedMessageVerificationError);
    assert.equal(uploads, 0);
    await assert.rejects(handleSignedMessage(createRequest(), createIngress(options)), HttpStatusError);
    options.ipfs.fetch = async () => ({ ...ipfsResponse(), text: async () => '{"Hash":"bafy-invalid"}' });
    await assert.rejects(handleSignedMessage(createRequest(), createIngress(options)), /canonical CIDv1/);
    assert.equal(loggerCalls, 0);
});

test('message logging failures preserve the publication and known transaction hash without repeating either operation', async () => {
    for (const stage of ['prepare', 'submit', 'receipt', 'verify']) {
        const options = createOptions();
        let uploads = 0;
        let preparations = 0;
        let submissions = 0;
        const cause = new Error(`${stage} failed`);
        options.ipfs.fetch = async () => { uploads++; return ipfsResponse(); };
        options.logger.transactionPreparer = () => {
            preparations++;
            if (stage === 'prepare') throw cause;
            return { rawTransaction, transactionHash };
        };
        options.logger.timeoutMs = 10;
        options.logger.fetch = async (_url, request) => {
            const { method } = JSON.parse(request.body);
            if (method === 'eth_sendRawTransaction') {
                submissions++;
                if (stage === 'submit') throw cause;
                return response(transactionHash);
            }
            return response(stage === 'receipt' ? null : createReceipt({ status: '0x0' }));
        };
        await assert.rejects(handleSignedMessage(createRequest(), createIngress(options)), (error) => {
            assert.ok(error instanceof PublishAndLogSignedMessageError);
            assert.equal(error.publication.cid, envelope.cid);
            assert.equal(error.publication.uri, `ipfs://${envelope.cid}`);
            assert.equal(error.publication.pinned, true);
            assert.equal(error.transactionHash, stage === 'prepare' ? null : transactionHash);
            assert.ok(error.cause instanceof LogCidError);
            assert.equal(error.cause.stage, stage);
            if (stage === 'receipt') assert.ok(error.cause.cause instanceof EthereumTransactionReceiptTimeoutError);
            if (stage === 'verify') assert.equal(error.cause.receipt.status, 'reverted');
            if (stage === 'prepare' || stage === 'submit') assert.equal(error.cause.cause, cause);
            return true;
        });
        assert.equal(uploads, 1);
        assert.equal(preparations, 1);
        assert.equal(submissions, stage === 'prepare' ? 0 : 1);
    }
});

test('the message callback forwards one cancellation signal through publication and signing', async () => {
    const options = createOptions();
    const controller = new AbortController();
    options.signal = controller.signal;
    const signingStarted = Promise.withResolvers();
    const signed = Promise.withResolvers();
    let ipfsSignal;
    let submissions = 0;
    options.ipfs.fetch = async (_url, request) => { ipfsSignal = request.signal; return ipfsResponse(); };
    options.logger.transactionPreparer = (request) => {
        assert.equal(request.signal, controller.signal);
        signingStarted.resolve();
        return signed.promise;
    };
    options.logger.fetch = async () => { submissions++; };
    const promise = handleSignedMessage(createRequest(), createIngress(options));
    await signingStarted.promise;
    controller.abort(new Error('Host cancelled'));
    await assert.rejects(promise, (error) => error instanceof PublishAndLogSignedMessageError &&
        error.publication.cid === envelope.cid && error.transactionHash === null);
    signed.resolve({ rawTransaction, transactionHash });
    await nextTurn();
    assert.equal(ipfsSignal.aborted, true);
    assert.equal(submissions, 0);
});

test('a pre-aborted message callback does not publish or prepare a transaction', async () => {
    const options = createOptions({ signal: AbortSignal.abort('Cancelled') });
    let calls = 0;
    options.ipfs.fetch = async () => { calls++; };
    options.logger.transactionPreparer = () => { calls++; };
    await assert.rejects(handleSignedMessage(createRequest(), createIngress(options)), /aborted/);
    assert.equal(calls, 0);
});
