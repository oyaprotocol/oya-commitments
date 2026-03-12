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
        requestId: 'sig-1',
        senderKeyId: 'addr:0x1111111111111111111111111111111111111111',
        sender,
        nowMs: 1_000,
    });
    assert.equal(first.ok, true);
    assert.equal(first.status, 'queued');

    // Message TTL has elapsed, but signed replay lock must still block key reuse.
    const blockedReplay = inbox.submitMessage({
        text: 'pause proposals replay',
        requestId: 'sig-1',
        senderKeyId: 'addr:0x1111111111111111111111111111111111111111',
        sender,
        nowMs: 2_500,
    });
    assert.equal(blockedReplay.ok, false);
    assert.equal(blockedReplay.code, 'request_replay_blocked');
    assert.equal(blockedReplay.messageId, first.message.messageId);
    assert.equal(blockedReplay.replayLockedUntilMs, 6_000);

    // Once replay window expires, the same key can be accepted as a fresh message again.
    const acceptedAfterWindow = inbox.submitMessage({
        text: 'pause proposals replay after lock expiry',
        requestId: 'sig-1',
        senderKeyId: 'addr:0x1111111111111111111111111111111111111111',
        sender,
        nowMs: 6_100,
    });
    assert.equal(acceptedAfterWindow.ok, true);
    assert.equal(acceptedAfterWindow.status, 'queued');
    assert.notEqual(acceptedAfterWindow.message.messageId, first.message.messageId);

    // Future-skewed signed timestamps should extend replay lock to signedAt + replay window.
    const futureSkewSender = {
        ...sender,
        signedAtMs: 13_000,
    };
    const skewed = inbox.submitMessage({
        text: 'future-skewed signed command',
        requestId: 'sig-future-skew',
        senderKeyId: 'addr:0x1111111111111111111111111111111111111111',
        sender: futureSkewSender,
        nowMs: 10_000,
    });
    assert.equal(skewed.ok, true);
    assert.equal(skewed.status, 'queued');

    // This would have been accepted previously at 15_001 (now + replay window),
    // but should stay blocked until signedAt + replay window (18_000).
    const blockedBeforeSignedWindowEnd = inbox.submitMessage({
        text: 'future-skewed replay',
        requestId: 'sig-future-skew',
        senderKeyId: 'addr:0x1111111111111111111111111111111111111111',
        sender: futureSkewSender,
        nowMs: 16_000,
    });
    assert.equal(blockedBeforeSignedWindowEnd.ok, false);
    assert.equal(blockedBeforeSignedWindowEnd.code, 'request_replay_blocked');
    assert.equal(blockedBeforeSignedWindowEnd.replayLockedUntilMs, 18_000);

    const acceptedAfterSignedWindowEnd = inbox.submitMessage({
        text: 'future-skewed replay after signed window',
        requestId: 'sig-future-skew',
        senderKeyId: 'addr:0x1111111111111111111111111111111111111111',
        sender: futureSkewSender,
        nowMs: 18_100,
    });
    assert.equal(acceptedAfterSignedWindowEnd.ok, true);
    assert.equal(acceptedAfterSignedWindowEnd.status, 'queued');
    assert.notEqual(acceptedAfterSignedWindowEnd.message.messageId, skewed.message.messageId);

    console.log('[test] message inbox signed replay lock OK');
}

run().catch((error) => {
    console.error('[test] message inbox signed replay lock failed:', error?.message ?? error);
    process.exit(1);
});
