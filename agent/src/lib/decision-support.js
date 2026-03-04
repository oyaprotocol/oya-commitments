const DECISION_STATUS = Object.freeze({
    HANDLED: 'handled',
    NO_ACTION: 'no_action',
    FAILED_RETRYABLE: 'failed_retryable',
    FAILED_NON_RETRYABLE: 'failed_non_retryable',
});

function hasDeterministicDecisionEngine(agentModule) {
    return typeof agentModule?.getDeterministicToolCalls === 'function';
}

function hasLlmDecisionEngine(config) {
    return Boolean(config?.openAiApiKey);
}

function validateMessageApiDecisionEngine({ config, agentModule }) {
    if (!config?.messageApiEnabled) return;
    if (hasDeterministicDecisionEngine(agentModule)) return;
    if (hasLlmDecisionEngine(config)) return;
    throw new Error(
        'MESSAGE_API_ENABLED=true requires OPENAI_API_KEY or agentModule.getDeterministicToolCalls().'
    );
}

function shouldRequeueMessagesForDecisionStatus(decisionStatus) {
    // Only retry failures that occurred before tool execution side effects.
    return decisionStatus === DECISION_STATUS.FAILED_RETRYABLE;
}

export {
    DECISION_STATUS,
    hasDeterministicDecisionEngine,
    hasLlmDecisionEngine,
    validateMessageApiDecisionEngine,
    shouldRequeueMessagesForDecisionStatus,
};
