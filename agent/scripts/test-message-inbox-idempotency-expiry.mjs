import assert from 'node:assert/strict';
import { createMessageInbox } from '../src/lib/message-inbox.js';

async function run() {
    const inbox = createMessageInbox({
        queueLimit: 10,
        defaultTtlSeconds: 1,
        minTtlSeconds: 1,
        maxTtlSeconds: 60,
        idempotencyTtlSeconds: 30,
        maxTextLength: 200,
        rateLimitPerMinute: 100,
        rateLimitBurst: 100,
    });

    const startMs = 1_000;
    const first = inbox.submitMessage({
        text: 'first command',
        idempotencyKey: 'cmd-1',
        senderKeyId: 'ops',
        nowMs: startMs,
    });
    assert.equal(first.ok, true);
    assert.equal(first.status, 'queued');

    // API-key callers may reuse keys after message TTL if replay-lock mode is not enabled.
    const retryAfterMessageExpiry = inbox.submitMessage({
        text: 'first command retry',
        idempotencyKey: 'cmd-1',
        senderKeyId: 'ops',
        nowMs: startMs + 2_000,
    });
    assert.equal(retryAfterMessageExpiry.ok, true);
    assert.equal(retryAfterMessageExpiry.status, 'queued');
    assert.notEqual(retryAfterMessageExpiry.message.messageId, first.message.messageId);

    const batch = inbox.takeBatch({ maxItems: 5, nowMs: startMs + 2_000 });
    assert.equal(batch.length, 1);
    assert.equal(batch[0].messageId, retryAfterMessageExpiry.message.messageId);

    console.log('[test] message inbox idempotency expiry OK');
}

run().catch((error) => {
    console.error('[test] message inbox idempotency expiry failed:', error?.message ?? error);
    process.exit(1);
});
