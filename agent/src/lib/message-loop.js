import {
    DECISION_STATUS,
    isRetryableDecisionError,
    shouldRequeueMessagesForDecisionStatus,
} from './decision-support.js';

function toUserMessageSignal(message) {
    return {
        kind: 'userMessage',
        messageId: message.messageId,
        text: message.text,
        command: message.command,
        args: message.args,
        metadata: message.metadata,
        sender: message.sender,
        receivedAtMs: message.receivedAtMs,
        expiresAtMs: message.expiresAtMs,
    };
}

async function processQueuedUserMessages({
    messageInbox,
    maxBatchSize,
    nowMs,
    latestBlock,
    onchainPendingProposal = false,
    prepareSignals,
    decideOnSignals,
    logger = console,
}) {
    if (!messageInbox) {
        return;
    }

    const pendingMessageIds = new Set();
    let activeMessageId = null;
    let activeMessageSettled = false;

    try {
        const queuedMessages = [];
        const batch = messageInbox.takeBatch({
            maxItems: maxBatchSize,
            nowMs: Date.now(),
        });
        for (const message of batch) {
            queuedMessages.push(message);
            pendingMessageIds.add(message.messageId);
        }

        for (const message of queuedMessages) {
            activeMessageId = message.messageId;
            activeMessageSettled = false;
            let messageDecisionStatus = DECISION_STATUS.NO_ACTION;
            try {
                // Evaluate user messages with message-only signals so non-message events
                // are not replayed once per message in the same poll loop.
                const messageSignals = await prepareSignals([toUserMessageSignal(message)], {
                    nowMs,
                    latestBlock,
                    onchainPendingProposal,
                });
                if (messageSignals.length > 0) {
                    messageDecisionStatus = await decideOnSignals(messageSignals, {
                        onchainPendingProposal,
                    });
                }
            } catch (error) {
                const retryableMessageError = isRetryableDecisionError(error);
                logger.error('[agent] Failed to process user message:', error);
                messageDecisionStatus = retryableMessageError
                    ? DECISION_STATUS.FAILED_RETRYABLE
                    : DECISION_STATUS.FAILED_NON_RETRYABLE;
            }

            if (shouldRequeueMessagesForDecisionStatus(messageDecisionStatus)) {
                messageInbox.requeueBatch([message.messageId]);
            } else {
                messageInbox.ackBatch([message.messageId]);
            }
            activeMessageSettled = true;
            pendingMessageIds.delete(message.messageId);
            activeMessageId = null;
        }
    } catch (error) {
        if (activeMessageSettled && activeMessageId) {
            pendingMessageIds.delete(activeMessageId);
        }
        if (pendingMessageIds.size > 0) {
            // Only rescue messages that never reached per-message settlement in this loop.
            messageInbox.requeueBatch([...pendingMessageIds]);
        }
        logger.error('[agent] loop error', error);
    }
}

export { processQueuedUserMessages, toUserMessageSignal };
