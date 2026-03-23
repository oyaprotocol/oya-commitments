export const LIFECYCLE_STAGE_FIELDS = Object.freeze({
    order: Object.freeze({
        dispatchAt: 'orderDispatchAtMs',
        submittedAt: 'orderSubmittedAtMs',
        backoffAt: 'nextOrderAttemptAtMs',
        externalId: 'orderId',
        status: 'lastOrderSubmissionStatus',
        error: 'lastOrderSubmissionError',
    }),
    deposit: Object.freeze({
        dispatchAt: 'depositDispatchAtMs',
        submittedAt: 'depositSubmittedAtMs',
        txHash: 'depositTxHash',
        backoffAt: 'nextDepositAttemptAtMs',
        ambiguous: 'depositSubmissionAmbiguous',
        ambiguousAt: 'depositSubmissionAmbiguousAtMs',
        ambiguityDetail: 'lastDepositReceiptError',
        clearAmbiguityDetail: true,
    }),
    reimbursement: Object.freeze({
        dispatchAt: 'reimbursementDispatchAtMs',
        submittedAt: 'reimbursementSubmittedAtMs',
        txHash: 'reimbursementSubmissionTxHash',
        backoffAt: 'nextReimbursementAttemptAtMs',
        ambiguous: 'reimbursementSubmissionAmbiguous',
        ambiguousAt: 'reimbursementSubmissionAmbiguousAtMs',
        ambiguityDetail: 'lastReimbursementSubmissionError',
        clearAmbiguityDetail: false,
    }),
});

function requiredStage(kind) {
    if (!Object.hasOwn(LIFECYCLE_STAGE_FIELDS, kind)) {
        throw new Error(`Unsupported lifecycle stage kind: ${kind}`);
    }
    return LIFECYCLE_STAGE_FIELDS[kind];
}

export function getLifecycleStageFields(kind) {
    return requiredStage(kind);
}

export function markStageDispatchStarted(intent, kind, nowMs = Date.now()) {
    if (!intent) {
        return;
    }
    const fields = requiredStage(kind);
    intent[fields.dispatchAt] = nowMs;
    intent.updatedAtMs = nowMs;
}

export function clearStageDispatchStarted(intent, kind) {
    if (!intent) {
        return;
    }
    const fields = requiredStage(kind);
    delete intent[fields.dispatchAt];
}

export function hasStageFutureBackoff(intent, kind, nowMs = Date.now()) {
    const fields = requiredStage(kind);
    return Number.isInteger(intent?.[fields.backoffAt]) && intent[fields.backoffAt] > nowMs;
}

export function clearStageAmbiguity(intent, kind) {
    const fields = requiredStage(kind);
    if (!fields.ambiguous) {
        return;
    }
    delete intent[fields.ambiguous];
    delete intent[fields.ambiguousAt];
    if (fields.clearAmbiguityDetail && fields.ambiguityDetail) {
        delete intent[fields.ambiguityDetail];
    }
}

export function markStageAmbiguity(intent, kind, detail, nowMs = Date.now()) {
    const fields = requiredStage(kind);
    if (!fields.ambiguous) {
        throw new Error(`Lifecycle stage ${kind} does not support ambiguity tracking.`);
    }
    intent[fields.ambiguous] = true;
    if (!Number.isInteger(intent[fields.ambiguousAt])) {
        intent[fields.ambiguousAt] = nowMs;
    }
    if (fields.ambiguityDetail) {
        intent[fields.ambiguityDetail] = detail ?? null;
    }
    intent.updatedAtMs = nowMs;
}

export function noteStageTimeoutAmbiguity(intent, kind, nowMs = Date.now()) {
    const fields = requiredStage(kind);
    if (!fields.ambiguousAt) {
        throw new Error(`Lifecycle stage ${kind} does not support ambiguity tracking.`);
    }
    if (Number.isInteger(intent[fields.ambiguousAt])) {
        return false;
    }
    intent[fields.ambiguousAt] = nowMs;
    intent.updatedAtMs = nowMs;
    return true;
}

export function clearStageSubmissionTracking(intent, kind, extraFields = []) {
    const fields = requiredStage(kind);
    delete intent[fields.dispatchAt];
    delete intent[fields.submittedAt];
    if (fields.txHash) {
        delete intent[fields.txHash];
    }
    if (fields.ambiguous) {
        clearStageAmbiguity(intent, kind);
    }
    if (fields.status) {
        delete intent[fields.status];
    }
    if (fields.error) {
        delete intent[fields.error];
    }
    for (const fieldName of extraFields) {
        delete intent[fieldName];
    }
}
