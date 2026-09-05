import assert from 'node:assert/strict';
import test from 'node:test';

import { createIpfsConfig, HttpStatusError } from '@oyaprotocol/ipfs';
import {
    createSignedMessageAuthorizer,
    handleSignedMessage,
    publishSignedMessage,
    SignedMessageValidationError,
    SignedMessageVerificationError,
    verifySignedMessage,
} from '@oyaprotocol/messages';

// Public ethers v6 Wallet.signMessage fixture also used in signature.test.js.
// No private key or live service is used by these tests.
const SIGNER = '0x14791697260E4c9A71f18484C9f997B308e59325';
const TEXT = 'Please withdraw 100 USDC.';
const SIGNATURE =
    '0x36891560b97f673db6931408e45fd3e8ffca26ae50f1c68adbe74e57808b9248' +
    '0f55566cc281099d59dc574c7e444851af9a8978acd55503ca3d2565061e542d1b';
const CID = 'bafkreicn5hwdk56k2qwskml5rfq5oz3fvz6g5blm5vpd4jtlkchbbfibki';

function createMessage(overrides = {}) {
    return { text: TEXT, signer: SIGNER, signature: SIGNATURE, ...overrides };
}

function createConfig(overrides = {}) {
    return createIpfsConfig({
        url: 'http://ipfs.example:5001',
        headers: { Authorization: 'Bearer test-token' },
        timeoutMs: 1000,
        maxRetries: 0,
        retryDelayMs: 0,
        ...overrides,
    });
}

function createResponse(status = 200, body = JSON.stringify({ Hash: CID })) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Unavailable',
        async text() { return body; },
    };
}

function createRequest(message = createMessage()) {
    return {
        method: 'POST',
        contentType: 'application/json',
        body: new TextEncoder().encode(JSON.stringify(message)),
    };
}

function createIngressOptions(publicationOptions, overrides = {}) {
    return {
        authorize: createSignedMessageAuthorizer([SIGNER]),
        maxBodyBytes: 4096,
        maxTextBytes: 1024,
        onAcceptedMessage: (message) => publishSignedMessage(message, publicationOptions),
        ...overrides,
    };
}

test('publishSignedMessage publishes and pins a deterministic, verifiable JSON envelope', async () => {
    const uploads = [];
    const options = {
        config: createConfig(),
        fetch: async (url, request) => {
            assert.equal(url, 'http://ipfs.example:5001/api/v0/add?cid-version=1&cid-base=base32&hash=sha2-256&chunker=size-1048576&raw-leaves=true&trickle=false&max-file-links=1024&wrap-with-directory=false&inline=false&preserve-mode=false&preserve-mtime=false&pin=true&progress=false');
            assert.equal(request.method, 'POST');
            assert.equal(request.headers.Authorization, 'Bearer test-token');
            const file = request.body.get('file');
            assert.equal(file.name, 'message.json');
            assert.equal(file.type, 'application/json');
            uploads.push(await file.text());
            return createResponse();
        },
    };
    // Property insertion order in the caller's object must not affect file bytes.
    const reorderedMessage = { signature: SIGNATURE, signer: SIGNER, text: TEXT };
    const result = await publishSignedMessage(reorderedMessage, options);
    await publishSignedMessage(createMessage(), options);

    const expectedJson = `{"text":"${TEXT}","signer":"${SIGNER}","signature":"${SIGNATURE}"}`;
    assert.deepEqual(uploads, [expectedJson, expectedJson]);
    assert.deepEqual(verifySignedMessage(JSON.parse(uploads[0])), createMessage());
    assert.deepEqual(result, {
        cid: CID,
        uri: `ipfs://${CID}`,
        pinned: true,
        filename: 'message.json',
        mediaType: 'application/json',
        contentByteLength: new TextEncoder().encode(expectedJson).byteLength,
        providerSize: null,
        attemptCount: 1,
        providerResponse: { Hash: CID },
    });
    assert.deepEqual(reorderedMessage, createMessage());
});

test('publishSignedMessage preserves signature casing and recovery encoding', async () => {
    const message = createMessage({
        signer: SIGNER.toLowerCase(),
        signature: `0x${SIGNATURE.slice(2, -2).toUpperCase()}00`,
    });
    let uploaded;
    await publishSignedMessage(message, {
        config: createConfig(),
        fetch: async (_url, request) => {
            uploaded = JSON.parse(await request.body.get('file').text());
            return createResponse();
        },
    });
    assert.deepEqual(uploaded, message);
    assert.deepEqual(verifySignedMessage(uploaded), message);
});

test('publishSignedMessage rejects invalid envelopes before any upload', async () => {
    let calls = 0;
    const options = {
        config: createConfig(),
        fetch: async () => { calls += 1; return createResponse(); },
    };
    for (const message of [null, createMessage({ text: '' }), createMessage({ extra: true })]) {
        await assert.rejects(publishSignedMessage(message, options), SignedMessageValidationError);
    }
    for (const message of [
        createMessage({ text: `${TEXT}!` }),
        createMessage({ signer: '0x1111111111111111111111111111111111111111' }),
        createMessage({ signature: `0x${'00'.repeat(65)}` }),
    ]) {
        await assert.rejects(publishSignedMessage(message, options), SignedMessageVerificationError);
    }
    assert.equal(calls, 0);
});

test('publishSignedMessage snapshots bytes before asynchronous upload and reuses them on retries', async () => {
    const message = createMessage();
    const uploads = [];
    const resultPromise = publishSignedMessage(message, {
        config: createConfig({ maxRetries: 1 }),
        fetch: async (_url, request) => {
            message.text = 'Changed while publishing';
            uploads.push(await request.body.get('file').text());
            return uploads.length === 1 ? createResponse(503) : createResponse();
        },
        // Runtime callers cannot replace the signed content or artifact metadata.
        content: 'unsigned override',
        filename: 'override.txt',
        mediaType: 'text/plain',
    });
    message.signature = `0x${'00'.repeat(65)}`;
    const result = await resultPromise;
    assert.deepEqual(uploads, [JSON.stringify(createMessage()), JSON.stringify(createMessage())]);
    assert.equal(result.attemptCount, 2);
    assert.equal(result.filename, 'message.json');
    assert.equal(result.mediaType, 'application/json');
});

test('publishSignedMessage forwards cancellation without uploading', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(publishSignedMessage(createMessage(), {
        config: createConfig(),
        fetch: async () => { calls += 1; return createResponse(); },
        signal: controller.signal,
    }), /aborted by the caller/);
    assert.equal(calls, 0);
});

test('the host can configure publication and receive CID metadata for every accepted submission', async () => {
    const uploads = [];
    const options = createIngressOptions({
        config: createConfig(),
        fetch: async (_url, request) => {
            uploads.push(await request.body.get('file').text());
            return createResponse();
        },
    });
    for (let count = 0; count < 2; count += 1) {
        const result = await handleSignedMessage(createRequest(), options);
        assert.equal(uploads.length, count + 1);
        assert.equal(result.status, 202);
        assert.equal(result.handleSignedMessageResult.cid, CID);
        assert.equal(result.handleSignedMessageResult.pinned, true);
        assert.deepEqual(result.body, { status: 'accepted', signer: SIGNER });
        assert.equal('cid' in result.body, false);
        assert.deepEqual(JSON.parse(uploads[count]), result.message);
    }
});

test('the configured publisher performs no uploads for rejected ingress requests', async () => {
    let calls = 0;
    const options = createIngressOptions({
        config: createConfig(),
        fetch: async () => { calls += 1; return createResponse(); },
    });
    const cases = [
        [createRequest({}), options, 400],
        [createRequest(createMessage({ text: `${TEXT}!` })), options, 401],
        [createRequest(), { ...options, authorize: createSignedMessageAuthorizer([]) }, 403],
        [createRequest(), { ...options, maxBodyBytes: 1 }, 413],
        [createRequest(), { ...options, maxTextBytes: 1 }, 413],
    ];
    for (const [request, configuredOptions, expectedStatus] of cases) {
        const result = await handleSignedMessage(request, configuredOptions);
        assert.equal(result.status, expectedStatus);
        assert.equal('handleSignedMessageResult' in result, false);
    }
    assert.equal(calls, 0);
});

test('publication failures propagate through ingress without an accepted result', async () => {
    const failure = new Error('publication transport failed');
    const options = createIngressOptions({
        config: createConfig(),
        fetch: async () => { throw failure; },
    });
    await assert.rejects(handleSignedMessage(createRequest(), options), (error) => error === failure);

    const httpOptions = createIngressOptions({
        config: createConfig(),
        fetch: async () => createResponse(503, 'publication unavailable'),
    });
    await assert.rejects(handleSignedMessage(createRequest(), httpOptions), (error) => {
        assert.ok(error instanceof HttpStatusError);
        assert.equal(error.status, 503);
        return true;
    });
});
