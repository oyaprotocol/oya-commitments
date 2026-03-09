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
        rateLimitPerMinute: 100,
        rateLimitBurst: 100,
    });

    // This pair would collide in a naive `${sender}:${key}` namespace.
    const first = inbox.submitMessage({
        text: 'from sender a',
        idempotencyKey: 'b:c',
        senderKeyId: 'a',
        nowMs: 1_000,
    });
    assert.equal(first.ok, true);
    assert.equal(first.status, 'queued');

    const second = inbox.submitMessage({
        text: 'from sender a:b',
        idempotencyKey: 'c',
        senderKeyId: 'a:b',
        nowMs: 1_001,
    });
    assert.equal(second.ok, true);
    assert.equal(second.status, 'queued');
    assert.notEqual(second.message.messageId, first.message.messageId);

    // Same sender+key still dedupes.
    const duplicate = inbox.submitMessage({
        text: 'from sender a duplicate',
        idempotencyKey: 'b:c',
        senderKeyId: 'a',
        nowMs: 1_002,
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.message.messageId, first.message.messageId);

    const batch = inbox.takeBatch({ maxItems: 5, nowMs: 1_010 });
    assert.equal(batch.length, 2);
    const ids = new Set(batch.map((message) => message.messageId));
    assert.equal(ids.has(first.message.messageId), true);
    assert.equal(ids.has(second.message.messageId), true);

    console.log('[test] message inbox idempotency isolation OK');
}

run().catch((error) => {
    console.error('[test] message inbox idempotency isolation failed:', error?.message ?? error);
    process.exit(1);
});
