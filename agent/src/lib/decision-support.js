const DECISION_STATUS = Object.freeze({
    HANDLED: 'handled',
    NO_ACTION: 'no_action',
    FAILED_RETRYABLE: 'failed_retryable',
    FAILED_NON_RETRYABLE: 'failed_non_retryable',
});

const SIDE_EFFECT_STATUSES = new Set(['submitted', 'confirmed', 'pending']);
const RETRYABLE_DECISION_ERROR_CODES = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
]);

function hasDeterministicDecisionEngine(agentModule) {
    return typeof agentModule?.getDeterministicToolCalls === 'function';
}

function hasLlmDecisionEngine(config) {
    return Boolean(config?.openAiApiKey);
}

function isRetryableDecisionError(error) {
    const code = String(error?.code ?? '').toUpperCase();
    if (RETRYABLE_DECISION_ERROR_CODES.has(code)) {
        return true;
    }

    const name = String(error?.name ?? '');
    if (/(Timeout|Network|HttpRequest|Fetch|Socket|Connection|RateLimit|Rpc)/i.test(name)) {
        return true;
    }

    const message = String(error?.shortMessage ?? error?.message ?? '').toLowerCase();
    return (
        message.includes('timed out') ||
        message.includes('timeout') ||
        message.includes('network error') ||
        message.includes('failed to fetch') ||
        message.includes('connection refused') ||
        message.includes('connection reset') ||
        message.includes('temporarily unavailable') ||
        message.includes('service unavailable') ||
        message.includes('gateway timeout') ||
        message.includes('too many requests') ||
        message.includes('429') ||
        message.includes('rpc unavailable')
    );
}

function validateMessageApiDecisionEngine({ config, agentModule }) {
    if (!config?.messageApiEnabled) return;
    if (hasDeterministicDecisionEngine(agentModule)) return;
    if (hasLlmDecisionEngine(config)) return;
    throw new Error(
        'MESSAGE_API_ENABLED=true requires OPENAI_API_KEY or agentModule.getDeterministicToolCalls().'
    );
}

function parseToolOutputPayload(toolOutput) {
    if (!toolOutput || typeof toolOutput.output !== 'string') {
        return null;
    }
    try {
        const parsed = JSON.parse(toolOutput.output);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
        return null;
    }
}

function evaluateToolOutputsDecisionStatus(toolOutputs = []) {
    if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) {
        return DECISION_STATUS.HANDLED;
    }

    let hasReplaySafeRetryableError = false;
    let hasLikelySideEffects = false;

    for (const output of toolOutputs) {
        const payload = parseToolOutputPayload(output);
        if (!payload) continue;

        const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : '';
        const explicitSideEffects = payload.sideEffectsLikelyCommitted === true;
        const implicitSideEffects =
            SIDE_EFFECT_STATUSES.has(status) ||
            typeof payload.transactionHash === 'string' ||
            typeof payload.disputeHash === 'string';

        if (explicitSideEffects || implicitSideEffects) {
            hasLikelySideEffects = true;
        }

        if (status !== 'error') {
            continue;
        }

        if (payload.retryable === true && !explicitSideEffects) {
            hasReplaySafeRetryableError = true;
        }
    }

    if (hasReplaySafeRetryableError && !hasLikelySideEffects) {
        return DECISION_STATUS.FAILED_RETRYABLE;
    }

    // Keep all other outcomes handled to avoid replaying mixed/successful batches.
    return DECISION_STATUS.HANDLED;
}

function shouldRequeueMessagesForDecisionStatus(decisionStatus) {
    // Only retry failures that occurred before tool execution side effects.
    return decisionStatus === DECISION_STATUS.FAILED_RETRYABLE;
}

export {
    DECISION_STATUS,
    evaluateToolOutputsDecisionStatus,
    hasDeterministicDecisionEngine,
    hasLlmDecisionEngine,
    isRetryableDecisionError,
    validateMessageApiDecisionEngine,
    shouldRequeueMessagesForDecisionStatus,
};
