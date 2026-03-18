import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { createMessageInbox } from '../src/lib/message-inbox.js';
import { createMessageApiServer } from '../src/lib/message-api.js';
import { buildSignedMessagePayload } from '../src/lib/message-signing.js';

function buildServerConfig(signerAddress) {
    return {
        // Bind to loopback for deterministic local tests.
        messageApiHost: '127.0.0.1',
        messageApiPort: 0,
        messageApiKeys: {
            ops: 'k_test_ops_secret',
        },
        messageApiSignerAllowlist: [signerAddress],
        messageApiSignatureMaxAgeSeconds: 300,
        messageApiMaxBodyBytes: 2048,
    };
}

function buildInbox() {
    return createMessageInbox({
        queueLimit: 10,
        defaultTtlSeconds: 60,
        minTtlSeconds: 1,
        maxTtlSeconds: 600,
        idempotencyTtlSeconds: 60,
        maxTextLength: 200,
        rateLimitPerMinute: 10,
        rateLimitBurst: 2,
    });
}

async function main() {
    const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
    const inbox = buildInbox();
    const config = buildServerConfig(account.address);
    const logger = {
        logs: [],
        warnings: [],
        errors: [],
        log(message) {
            this.logs.push(String(message));
        },
        warn(message) {
            this.warnings.push(String(message));
        },
        error(message) {
            this.errors.push(String(message));
        },
    };
    const messageApi = createMessageApiServer({
        config,
        inbox,
        logger,
    });
    const server = await messageApi.start();
    const address = server.address();
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        // Health endpoint should always be probe-friendly and unauthenticated.
        const health = await fetch(`${baseUrl}/healthz`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { ok: true });

        // Message submission must reject unauthenticated callers.
        const unauthorized = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'hello' }),
        });
        assert.equal(unauthorized.status, 401);
        assert.equal(
            logger.warnings.some((line) =>
                line.includes('Message API rejected request') &&
                line.includes('code=missing_bearer_token')
            ),
            true
        );

        const timestampMs = Date.now();
        const signedBody = {
            text: 'Pause proposals for 2 hours',
            command: 'pause_proposals',
            args: { hours: 2 },
            requestId: 'pause-2h',
        };
        const payload = buildSignedMessagePayload({
            address: account.address,
            timestampMs,
            ...signedBody,
        });
        const signature = await account.signMessage({ message: payload });

        // Bearer auth alone must not enqueue unsigned messages.
        const unsigned = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer k_test_ops_secret',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(signedBody),
        });
        assert.equal(unsigned.status, 401);

        // Signed auth alone must not bypass bearer gating when keys are configured.
        const missingBearer = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                ...signedBody,
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs,
                    signature,
                },
            }),
        });
        assert.equal(missingBearer.status, 401);

        // First fully authenticated request should enqueue.
        const accepted = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer k_test_ops_secret',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                ...signedBody,
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs,
                    signature,
                },
            }),
        });
        assert.equal(accepted.status, 202);
        const acceptedJson = await accepted.json();
        assert.equal(acceptedJson.status, 'queued');
        assert.ok(acceptedJson.messageId);

        // Same requestId should return existing message id, not enqueue again.
        const duplicate = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer k_test_ops_secret',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                ...signedBody,
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs,
                    signature,
                },
            }),
        });
        assert.equal(duplicate.status, 200);
        const duplicateJson = await duplicate.json();
        assert.equal(duplicateJson.status, 'duplicate');
        assert.equal(duplicateJson.messageId, acceptedJson.messageId);
        assert.equal(
            logger.warnings.some((line) =>
                line.includes('Message API ignored duplicate request') &&
                line.includes('requestId=pause-2h')
            ),
            true
        );

        // Body validation should catch schema violations.
        const badRequest = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer k_test_ops_secret',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: 42 }),
        });
        assert.equal(badRequest.status, 400);
        assert.equal(
            logger.warnings.some((line) =>
                line.includes('Message API rejected request') &&
                line.includes('code=invalid_request') &&
                line.includes('text is required and must be a string')
            ),
            true
        );

        // Inbox should contain exactly one queued userMessage from the accepted request.
        const batch = inbox.takeBatch({ maxItems: 2 });
        assert.equal(batch.length, 1);
        assert.equal(batch[0].kind, 'userMessage');
        assert.equal(batch[0].sender.authType, 'eip191');
        assert.equal(batch[0].sender.address, account.address);
        inbox.ackBatch(batch.map((message) => message.messageId));
        assert.equal(inbox.getQueueDepth(), 0);
    } finally {
        await messageApi.stop();
    }

    // If a bind fails (for example port already in use), start() should remain retryable.
    const blockerInbox = buildInbox();
    const blockerApi = createMessageApiServer({
        config: buildServerConfig(account.address),
        inbox: blockerInbox,
        logger: { log() {} },
    });
    const blockerServer = await blockerApi.start();
    const blockerAddress = blockerServer.address();
    assert.ok(
        blockerAddress &&
            typeof blockerAddress === 'object' &&
            typeof blockerAddress.port === 'number'
    );

    const retryInbox = buildInbox();
    const retryApi = createMessageApiServer({
        config: {
            ...buildServerConfig(account.address),
            messageApiPort: blockerAddress.port,
        },
        inbox: retryInbox,
        logger: { log() {} },
    });

    let bindError;
    try {
        await retryApi.start();
    } catch (error) {
        bindError = error;
    }
    assert.ok(bindError);
    assert.equal(bindError.code, 'EADDRINUSE');

    // Once the conflicting listener is gone, the same API instance should start cleanly.
    await blockerApi.stop();
    const recoveredServer = await retryApi.start();
    assert.equal(recoveredServer.listening, true);
    await retryApi.stop();

    console.log('[test] message API OK');
}

main().catch((error) => {
    console.error('[test] message API failed:', error.message ?? error);
    process.exit(1);
});
