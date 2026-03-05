import assert from 'node:assert/strict';
import {
    DECISION_STATUS,
    evaluateToolOutputsDecisionStatus,
    validateMessageApiDecisionEngine,
    shouldRequeueMessagesForDecisionStatus,
} from '../src/lib/decision-support.js';

async function run() {
    // Only pre-execution failures should trigger message replay.
    assert.equal(shouldRequeueMessagesForDecisionStatus(DECISION_STATUS.FAILED_RETRYABLE), true);
    assert.equal(
        shouldRequeueMessagesForDecisionStatus(DECISION_STATUS.FAILED_NON_RETRYABLE),
        false
    );
    assert.equal(shouldRequeueMessagesForDecisionStatus(DECISION_STATUS.HANDLED), false);
    assert.equal(shouldRequeueMessagesForDecisionStatus(DECISION_STATUS.NO_ACTION), false);

    assert.equal(evaluateToolOutputsDecisionStatus([]), DECISION_STATUS.HANDLED);
    assert.equal(
        evaluateToolOutputsDecisionStatus([
            {
                output: JSON.stringify({
                    status: 'error',
                    message: 'rpc unavailable',
                    retryable: true,
                    sideEffectsLikelyCommitted: false,
                }),
            },
        ]),
        DECISION_STATUS.FAILED_RETRYABLE
    );
    assert.equal(
        evaluateToolOutputsDecisionStatus([
            {
                output: JSON.stringify({
                    status: 'error',
                    message: 'rpc unavailable',
                    retryable: true,
                    sideEffectsLikelyCommitted: false,
                }),
            },
            {
                output: JSON.stringify({
                    status: 'submitted',
                    transactionHash: `0x${'a'.repeat(64)}`,
                }),
            },
        ]),
        DECISION_STATUS.HANDLED
    );
    assert.equal(
        evaluateToolOutputsDecisionStatus([
            {
                output: JSON.stringify({
                    status: 'error',
                    message: 'validation failed',
                    retryable: false,
                }),
            },
        ]),
        DECISION_STATUS.HANDLED
    );

    // Disabled message API should not require any decision engine.
    assert.doesNotThrow(() => {
        validateMessageApiDecisionEngine({
            config: { messageApiEnabled: false, openAiApiKey: '' },
            agentModule: {},
        });
    });

    // Enabled message API is valid with deterministic entrypoint only.
    assert.doesNotThrow(() => {
        validateMessageApiDecisionEngine({
            config: { messageApiEnabled: true, openAiApiKey: '' },
            agentModule: { getDeterministicToolCalls() {} },
        });
    });

    // Enabled message API is valid with LLM decision engine only.
    assert.doesNotThrow(() => {
        validateMessageApiDecisionEngine({
            config: { messageApiEnabled: true, openAiApiKey: 'k_test' },
            agentModule: {},
        });
    });

    // Enabled message API without deterministic or LLM support is invalid.
    assert.throws(
        () =>
            validateMessageApiDecisionEngine({
                config: { messageApiEnabled: true, openAiApiKey: '' },
                agentModule: {},
            }),
        /MESSAGE_API_ENABLED=true requires OPENAI_API_KEY or agentModule\.getDeterministicToolCalls\(\)\./
    );

    console.log('[test] decision support OK');
}

run().catch((error) => {
    console.error('[test] decision support failed:', error?.message ?? error);
    process.exit(1);
});
