import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createSignedMessageAuthorizer,
    handleSignedMessage,
    SignedMessageAuthorizationError,
    SignedMessageValidationError,
    SignedMessageVerificationError,
} from '../dist/index.js';

// The first vector was generated with ethers v6 Wallet.signMessage using a
// disposable test signer. The second uses the well-known test-only secp256k1
// private key 0x00...01. Neither fixture contains production key material.
const SIGNER = '0x14791697260E4c9A71f18484C9f997B308e59325';
const OTHER_SIGNER = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
const UNAUTHORIZED_SIGNER = '0x1111111111111111111111111111111111111111';
const TEXT = 'Please withdraw 100 USDC.';
const SIGNATURE =
    '0x36891560b97f673db6931408e45fd3e8ffca26ae50f1c68adbe74e57808b9248' +
    '0f55566cc281099d59dc574c7e444851af9a8978acd55503ca3d2565061e542d1b';
const OTHER_SIGNATURE =
    '0x7e50e1d119477ba73cc01e388069e01c3cc51ff50d6466cfc98b4fcaf3b9b550' +
    '3acb8ca9a174a614f31b01119ccdc84901c66f19022fe52e25b9a6affdb69ee81c';

const textEncoder = new TextEncoder();

function createSignedMessage(overrides = {}) {
    return {
        text: TEXT,
        signer: SIGNER,
        signature: SIGNATURE,
        ...overrides,
    };
}

function encodeJson(value) {
    return textEncoder.encode(JSON.stringify(value));
}

function createRequest(overrides = {}) {
    return {
        method: 'POST',
        contentType: 'application/json',
        body: encodeJson(createSignedMessage()),
        ...overrides,
    };
}

function createOptions(overrides = {}) {
    return {
        authorize: createSignedMessageAuthorizer([SIGNER]),
        maxBodyBytes: 4096,
        maxTextBytes: 1024,
        ...overrides,
    };
}

function assertRejection(result, { status, code, message, details }) {
    assert.equal(result.status, status);
    assert.equal(result.body.code, code);
    assert.match(result.body.error, message);
    if (details === undefined) {
        assert.equal(Object.hasOwn(result.body, 'details'), false);
    } else {
        assert.deepEqual(result.body.details, details);
        assert.equal(Object.isFrozen(result.body.details), true);
    }
    assert.equal(Object.hasOwn(result, 'message'), false);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.body), true);
}

test('handleSignedMessage accepts an authorized signed message and returns a trusted handoff', async () => {
    const resultPromise = handleSignedMessage(createRequest(), createOptions());
    assert.equal(resultPromise instanceof Promise, true);

    const result = await resultPromise;

    assert.equal(result.status, 202);
    assert.deepEqual(result.body, {
        status: 'accepted',
        signer: SIGNER,
    });
    assert.deepEqual(result.message, createSignedMessage());
    assert.equal(Object.hasOwn(result.body, 'text'), false);
    assert.equal(Object.hasOwn(result.body, 'signature'), false);
    assert.notStrictEqual(result.body, result.message);
    assert.equal(Object.hasOwn(result, 'handleSignedMessageResult'), false);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.body), true);
    assert.equal(Object.isFrozen(result.message), true);
});

test('handleSignedMessage preserves the callback-absent result shape for explicit undefined', async () => {
    const result = await handleSignedMessage(
        createRequest(),
        createOptions({ onAcceptedMessage: undefined })
    );

    assert.equal(result.status, 202);
    assert.equal(Object.hasOwn(result, 'handleSignedMessageResult'), false);
});

test('handleSignedMessage invokes the accepted-message handler after authorization for every accepted submission', async () => {
    const authorizedMessage = createSignedMessage();
    const handlerResult = { cid: 'bafy-handler-result' };
    const events = [];
    const callbackMessages = [];
    const options = createOptions({
        authorize(input) {
            events.push('authorize');
            assert.deepEqual(input, createSignedMessage());
            return authorizedMessage;
        },
        onAcceptedMessage(message) {
            events.push('handle');
            callbackMessages.push(message);
            assert.equal(Object.isFrozen(message), true);
            return handlerResult;
        },
    });

    const firstResult = await handleSignedMessage(createRequest(), options);
    const repeatedResult = await handleSignedMessage(createRequest(), options);

    assert.deepEqual(events, ['authorize', 'handle', 'authorize', 'handle']);
    assert.equal(callbackMessages.length, 2);
    assert.strictEqual(callbackMessages[0], firstResult.message);
    assert.strictEqual(callbackMessages[1], repeatedResult.message);
    assert.notStrictEqual(callbackMessages[0], authorizedMessage);
    assert.strictEqual(firstResult.handleSignedMessageResult, handlerResult);
    assert.strictEqual(repeatedResult.handleSignedMessageResult, handlerResult);
    assert.equal(Object.isFrozen(firstResult), true);
    assert.equal(Object.isFrozen(firstResult.body), true);
    assert.equal(Object.isFrozen(firstResult.message), true);
    assert.equal(Object.isFrozen(handlerResult), false);
});

test('handleSignedMessage awaits asynchronous handlers and preserves an undefined result as an own property', async () => {
    let resolveHandler;
    let handlerFinished = false;
    const handlerResult = { cid: 'bafy-async-handler-result' };
    const handlerPromise = new Promise((resolve) => {
        resolveHandler = resolve;
    });
    const resultPromise = handleSignedMessage(
        createRequest(),
        createOptions({
            onAcceptedMessage() {
                return handlerPromise;
            },
        })
    );
    void resultPromise.then(() => {
        handlerFinished = true;
    });

    await Promise.resolve();
    assert.equal(handlerFinished, false);
    resolveHandler(handlerResult);

    const result = await resultPromise;
    assert.strictEqual(result.handleSignedMessageResult, handlerResult);
    assert.equal(handlerFinished, true);

    const undefinedResult = await handleSignedMessage(
        createRequest(),
        createOptions({
            onAcceptedMessage() {
                return undefined;
            },
        })
    );
    assert.equal(
        Object.hasOwn(undefinedResult, 'handleSignedMessageResult'),
        true
    );
    assert.equal(undefinedResult.handleSignedMessageResult, undefined);
});

test('handleSignedMessage snapshots the message supplied by the injected authorizer', async () => {
    const message = createSignedMessage();
    let authorizedInput;
    const authorize = (input) => {
        authorizedInput = input;
        return message;
    };

    const result = await handleSignedMessage(
        createRequest(),
        createOptions({ authorize })
    );

    assert.deepEqual(authorizedInput, createSignedMessage());
    assert.deepEqual(result.message, createSignedMessage());
    assert.notStrictEqual(result.message, message);
    assert.notStrictEqual(result.body, message);
    assert.equal(Object.isFrozen(result.message), true);

    message.text = 'Changed after acceptance.';
    message.signer = UNAUTHORIZED_SIGNER;

    assert.deepEqual(result.message, createSignedMessage());
    assert.equal(result.body.signer, SIGNER);
});

test('handleSignedMessage consistently accepts repeated signed text and distinct signers of identical text', async () => {
    const authorize = createSignedMessageAuthorizer([SIGNER, OTHER_SIGNER]);
    const options = createOptions({ authorize });
    const firstRequest = createRequest();
    const secondRequest = createRequest({
        body: encodeJson(
            createSignedMessage({
                signer: OTHER_SIGNER,
                signature: OTHER_SIGNATURE,
            })
        ),
    });

    const firstResult = await handleSignedMessage(firstRequest, options);
    const repeatedResult = await handleSignedMessage(firstRequest, options);
    const secondSignerResult = await handleSignedMessage(secondRequest, options);

    assert.deepEqual(repeatedResult, firstResult);
    assert.equal(secondSignerResult.status, 202);
    assert.equal(secondSignerResult.message.text, TEXT);
    assert.equal(secondSignerResult.message.signer, OTHER_SIGNER);
});

test('handleSignedMessage accepts only the specified JSON content types', async () => {
    const acceptedContentTypes = [
        'application/json',
        'APPLICATION/JSON',
        ' application/json ',
        '\tapplication/json\t;\tcharset = utf-8\t',
        'application/json;charset=UTF-8',
    ];
    for (const contentType of acceptedContentTypes) {
        const result = await handleSignedMessage(
            createRequest({ contentType }),
            createOptions()
        );
        assert.equal(result.status, 202, contentType);
    }

    const rejectedContentTypes = [
        undefined,
        'text/plain',
        'application/json; charset=ascii',
        'application/json; version=1',
        'application/json; charset="utf-8"',
        'application/json; charset=utf-8; version=1',
        'application/json\n',
    ];
    for (const contentType of rejectedContentTypes) {
        assertRejection(
            await handleSignedMessage(
                createRequest({ contentType }),
                createOptions()
            ),
            {
                status: 415,
                code: 'unsupported_content_type',
                message: /Content-Type must be application\/json with optional charset=utf-8/,
            }
        );
    }
});

test('handleSignedMessage rejects non-POST methods before other request semantics', async () => {
    let authorizationCalls = 0;
    const result = await handleSignedMessage(
        createRequest({
            method: 'post',
            contentType: undefined,
            body: Uint8Array.of(0xff),
        }),
        createOptions({
            authorize() {
                authorizationCalls += 1;
                return Object.freeze(createSignedMessage());
            },
        })
    );

    assertRejection(result, {
        status: 405,
        code: 'method_not_allowed',
        message: /Method must be POST/,
    });
    assert.equal(authorizationCalls, 0);
});

test('handleSignedMessage enforces the body limit before decoding or authorization', async () => {
    let authorizationCalls = 0;
    const body = Uint8Array.of(0xff, 0xff);
    const result = await handleSignedMessage(
        createRequest({ body }),
        createOptions({
            maxBodyBytes: 1,
            authorize() {
                authorizationCalls += 1;
                throw new Error('must not be called');
            },
        })
    );

    assertRejection(result, {
        status: 413,
        code: 'body_too_large',
        message: /Request body exceeds the configured byte limit/,
    });
    assert.equal(authorizationCalls, 0);
});

test('handleSignedMessage maps invalid UTF-8 and JSON syntax before authorization', async () => {
    let authorizationCalls = 0;
    const authorize = () => {
        authorizationCalls += 1;
        throw new Error('must not be called');
    };
    const invalidBodies = [
        Uint8Array.of(0xff),
        textEncoder.encode('{"text":'),
    ];

    for (const body of invalidBodies) {
        assertRejection(
            await handleSignedMessage(
                createRequest({ body }),
                createOptions({ authorize })
            ),
            {
                status: 400,
                code: 'invalid_json',
                message: /Request body must be valid UTF-8 JSON/,
            }
        );
    }
    assert.equal(authorizationCalls, 0);
});

test('handleSignedMessage enforces UTF-8 text bytes before authorization', async () => {
    let authorizationCalls = 0;
    const authorize = (input) => {
        authorizationCalls += 1;
        return Object.freeze(createSignedMessage({ text: input.text }));
    };

    const overlargeResult = await handleSignedMessage(
        createRequest({
            body: encodeJson(createSignedMessage({ text: 'é' })),
        }),
        createOptions({ authorize, maxTextBytes: 1 })
    );
    assertRejection(overlargeResult, {
        status: 413,
        code: 'text_too_large',
        message: /text exceeds the configured byte limit/,
    });
    assert.equal(authorizationCalls, 0);

    const exactLimitResult = await handleSignedMessage(
        createRequest({
            body: encodeJson(createSignedMessage({ text: 'ab' })),
        }),
        createOptions({ authorize, maxTextBytes: 2 })
    );
    assert.equal(exactLimitResult.status, 202);
    assert.equal(authorizationCalls, 1);
});

test('handleSignedMessage lets the authorizer validate body shape and text type', async () => {
    const authorize = createSignedMessageAuthorizer([SIGNER]);
    for (const input of [null, [], 'message']) {
        assertRejection(
            await handleSignedMessage(
                createRequest({ body: encodeJson(input) }),
                createOptions({ authorize })
            ),
            {
                status: 400,
                code: 'invalid_body',
                message: /Request body must be a JSON object/,
            }
        );
    }
    for (const input of [
        { signer: SIGNER, signature: SIGNATURE },
        createSignedMessage({ text: 123 }),
    ]) {
        assertRejection(
            await handleSignedMessage(
                createRequest({ body: encodeJson(input) }),
                createOptions({ authorize })
            ),
            {
                status: 400,
                code: 'invalid_text',
                message: /text is required and must be a string/,
            }
        );
    }
});

test('handleSignedMessage preserves structured validation, verification, and authorization errors', async () => {
    const validationResult = await handleSignedMessage(
        createRequest({
            body: encodeJson({ ...createSignedMessage(), meta: {} }),
        }),
        createOptions()
    );
    assertRejection(validationResult, {
        status: 400,
        code: 'unsupported_field',
        message: /Unsupported field: meta/,
        details: { field: 'meta' },
    });

    const verificationResult = await handleSignedMessage(
        createRequest({
            body: encodeJson(createSignedMessage({ text: 'Changed text.' })),
        }),
        createOptions()
    );
    assertRejection(verificationResult, {
        status: 401,
        code: 'invalid_signature',
        message: /signature must be a valid EIP-191 signature for signer/,
    });

    const authorizationResult = await handleSignedMessage(
        createRequest(),
        createOptions({
            authorize: createSignedMessageAuthorizer([UNAUTHORIZED_SIGNER]),
        })
    );
    assertRejection(authorizationResult, {
        status: 403,
        code: 'unauthorized_signer',
        message: /signer is not authorized/,
    });
});

test('handleSignedMessage maps injected error classes to fixed statuses', async () => {
    const cases = [
        {
            error: new SignedMessageValidationError({
                code: 'invalid_body',
                message: 'Injected validation failure.',
                details: { source: 'test' },
            }),
            rejection: {
                status: 400,
                code: 'invalid_body',
                message: /Injected validation failure/,
                details: { source: 'test' },
            },
        },
        {
            error: new SignedMessageVerificationError(),
            rejection: {
                status: 401,
                code: 'invalid_signature',
                message: /signature must be a valid EIP-191 signature for signer/,
            },
        },
        {
            error: new SignedMessageAuthorizationError(),
            rejection: {
                status: 403,
                code: 'unauthorized_signer',
                message: /signer is not authorized/,
            },
        },
    ];

    for (const { error, rejection } of cases) {
        error.status = 202;
        assert.equal(error.status, 202);

        const result = await handleSignedMessage(
            createRequest(),
            createOptions({
                authorize() {
                    throw error;
                },
            })
        );

        assertRejection(result, rejection);
    }
});

test('handleSignedMessage bypasses the accepted-message handler for every rejection stage', async () => {
    let handlerCalls = 0;
    const onAcceptedMessage = () => {
        handlerCalls += 1;
        throw new Error('must not be called');
    };
    const cases = [
        {
            request: createRequest({ method: 'GET' }),
            options: createOptions({ onAcceptedMessage }),
        },
        {
            request: createRequest({ contentType: 'text/plain' }),
            options: createOptions({ onAcceptedMessage }),
        },
        {
            request: createRequest(),
            options: createOptions({
                maxBodyBytes: 1,
                onAcceptedMessage,
            }),
        },
        {
            request: createRequest({ body: textEncoder.encode('{') }),
            options: createOptions({ onAcceptedMessage }),
        },
        {
            request: createRequest(),
            options: createOptions({
                maxTextBytes: 1,
                onAcceptedMessage,
            }),
        },
        {
            request: createRequest({
                body: encodeJson({
                    signer: SIGNER,
                    signature: SIGNATURE,
                }),
            }),
            options: createOptions({ onAcceptedMessage }),
        },
        {
            request: createRequest({
                body: encodeJson(
                    createSignedMessage({ text: 'Changed text.' })
                ),
            }),
            options: createOptions({ onAcceptedMessage }),
        },
        {
            request: createRequest(),
            options: createOptions({
                authorize: createSignedMessageAuthorizer([
                    UNAUTHORIZED_SIGNER,
                ]),
                onAcceptedMessage,
            }),
        },
    ];

    for (const { request, options } of cases) {
        const result = await handleSignedMessage(request, options);
        assert.notEqual(result.status, 202);
    }
    assert.equal(handlerCalls, 0);
});

test('handleSignedMessage propagates accepted-message handler failures unchanged', async () => {
    const synchronousError = new Error('synchronous handler failure');
    const asynchronousError = new Error('asynchronous handler failure');

    await assert.rejects(
        handleSignedMessage(
            createRequest(),
            createOptions({
                onAcceptedMessage() {
                    throw synchronousError;
                },
            })
        ),
        (error) => error === synchronousError
    );
    await assert.rejects(
        handleSignedMessage(
            createRequest(),
            createOptions({
                onAcceptedMessage() {
                    return Promise.reject(asynchronousError);
                },
            })
        ),
        (error) => error === asynchronousError
    );
});

test('handleSignedMessage propagates unexpected authorizer failures', async () => {
    const unexpectedError = new Error('RPC unavailable');

    await assert.rejects(
        handleSignedMessage(
            createRequest(),
            createOptions({
                authorize() {
                    throw unexpectedError;
                },
            })
        ),
        (error) => error === unexpectedError
    );
});

test('handleSignedMessage validates options before request', async () => {
    await assert.rejects(
        handleSignedMessage(null, null),
        (error) =>
            error instanceof TypeError &&
            error.message === 'options must be a plain object.'
    );
});

test('handleSignedMessage requires plain containers with exact own fields', async () => {
    for (const options of [null, [], () => {}]) {
        await assert.rejects(
            handleSignedMessage(createRequest(), options),
            /options must be a plain object/
        );
    }
    for (const request of [null, [], () => {}]) {
        await assert.rejects(
            handleSignedMessage(request, createOptions()),
            /request must be a plain object/
        );
    }

    for (const field of ['authorize', 'maxBodyBytes', 'maxTextBytes']) {
        const options = createOptions();
        delete options[field];
        await assert.rejects(
            handleSignedMessage(createRequest(), options),
            new RegExp(`options\\.${field} is required`)
        );
    }
    for (const field of ['method', 'contentType', 'body']) {
        const request = createRequest();
        delete request[field];
        await assert.rejects(
            handleSignedMessage(request, createOptions()),
            new RegExp(`request\\.${field} is required`)
        );
    }

    await assert.rejects(
        handleSignedMessage(
            createRequest(),
            createOptions({ unexpected: true })
        ),
        /Unsupported options field: unexpected/
    );
    await assert.rejects(
        handleSignedMessage(
            createRequest({ unexpected: true }),
            createOptions()
        ),
        /Unsupported request field: unexpected/
    );

    const symbol = Symbol('unexpected');
    const optionsWithSymbol = createOptions();
    optionsWithSymbol[symbol] = true;
    await assert.rejects(
        handleSignedMessage(createRequest(), optionsWithSymbol),
        /Unsupported options field: Symbol\(unexpected\)/
    );
});

test('handleSignedMessage ignores inherited accepted-message handlers', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
        Object.prototype,
        'onAcceptedMessage'
    );
    let inheritedHandlerCalls = 0;

    try {
        for (const value of [
            () => {
                inheritedHandlerCalls += 1;
            },
            'inherited non-function',
        ]) {
            Object.defineProperty(Object.prototype, 'onAcceptedMessage', {
                configurable: true,
                value,
            });

            const result = await handleSignedMessage(
                createRequest(),
                createOptions()
            );

            assert.equal(result.status, 202);
            assert.equal(
                Object.hasOwn(result, 'handleSignedMessageResult'),
                false
            );
        }
    } finally {
        if (originalDescriptor === undefined) {
            Reflect.deleteProperty(Object.prototype, 'onAcceptedMessage');
        } else {
            Object.defineProperty(
                Object.prototype,
                'onAcceptedMessage',
                originalDescriptor
            );
        }
    }

    assert.equal(inheritedHandlerCalls, 0);
});

test('handleSignedMessage rejects malformed option field values', async () => {
    for (const authorize of [undefined, null, {}, 'authorize']) {
        await assert.rejects(
            handleSignedMessage(
                createRequest(),
                createOptions({ authorize })
            ),
            /options.authorize must be a function/
        );
    }

    for (const onAcceptedMessage of [null, {}, 'handle', 1]) {
        await assert.rejects(
            handleSignedMessage(
                createRequest(),
                createOptions({ onAcceptedMessage })
            ),
            /options.onAcceptedMessage must be a function or undefined/
        );
    }

    const invalidLimits = [0, -1, 1.5, Number.NaN, Infinity, '10'];
    for (const field of ['maxBodyBytes', 'maxTextBytes']) {
        for (const value of invalidLimits) {
            await assert.rejects(
                handleSignedMessage(
                    createRequest(),
                    createOptions({ [field]: value })
                ),
                new RegExp(`options\\.${field} must be a positive integer`)
            );
        }
    }
});

test('handleSignedMessage rejects malformed request field values', async () => {
    for (const method of [undefined, null, 1]) {
        await assert.rejects(
            handleSignedMessage(
                createRequest({ method }),
                createOptions()
            ),
            /request.method must be a string/
        );
    }
    for (const contentType of [null, 1, {}]) {
        await assert.rejects(
            handleSignedMessage(
                createRequest({ contentType }),
                createOptions()
            ),
            /request.contentType must be a string or undefined/
        );
    }
    for (const body of [undefined, null, 'body', new ArrayBuffer(1)]) {
        await assert.rejects(
            handleSignedMessage(
                createRequest({ body }),
                createOptions()
            ),
            /request.body must be a Uint8Array/
        );
    }
});
