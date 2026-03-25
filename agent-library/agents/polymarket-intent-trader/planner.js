import {
    getLifecycleStageFields,
    hasStageFutureBackoff,
} from './lifecycle-stage.js';

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

function blocksGlobalOrderPlanning(intent, orderFields) {
    if (Boolean(intent?.[orderFields.dispatchAt])) {
        return true;
    }
    if (
        Boolean(intent?.[orderFields.externalId]) &&
        !intent?.orderFilled &&
        !intent?.tokenDeposited
    ) {
        return true;
    }
    if (!Boolean(intent?.[orderFields.submittedAt])) {
        return false;
    }
    if (intent?.orderFilled || intent?.tokenDeposited) {
        return false;
    }
    return !Number.isInteger(intent?.orderStatusRefreshFailedAtMs);
}

function blocksGlobalTxStagePlanning(intent, fields, isComplete) {
    if (!intent || isComplete(intent)) {
        return false;
    }
    if (
        !Boolean(intent?.[fields.dispatchAt]) &&
        !Boolean(intent?.[fields.submittedAt]) &&
        !Boolean(intent?.[fields.txHash])
    ) {
        return false;
    }
    if (fields.ambiguous && Boolean(intent?.[fields.ambiguous])) {
        return false;
    }
    return true;
}

export function hasActiveExecution({
    openIntents,
    pendingOrderSubmission = null,
    pendingDepositSubmission = null,
}) {
    const orderFields = getLifecycleStageFields('order');
    const depositFields = getLifecycleStageFields('deposit');
    const reimbursementFields = getLifecycleStageFields('reimbursement');
    return (
        Boolean(pendingOrderSubmission?.intentKey) ||
        Boolean(pendingDepositSubmission?.intentKey) ||
        openIntents.some(
            (intent) =>
                blocksGlobalOrderPlanning(intent, orderFields) ||
                blocksGlobalTxStagePlanning(
                    intent,
                    depositFields,
                    (candidate) => Boolean(candidate?.tokenDeposited)
                ) ||
                blocksGlobalTxStagePlanning(
                    intent,
                    reimbursementFields,
                    (candidate) =>
                        Boolean(candidate?.reimbursementProposalHash) ||
                        Boolean(candidate?.reimbursedAtMs)
                )
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
        const depositFields = getLifecycleStageFields('deposit');
        if (hasStageFutureBackoff(intent, 'deposit', nowMs)) {
            continue;
        }
        if (
            intent[depositFields.txHash] ||
            intent[depositFields.dispatchAt] ||
            intent[depositFields.submittedAt] ||
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
        const reimbursementFields = getLifecycleStageFields('reimbursement');
        if (hasStageFutureBackoff(intent, 'reimbursement', nowMs)) {
            continue;
        }
        if (
            intent[reimbursementFields.dispatchAt] ||
            intent.reimbursementProposalHash ||
            intent[reimbursementFields.txHash] ||
            intent[reimbursementFields.submittedAt]
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
        const orderFields = getLifecycleStageFields('order');
        if (
            !intent.artifactCid ||
            intent.orderFilled ||
            intent.tokenDeposited ||
            intent[orderFields.externalId] ||
            intent[orderFields.dispatchAt] ||
            intent[orderFields.submittedAt] ||
            pendingOrderSubmission?.intentKey === intent.intentKey
        ) {
            continue;
        }
        if (Number.isInteger(intent.expiryMs) && nowMs > intent.expiryMs) {
            continue;
        }
        if (hasStageFutureBackoff(intent, 'order', nowMs)) {
            continue;
        }
        candidates.push({
            kind: 'order',
            intentKey: intent.intentKey,
        });
    }

    return candidates;
}
