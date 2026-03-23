function hasFutureBackoff(intent, fieldName, nowMs) {
    return Number.isInteger(intent?.[fieldName]) && intent[fieldName] > nowMs;
}

function hasFilledSharesReady(intent) {
    try {
        return BigInt(String(intent?.filledShareAmount ?? 0)) > 0n;
    } catch (error) {
        return false;
    }
}

export function hasActiveExecution({
    openIntents,
    pendingOrderSubmission = null,
    pendingDepositSubmission = null,
}) {
    return (
        Boolean(pendingOrderSubmission?.intentKey) ||
        Boolean(pendingDepositSubmission?.intentKey) ||
        openIntents.some(
            (intent) =>
                Boolean(intent.orderSubmittedAtMs) ||
                Boolean(intent.orderId) ||
                Boolean(intent.depositSubmittedAtMs) ||
                Boolean(intent.depositTxHash) ||
                Boolean(intent.reimbursementSubmittedAtMs) ||
                Boolean(intent.reimbursementSubmissionTxHash)
        )
    );
}

export function planNextActionCandidates({
    openIntents,
    pendingOrderSubmission = null,
    pendingDepositSubmission = null,
    onchainPendingProposal = false,
    nowMs = Date.now(),
}) {
    const candidates = [];

    for (const intent of openIntents) {
        if (!intent.orderFilled || intent.tokenDeposited) {
            continue;
        }
        if (!hasFilledSharesReady(intent)) {
            continue;
        }
        if (hasFutureBackoff(intent, 'nextDepositAttemptAtMs', nowMs)) {
            continue;
        }
        if (
            intent.depositTxHash ||
            intent.depositSubmittedAtMs ||
            pendingDepositSubmission?.intentKey === intent.intentKey
        ) {
            continue;
        }
        candidates.push({
            kind: 'deposit',
            intentKey: intent.intentKey,
        });
    }

    for (const intent of openIntents) {
        if (!intent.tokenDeposited) {
            continue;
        }
        if (
            intent.reimbursementProposalHash ||
            intent.reimbursementSubmissionTxHash ||
            intent.reimbursementSubmittedAtMs
        ) {
            continue;
        }
        if (onchainPendingProposal) {
            continue;
        }
        candidates.push({
            kind: 'reimbursement',
            intentKey: intent.intentKey,
        });
    }

    if (
        hasActiveExecution({
            openIntents,
            pendingOrderSubmission,
            pendingDepositSubmission,
        })
    ) {
        return candidates;
    }

    for (const intent of openIntents) {
        if (intent.artifactCid) {
            continue;
        }
        if (hasFutureBackoff(intent, 'nextArchiveAttemptAtMs', nowMs)) {
            continue;
        }
        candidates.push({
            kind: 'archive',
            intentKey: intent.intentKey,
        });
    }

    for (const intent of openIntents) {
        if (
            !intent.artifactCid ||
            intent.orderId ||
            intent.orderSubmittedAtMs ||
            pendingOrderSubmission?.intentKey === intent.intentKey
        ) {
            continue;
        }
        if (Number.isInteger(intent.expiryMs) && nowMs > intent.expiryMs) {
            continue;
        }
        if (hasFutureBackoff(intent, 'nextOrderAttemptAtMs', nowMs)) {
            continue;
        }
        candidates.push({
            kind: 'order',
            intentKey: intent.intentKey,
        });
    }

    return candidates;
}
