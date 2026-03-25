import {
    clearStageAmbiguity,
    clearStageDispatchStarted,
    clearStageSubmissionTracking,
    markStageAmbiguity,
} from './lifecycle-stage.js';

export function getParsedToolOutputStatus(parsedOutput) {
    return typeof parsedOutput?.status === 'string' && parsedOutput.status.trim()
        ? parsedOutput.status.trim()
        : 'unknown';
}

export function getParsedToolOutputDetail(parsedOutput, status) {
    if (typeof parsedOutput?.message === 'string' && parsedOutput.message.trim()) {
        return parsedOutput.message.trim();
    }
    if (typeof parsedOutput?.reason === 'string' && parsedOutput.reason.trim()) {
        return parsedOutput.reason.trim();
    }
    return `tool returned status=${status}`;
}

export function reduceArchiveToolOutput(
    intent,
    parsedOutput,
    { retryDelayMs, markTerminalIntentFailure, nowMs = Date.now() } = {}
) {
    const status = getParsedToolOutputStatus(parsedOutput);
    if (status !== 'published') {
        intent.lastArchiveError = getParsedToolOutputDetail(parsedOutput, status);
        intent.lastArchiveStatus = status;
        intent.nextArchiveAttemptAtMs = nowMs + retryDelayMs;
        intent.updatedAtMs = nowMs;
        if (parsedOutput?.retryable === false && parsedOutput?.sideEffectsLikelyCommitted !== true) {
            markTerminalIntentFailure(intent, {
                stage: 'archive',
                status,
                detail: intent.lastArchiveError,
                releaseCredit: true,
            });
        }
        return { changed: true, published: false };
    }

    const cid =
        typeof parsedOutput?.cid === 'string' && parsedOutput.cid.trim()
            ? parsedOutput.cid.trim()
            : null;
    const uri =
        typeof parsedOutput?.uri === 'string' && parsedOutput.uri.trim()
            ? parsedOutput.uri.trim()
            : cid
                ? `ipfs://${cid}`
                : null;
    intent.artifactCid = cid;
    intent.artifactUri = uri;
    intent.pinned = parsedOutput?.pinned ?? parsedOutput?.pin ?? null;
    intent.archivedAtMs = nowMs;
    intent.nextArchiveAttemptAtMs = null;
    intent.lastArchiveError = null;
    intent.lastArchiveStatus = 'published';
    intent.updatedAtMs = nowMs;
    return { changed: true, published: true };
}

export function reduceOrderToolOutput(
    intent,
    parsedOutput,
    {
        retryDelayMs,
        extractOrderIdFromSubmission,
        extractOrderStatusFromSubmission,
        markTerminalIntentFailure,
        nowMs = Date.now(),
    } = {}
) {
    clearStageDispatchStarted(intent, 'order');

    const status = getParsedToolOutputStatus(parsedOutput);
    if (status !== 'submitted') {
        const detail = getParsedToolOutputDetail(parsedOutput, status);
        const sideEffectsLikelyCommitted = parsedOutput?.sideEffectsLikelyCommitted === true;
        if (parsedOutput?.retryable === false && !sideEffectsLikelyCommitted) {
            markTerminalIntentFailure(intent, {
                stage: 'order_submission',
                status,
                detail,
                releaseCredit: true,
            });
            return { changed: true };
        }

        intent.lastOrderSubmissionStatus = status;
        intent.lastOrderSubmissionError = detail;
        intent.nextOrderAttemptAtMs = nowMs + retryDelayMs;
        if (sideEffectsLikelyCommitted) {
            intent.orderSubmittedAtMs = nowMs;
            intent.orderStatusRefreshFailedAtMs = nowMs;
            delete intent.nextOrderAttemptAtMs;
        }
        intent.updatedAtMs = nowMs;
        return { changed: true };
    }

    intent.orderId = extractOrderIdFromSubmission(parsedOutput);
    intent.orderStatus = extractOrderStatusFromSubmission(parsedOutput);
    if (!intent.orderId) {
        intent.lastOrderSubmissionStatus = 'missing_order_id';
        intent.lastOrderSubmissionError =
            'Polymarket order submission returned submitted without an order id; refusing automatic retry until reconciled.';
        intent.orderSubmittedAtMs = nowMs;
        intent.orderStatusRefreshFailedAtMs = nowMs;
        delete intent.nextOrderAttemptAtMs;
        intent.updatedAtMs = nowMs;
        return { changed: true };
    }

    delete intent.lastOrderSubmissionStatus;
    delete intent.lastOrderSubmissionError;
    delete intent.nextOrderAttemptAtMs;
    intent.orderSubmittedAtMs = nowMs;
    intent.updatedAtMs = nowMs;
    return { changed: true };
}

export function reduceDepositToolOutput(
    intent,
    parsedOutput,
    { retryDelayMs, normalizeHash, markTerminalIntentFailure, nowMs = Date.now() } = {}
) {
    clearStageDispatchStarted(intent, 'deposit');

    const status = getParsedToolOutputStatus(parsedOutput);
    if (status === 'confirmed' || status === 'submitted') {
        const txHash = normalizeHash(parsedOutput?.transactionHash);
        if (!txHash) {
            intent.lastDepositStatus = 'missing_tx_hash';
            intent.lastDepositError =
                `ERC1155 deposit returned ${status} without a transaction hash; refusing automatic retry until reconciled.`;
            intent.depositSubmittedAtMs = nowMs;
            delete intent.nextDepositAttemptAtMs;
            markStageAmbiguity(intent, 'deposit', intent.lastDepositError, nowMs);
            return { changed: true };
        }
        intent.depositTxHash = txHash;
        intent.depositSubmittedAtMs = nowMs;
        delete intent.lastDepositStatus;
        delete intent.lastDepositError;
        delete intent.nextDepositAttemptAtMs;
        clearStageAmbiguity(intent, 'deposit');
        if (status === 'submitted' && parsedOutput?.pendingConfirmation === true) {
            markStageAmbiguity(intent, 'deposit', parsedOutput?.warning ?? null, nowMs);
        }
        if (status === 'confirmed') {
            intent.tokenDeposited = true;
            intent.tokenDepositedAtMs = nowMs;
            clearStageAmbiguity(intent, 'deposit');
        }
        intent.updatedAtMs = nowMs;
        return { changed: true };
    }

    const detail = getParsedToolOutputDetail(parsedOutput, status);
    intent.lastDepositStatus = status;
    intent.lastDepositError = detail;
    if (parsedOutput?.sideEffectsLikelyCommitted === true) {
        intent.depositTxHash = normalizeHash(parsedOutput?.transactionHash) ?? intent.depositTxHash;
        intent.depositSubmittedAtMs = nowMs;
        delete intent.nextDepositAttemptAtMs;
        markStageAmbiguity(intent, 'deposit', detail, nowMs);
        return { changed: true };
    }
    if (status === 'skipped' || parsedOutput?.retryable === false) {
        markTerminalIntentFailure(intent, {
            stage: 'deposit',
            status,
            detail,
            releaseCredit: false,
        });
        return { changed: true };
    }

    delete intent.depositSubmittedAtMs;
    clearStageAmbiguity(intent, 'deposit');
    intent.nextDepositAttemptAtMs = nowMs + retryDelayMs;
    intent.updatedAtMs = nowMs;
    return { changed: true };
}

export function reduceReimbursementToolOutput(
    intent,
    parsedOutput,
    {
        retryDelayMs,
        pendingExplanation,
        normalizeHash,
        resolveOgProposalHashFromToolOutput,
        markTerminalIntentFailure,
        nowMs = Date.now(),
    } = {}
) {
    clearStageDispatchStarted(intent, 'reimbursement');

    const status = getParsedToolOutputStatus(parsedOutput);
    if (status !== 'submitted') {
        const detail = getParsedToolOutputDetail(parsedOutput, status);
        const ambiguousSubmission =
            status === 'pending' || parsedOutput?.sideEffectsLikelyCommitted === true;
        intent.lastReimbursementSubmissionStatus = status;
        intent.lastReimbursementSubmissionError = detail;
        if (ambiguousSubmission) {
            intent.reimbursementSubmittedAtMs = nowMs;
            markStageAmbiguity(intent, 'reimbursement', detail, nowMs);
            return { changed: true };
        }

        if (status === 'skipped' || parsedOutput?.retryable === false) {
            markTerminalIntentFailure(intent, {
                stage: 'reimbursement_submission',
                status,
                detail,
                releaseCredit: false,
            });
            return { changed: true };
        }

        delete intent.reimbursementSubmittedAtMs;
        clearStageAmbiguity(intent, 'reimbursement');
        intent.nextReimbursementAttemptAtMs = nowMs + retryDelayMs;
        intent.updatedAtMs = nowMs;
        return { changed: true };
    }

    const proposalHash = resolveOgProposalHashFromToolOutput(parsedOutput);
    const txHash = normalizeHash(parsedOutput?.transactionHash);
    intent.reimbursementExplanation = pendingExplanation ?? intent.reimbursementExplanation;
    delete intent.lastReimbursementSubmissionStatus;
    delete intent.lastReimbursementSubmissionError;
    clearStageAmbiguity(intent, 'reimbursement');
    if (proposalHash) {
        intent.reimbursementProposalHash = proposalHash;
        intent.reimbursementSubmissionTxHash = txHash;
        delete intent.reimbursementSubmittedAtMs;
    } else if (txHash) {
        intent.reimbursementSubmissionTxHash = txHash;
        intent.reimbursementSubmittedAtMs = nowMs;
    } else {
        intent.reimbursementSubmittedAtMs = nowMs;
        markStageAmbiguity(
            intent,
            'reimbursement',
            'Reimbursement proposal returned submitted without proposal hash or transaction hash.',
            nowMs
        );
    }
    intent.updatedAtMs = nowMs;
    return { changed: true };
}

export function reduceDepositSubmissionMissingTxTimeout(intent, { nowMs = Date.now() } = {}) {
    delete intent.depositSubmittedAtMs;
    intent.updatedAtMs = nowMs;
    return true;
}

export function reduceDepositSubmissionConfirmedReceipt(
    intent,
    { receipt, latestBlock, nowMs = Date.now() } = {}
) {
    const blockNumber = BigInt(receipt?.blockNumber ?? latestBlock);
    intent.depositBlockNumber = blockNumber.toString();
    intent.tokenDeposited = true;
    intent.tokenDepositedAtMs = nowMs;
    clearStageDispatchStarted(intent, 'deposit');
    clearStageAmbiguity(intent, 'deposit');
    intent.updatedAtMs = nowMs;
    return true;
}

export function reduceDepositSubmissionRevertedReceipt(
    intent,
    { nowMs = Date.now(), retryDelayMs = null } = {}
) {
    delete intent.depositTxHash;
    delete intent.depositSubmittedAtMs;
    clearStageDispatchStarted(intent, 'deposit');
    clearStageAmbiguity(intent, 'deposit');
    intent.lastDepositStatus = 'reverted';
    intent.lastDepositError = 'ERC1155 deposit transaction reverted onchain.';
    if (Number.isInteger(retryDelayMs) && retryDelayMs > 0) {
        intent.nextDepositAttemptAtMs = nowMs + retryDelayMs;
    }
    intent.updatedAtMs = nowMs;
    return true;
}

export function reduceDepositSubmissionReceiptTimeout(
    intent,
    { detail, nowMs = Date.now() } = {}
) {
    if (
        intent.lastDepositReceiptError === detail &&
        Number.isInteger(intent.depositSubmissionAmbiguousAtMs)
    ) {
        return false;
    }
    markStageAmbiguity(intent, 'deposit', detail, nowMs);
    return true;
}

export function reduceReimbursementSubmissionMissingTxTimeout(intent, { nowMs = Date.now() } = {}) {
    delete intent.reimbursementSubmittedAtMs;
    delete intent.lastReimbursementSubmissionStatus;
    delete intent.lastReimbursementSubmissionError;
    intent.updatedAtMs = nowMs;
    return true;
}

export function reduceReimbursementSubmissionConfirmedReceipt(
    intent,
    {
        receipt,
        ogModule,
        extractProposalHashFromReceipt,
        nowMs = Date.now(),
    } = {}
) {
    const recoveredProposalHash = extractProposalHashFromReceipt({
        receipt,
        ogModule,
    });
    if (recoveredProposalHash && recoveredProposalHash !== intent.reimbursementProposalHash) {
        intent.reimbursementProposalHash = recoveredProposalHash;
        delete intent.reimbursementSubmittedAtMs;
        clearStageAmbiguity(intent, 'reimbursement');
        delete intent.lastReimbursementSubmissionStatus;
        delete intent.lastReimbursementSubmissionError;
        intent.updatedAtMs = nowMs;
        return { changed: true, recoveredProposalHash };
    }
    if (
        intent.reimbursementSubmissionAmbiguous &&
        intent.lastReimbursementSubmissionStatus === 'confirmed_missing_hash'
    ) {
        return { changed: false, recoveredProposalHash: null };
    }
    intent.lastReimbursementSubmissionStatus = 'confirmed_missing_hash';
    markStageAmbiguity(
        intent,
        'reimbursement',
        'Reimbursement proposal transaction confirmed but proposal hash could not be recovered from receipt; waiting for proposal signal recovery.',
        nowMs
    );
    return { changed: true, recoveredProposalHash: null };
}

export function reduceReimbursementSubmissionRevertedReceipt(
    intent,
    { nowMs = Date.now(), retryDelayMs = null } = {}
) {
    clearStageSubmissionTracking(intent, 'reimbursement');
    intent.lastReimbursementSubmissionStatus = 'reverted';
    intent.lastReimbursementSubmissionError = 'Reimbursement proposal transaction reverted onchain.';
    if (Number.isInteger(retryDelayMs) && retryDelayMs > 0) {
        intent.nextReimbursementAttemptAtMs = nowMs + retryDelayMs;
    }
    intent.updatedAtMs = nowMs;
    return true;
}

export function reduceReimbursementSubmissionReceiptTimeout(
    intent,
    { detail, nowMs = Date.now() } = {}
) {
    if (
        intent.lastReimbursementSubmissionError === detail &&
        Number.isInteger(intent.reimbursementSubmissionAmbiguousAtMs)
    ) {
        return false;
    }
    markStageAmbiguity(intent, 'reimbursement', detail, nowMs);
    return true;
}
