import {
    DECISION_STATUS,
    isRetryableDecisionError,
    shouldRequeueMessagesForDecisionStatus,
} from './decision-support.js';

function toUserMessageSignal(message) {
    return {
        kind: 'userMessage',
        messageId: message.messageId,
        requestId: message.requestId,
        text: message.text,
        command: message.command,
        args: message.args,
        metadata: message.metadata,
        sender: message.sender,
        deadline: message.deadline,
        receivedAtMs: message.receivedAtMs,
        expiresAtMs: message.expiresAtMs,
    };
}

function describeMessage(message) {
    const parts = [];
    if (typeof message?.messageId === 'string' && message.messageId.trim()) {
        parts.push(`messageId=${message.messageId}`);
    }
    if (typeof message?.requestId === 'string' && message.requestId.trim()) {
        parts.push(`requestId=${message.requestId}`);
    }
    if (typeof message?.command === 'string' && message.command.trim()) {
        parts.push(`command=${message.command}`);
    }
    if (typeof message?.sender?.address === 'string' && message.sender.address.trim()) {
        parts.push(`signer=${message.sender.address}`);
    } else if (typeof message?.sender?.keyId === 'string' && message.sender.keyId.trim()) {
        parts.push(`senderKeyId=${message.sender.keyId}`);
    }
    return parts.length > 0 ? parts.join(' ') : 'message=<unknown>';
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

        if (queuedMessages.length > 0) {
            logger.log?.(
                `[agent] Processing ${queuedMessages.length} queued user message(s) at block ${latestBlock?.toString?.() ?? latestBlock}.`
            );
        }

        for (const message of queuedMessages) {
            activeMessageId = message.messageId;
            activeMessageSettled = false;
            let messageDecisionStatus = DECISION_STATUS.NO_ACTION;
            logger.log?.(
                `[agent] Handling queued user message (${describeMessage(message)}).`
            );
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

            if (messageDecisionStatus === DECISION_STATUS.NO_ACTION) {
                logger.warn?.(
                    `[agent] User message produced no action (${describeMessage(message)}).`
                );
            } else if (messageDecisionStatus === DECISION_STATUS.FAILED_RETRYABLE) {
                logger.warn?.(
                    `[agent] User message failed retryably (${describeMessage(message)}); requeueing.`
                );
            } else if (messageDecisionStatus === DECISION_STATUS.INVALID_TOOL_ARGS) {
                logger.warn?.(
                    `[agent] User message produced invalid tool args (${describeMessage(message)}); requeueing.`
                );
            } else if (messageDecisionStatus === DECISION_STATUS.FAILED_NON_RETRYABLE) {
                logger.error?.(
                    `[agent] User message failed non-retryably (${describeMessage(message)}).`
                );
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
