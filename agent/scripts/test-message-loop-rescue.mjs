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
        warnings: [],
        error(...args) {
            this.errors.push(args);
        },
        warn(...args) {
            this.warnings.push(args);
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

    const noActionResult = baseInbox.submitMessage({
        text: 'no action',
        requestId: 'no-action',
        senderKeyId: 'ops',
        sender: { address: '0x0000000000000000000000000000000000000001' },
        nowMs: startMs + 20,
    });
    assert.equal(noActionResult.ok, true);

    await processQueuedUserMessages({
        messageInbox: baseInbox,
        maxBatchSize: 10,
        nowMs: startMs + 21,
        latestBlock: 2n,
        onchainPendingProposal: false,
        prepareSignals: async (signals) => signals,
        decideOnSignals: async () => DECISION_STATUS.NO_ACTION,
        logger,
    });
    assert.equal(
        logger.warnings.some(
            (entry) =>
                String(entry[0]).includes('User message produced no action') &&
                String(entry[0]).includes('requestId=no-action')
        ),
        true
    );

    const failedResult = baseInbox.submitMessage({
        text: 'fail',
        requestId: 'fail-once',
        senderKeyId: 'ops',
        sender: { address: '0x0000000000000000000000000000000000000002' },
        nowMs: startMs + 22,
    });
    assert.equal(failedResult.ok, true);

    await processQueuedUserMessages({
        messageInbox: baseInbox,
        maxBatchSize: 10,
        nowMs: startMs + 23,
        latestBlock: 3n,
        onchainPendingProposal: false,
        prepareSignals: async (signals) => signals,
        decideOnSignals: async () => DECISION_STATUS.FAILED_NON_RETRYABLE,
        logger,
    });
    assert.equal(
        logger.errors.some(
            (entry) =>
                String(entry[0]).includes('User message failed non-retryably') &&
                String(entry[0]).includes('requestId=fail-once')
        ),
        true
    );

    console.log('[test] message loop rescue OK');
}

run().catch((error) => {
    console.error('[test] message loop rescue failed:', error?.message ?? error);
    process.exit(1);
});
