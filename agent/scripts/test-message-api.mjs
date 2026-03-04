import assert from 'node:assert/strict';
import { createMessageInbox } from '../src/lib/message-inbox.js';
import { createMessageApiServer } from '../src/lib/message-api.js';

function buildServerConfig() {
    return {
        messageApiHost: '127.0.0.1',
        messageApiPort: 0,
        messageApiKeys: {
            ops: 'k_test_ops_secret',
        },
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
    const inbox = buildInbox();
    const config = buildServerConfig();
    const messageApi = createMessageApiServer({
        config,
        inbox,
        logger: { log() {} },
    });
    const server = await messageApi.start();
    const address = server.address();
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number');
    const baseUrl = `http://${config.messageApiHost}:${address.port}`;

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

        // First authenticated request should enqueue.
        const accepted = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer k_test_ops_secret',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: 'Pause proposals for 2 hours',
                command: 'pause_proposals',
                args: { hours: 2 },
                idempotencyKey: 'pause-2h',
            }),
        });
        assert.equal(accepted.status, 202);
        const acceptedJson = await accepted.json();
        assert.equal(acceptedJson.status, 'queued');
        assert.ok(acceptedJson.messageId);

        // Same idempotency key should return existing message id, not enqueue again.
        const duplicate = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer k_test_ops_secret',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: 'Pause proposals for 2 hours',
                command: 'pause_proposals',
                args: { hours: 2 },
                idempotencyKey: 'pause-2h',
            }),
        });
        assert.equal(duplicate.status, 200);
        const duplicateJson = await duplicate.json();
        assert.equal(duplicateJson.status, 'duplicate');
        assert.equal(duplicateJson.messageId, acceptedJson.messageId);

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

        // Inbox should contain exactly one queued userMessage from the accepted request.
        const batch = inbox.takeBatch({ maxItems: 2 });
        assert.equal(batch.length, 1);
        assert.equal(batch[0].kind, 'userMessage');
        inbox.ackBatch(batch.map((message) => message.messageId));
        assert.equal(inbox.getQueueDepth(), 0);
    } finally {
        await messageApi.stop();
    }

    console.log('[test] message API OK');
}

main().catch((error) => {
    console.error('[test] message API failed:', error.message ?? error);
    process.exit(1);
});
