import assert from 'node:assert/strict';
import { createMessageInbox } from '../src/lib/message-inbox.js';

async function run() {
    const shortIdempotencyInbox = createMessageInbox({
        queueLimit: 10,
        defaultTtlSeconds: 10,
        minTtlSeconds: 1,
        maxTtlSeconds: 60,
        idempotencyTtlSeconds: 2,
        maxTextLength: 200,
        rateLimitPerMinute: 100,
        rateLimitBurst: 100,
    });

    // Even with a short idempotency TTL, duplicates must remain deduped
    // while the original message is still alive in queue/in-flight.
    const longLived = shortIdempotencyInbox.submitMessage({
        text: 'long lived command',
        idempotencyKey: 'cmd-live',
        senderKeyId: 'ops',
        nowMs: 1_000,
    });
    assert.equal(longLived.ok, true);
    assert.equal(longLived.status, 'queued');

    const duplicateWhileStillLive = shortIdempotencyInbox.submitMessage({
        text: 'long lived command duplicate',
        idempotencyKey: 'cmd-live',
        senderKeyId: 'ops',
        nowMs: 4_500,
    });
    assert.equal(duplicateWhileStillLive.ok, true);
    assert.equal(duplicateWhileStillLive.status, 'duplicate');
    assert.equal(duplicateWhileStillLive.message.messageId, longLived.message.messageId);

    // API-key callers may still reuse keys after the original message expires.
    const acceptedAfterLongLivedExpiry = shortIdempotencyInbox.submitMessage({
        text: 'long lived command replay after expiry',
        idempotencyKey: 'cmd-live',
        senderKeyId: 'ops',
        nowMs: 11_100,
    });
    assert.equal(acceptedAfterLongLivedExpiry.ok, true);
    assert.equal(acceptedAfterLongLivedExpiry.status, 'queued');
    assert.notEqual(acceptedAfterLongLivedExpiry.message.messageId, longLived.message.messageId);

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
