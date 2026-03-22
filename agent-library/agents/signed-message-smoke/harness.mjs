import assert from 'node:assert/strict';

function escapeForRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getHarnessDefinition() {
    return {
        scenario: 'signed-message-smoke',
        description: 'Starts the local harness agent and submits one signed user message through the live message API.',
    };
}

async function runSmokeScenario(ctx) {
    const deployment = await ctx.ensureDeployment();
    const agent = await ctx.ensureAgentStarted();
    const response = await ctx.sendMessage({
        text: 'Signed message API smoke test',
    });

    assert.equal(response.status, 202, `Expected 202 from message API, got ${response.status}.`);
    assert.equal(response.ok, true, 'Message API should accept the smoke-test message.');
    assert.equal(response.response?.status, 'queued', 'Smoke-test message should be queued.');

    const messageId = response.response?.messageId;
    if (messageId) {
        await ctx.waitForAgentLog(new RegExp(`Handling queued user message \\(messageId=${escapeForRegex(messageId)}`));
    }
    await ctx.waitForAgentLog(/User message produced no action/);

    return {
        scenario: 'signed-message-smoke',
        deployment,
        agent,
        message: {
            requestId: response.requestId,
            status: response.status,
            messageId: response.response?.messageId ?? null,
            endpoint: response.endpoint,
        },
    };
}

export { getHarnessDefinition, runSmokeScenario };
