import assert from 'node:assert/strict';
import { createMessageInbox } from '../src/lib/message-inbox.js';

async function run() {
    const inbox = createMessageInbox({
        queueLimit: 10,
        defaultTtlSeconds: 60,
        minTtlSeconds: 1,
        maxTtlSeconds: 600,
        idempotencyTtlSeconds: 300,
        maxTextLength: 200,
        // One request/token per second with a single-token burst.
        rateLimitPerMinute: 60,
        rateLimitBurst: 1,
    });

    const startMs = 1_000;
    const first = inbox.submitMessage({
        text: 'pause for 2h',
        requestId: 'pause-2h',
        senderKeyId: 'ops',
        nowMs: startMs,
    });
    assert.equal(first.ok, true);
    assert.equal(first.status, 'queued');

    // Duplicate replays should still be subject to rate limiting.
    const immediateDuplicate = inbox.submitMessage({
        text: 'pause for 2h',
        requestId: 'pause-2h',
        senderKeyId: 'ops',
        nowMs: startMs,
    });
    assert.equal(immediateDuplicate.ok, false);
    assert.equal(immediateDuplicate.code, 'rate_limited');

    // After refill, the same idempotency key should dedupe to the original message id.
    const delayedDuplicate = inbox.submitMessage({
        text: 'pause for 2h',
        requestId: 'pause-2h',
        senderKeyId: 'ops',
        nowMs: startMs + 1_000,
    });
    assert.equal(delayedDuplicate.ok, true);
    assert.equal(delayedDuplicate.status, 'duplicate');
    assert.equal(delayedDuplicate.message.messageId, first.message.messageId);

    const batch = inbox.takeBatch({ maxItems: 5, nowMs: startMs + 1_000 });
    assert.equal(batch.length, 1);
    assert.equal(batch[0].messageId, first.message.messageId);

    console.log('[test] message inbox duplicate replay rate limiting OK');
}

run().catch((error) => {
    console.error(
        '[test] message inbox duplicate replay rate limiting failed:',
        error?.message ?? error
    );
    process.exit(1);
});
