import assert from 'node:assert/strict';
import { createMessageInbox } from '../src/lib/message-inbox.js';
import { processQueuedUserMessages } from '../src/lib/message-loop.js';
import { DECISION_STATUS } from '../src/lib/decision-support.js';

function createFailingInbox(baseInbox, { failOnAckMessageId }) {
    return {
        ...baseInbox,
        ackBatch(messageIds, nowMs) {
            if (messageIds.includes(failOnAckMessageId)) {
                throw new Error('simulated ack failure');
            }
            return baseInbox.ackBatch(messageIds, nowMs);
        },
    };
}

async function run() {
    const startMs = Date.now();
    const baseInbox = createMessageInbox({
        queueLimit: 10,
        defaultTtlSeconds: 60,
        minTtlSeconds: 1,
        maxTtlSeconds: 600,
        idempotencyTtlSeconds: 300,
        maxTextLength: 200,
        rateLimitPerMinute: 100,
        rateLimitBurst: 100,
    });

    const first = baseInbox.submitMessage({
        text: 'first',
        senderKeyId: 'ops',
        nowMs: startMs,
    });
    const second = baseInbox.submitMessage({
        text: 'second',
        senderKeyId: 'ops',
        nowMs: startMs + 1,
    });
    const third = baseInbox.submitMessage({
        text: 'third',
        senderKeyId: 'ops',
        nowMs: startMs + 2,
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(third.ok, true);

    const inbox = createFailingInbox(baseInbox, {
        failOnAckMessageId: second.message.messageId,
    });
    const logger = {
        errors: [],
        error(...args) {
            this.errors.push(args);
        },
    };

    await processQueuedUserMessages({
        messageInbox: inbox,
        maxBatchSize: 10,
        nowMs: startMs + 10,
        latestBlock: 1n,
        onchainPendingProposal: false,
        prepareSignals: async (signals) => signals,
        decideOnSignals: async () => DECISION_STATUS.HANDLED,
        logger,
    });

    const retriedBatch = baseInbox.takeBatch({ maxItems: 10, nowMs: startMs + 11 });
    const retriedIds = retriedBatch.map((message) => message.messageId);

    assert.deepEqual(retriedIds, [second.message.messageId, third.message.messageId]);
    assert.equal(retriedIds.includes(first.message.messageId), false);
    assert.equal(logger.errors.some((entry) => entry[0] === '[agent] loop error'), true);

    console.log('[test] message loop rescue OK');
}

run().catch((error) => {
    console.error('[test] message loop rescue failed:', error?.message ?? error);
    process.exit(1);
});
