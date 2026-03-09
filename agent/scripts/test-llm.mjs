import assert from 'node:assert/strict';
import { callAgent } from '../src/lib/llm.js';
import { isRetryableDecisionError } from '../src/lib/decision-support.js';

async function withMockFetch(mockFetch, fn) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
        await fn();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function expectCallAgentHttpError({ statusCode, responseText }) {
    let thrown;
    await withMockFetch(
        async () => ({
            ok: false,
            status: statusCode,
            text: async () => responseText,
        }),
        async () => {
            try {
                await callAgent({
                    config: {
                        openAiBaseUrl: 'https://api.openai.test/v1',
                        openAiApiKey: 'k_test',
                        openAiModel: 'gpt-test',
                        commitmentSafe: '0x0000000000000000000000000000000000000001',
                        ogModule: '0x0000000000000000000000000000000000000002',
                    },
                    systemPrompt: 'prompt',
                    signals: [],
                    ogContext: {},
                    commitmentText: 'commitment',
                    agentAddress: '0x0000000000000000000000000000000000000003',
                    tools: [],
                    allowTools: false,
                });
            } catch (error) {
                thrown = error;
            }
        }
    );

    assert.ok(thrown instanceof Error);
    assert.equal(thrown.statusCode, statusCode);
    assert.equal(thrown.responseBody, responseText);
    return thrown;
}

async function run() {
    const unauthorizedError = await expectCallAgentHttpError({
        statusCode: 401,
        responseText: 'invalid api key',
    });
    assert.equal(isRetryableDecisionError(unauthorizedError), false);

    const rateLimitedError = await expectCallAgentHttpError({
        statusCode: 429,
        responseText: 'rate limited',
    });
    assert.equal(isRetryableDecisionError(rateLimitedError), true);

    const serverError = await expectCallAgentHttpError({
        statusCode: 503,
        responseText: 'service unavailable',
    });
    assert.equal(isRetryableDecisionError(serverError), true);

    console.log('[test] llm retry classification OK');
}

run().catch((error) => {
    console.error('[test] llm retry classification failed:', error?.message ?? error);
    process.exit(1);
});
