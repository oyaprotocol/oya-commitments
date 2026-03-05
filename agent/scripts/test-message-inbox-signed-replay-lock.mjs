import assert from 'node:assert/strict';
import { createMessageInbox } from '../src/lib/message-inbox.js';

async function run() {
    const inbox = createMessageInbox({
        queueLimit: 10,
        defaultTtlSeconds: 1,
        minTtlSeconds: 1,
        maxTtlSeconds: 60,
        idempotencyTtlSeconds: 2,
        signedReplayWindowSeconds: 5,
        maxTextLength: 200,
        rateLimitPerMinute: 100,
        rateLimitBurst: 100,
    });

    const sender = {
        authType: 'eip191',
        address: '0x1111111111111111111111111111111111111111',
        signedAtMs: 1_000,
    };

    const first = inbox.submitMessage({
        text: 'pause proposals',
        idempotencyKey: 'sig-1',
        senderKeyId: 'addr:0x1111111111111111111111111111111111111111',
        sender,
        nowMs: 1_000,
    });
    assert.equal(first.ok, true);
    assert.equal(first.status, 'queued');

    // Message TTL has elapsed, but signed replay lock must still block key reuse.
    const blockedReplay = inbox.submitMessage({
        text: 'pause proposals replay',
        idempotencyKey: 'sig-1',
        senderKeyId: 'addr:0x1111111111111111111111111111111111111111',
        sender,
        nowMs: 2_500,
    });
    assert.equal(blockedReplay.ok, false);
    assert.equal(blockedReplay.code, 'idempotency_replay_blocked');
    assert.equal(blockedReplay.messageId, first.message.messageId);
    assert.equal(blockedReplay.replayLockedUntilMs, 6_000);

    // Once replay window expires, the same key can be accepted as a fresh message again.
    const acceptedAfterWindow = inbox.submitMessage({
        text: 'pause proposals replay after lock expiry',
        idempotencyKey: 'sig-1',
        senderKeyId: 'addr:0x1111111111111111111111111111111111111111',
        sender,
        nowMs: 6_100,
    });
    assert.equal(acceptedAfterWindow.ok, true);
    assert.equal(acceptedAfterWindow.status, 'queued');
    assert.notEqual(acceptedAfterWindow.message.messageId, first.message.messageId);

    console.log('[test] message inbox signed replay lock OK');
}

run().catch((error) => {
    console.error('[test] message inbox signed replay lock failed:', error?.message ?? error);
    process.exit(1);
});
