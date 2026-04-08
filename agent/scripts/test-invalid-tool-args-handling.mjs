import assert from 'node:assert/strict';
import { executeToolCalls } from '../src/lib/tools.js';
import { createMessageInbox } from '../src/lib/message-inbox.js';
import { processQueuedUserMessages } from '../src/lib/message-loop.js';
import { DECISION_STATUS } from '../src/lib/decision-support.js';

function parseOutput(result) {
    return JSON.parse(result.output);
}

async function testExecuteToolCallsInvalidArgsOutput() {
    let callbackPayload = null;
    const results = await executeToolCalls({
        toolCalls: [
            {
                callId: 'invalid-call',
                name: 'make_deposit',
                arguments: '{not json',
            },
        ],
        publicClient: {},
        walletClient: {},
        account: { address: '0x1111111111111111111111111111111111111111' },
        config: {
            proposeEnabled: true,
            disputeEnabled: false,
            polymarketClobEnabled: false,
            commitmentSafe: '0x2222222222222222222222222222222222222222',
            ogModule: '0x3333333333333333333333333333333333333333',
        },
        ogContext: null,
        onToolOutput: async (output) => {
            callbackPayload = parseOutput(output);
        },
    });

    assert.equal(results.length, 1);
    const output = parseOutput(results[0]);
    assert.equal(output.status, 'error');
    assert.equal(output.code, 'invalid_tool_arguments');
    assert.equal(output.invalidArguments, true);
    assert.equal(output.retryable, false);
    assert.deepEqual(callbackPayload, output);
}

async function testMessageLoopRequeuesInvalidToolArgsStatus() {
    const startMs = Date.now();
    const inbox = createMessageInbox({
        queueLimit: 10,
        defaultTtlSeconds: 60,
        minTtlSeconds: 1,
        maxTtlSeconds: 600,
        idempotencyTtlSeconds: 300,
        maxTextLength: 200,
        rateLimitPerMinute: 100,
        rateLimitBurst: 100,
    });

    const submitted = inbox.submitMessage({
        text: 'submit malformed tool args',
        senderKeyId: 'ops',
        nowMs: startMs,
    });
    assert.equal(submitted.ok, true);

    await processQueuedUserMessages({
        messageInbox: inbox,
        maxBatchSize: 10,
        nowMs: startMs + 1,
        latestBlock: 1n,
        onchainPendingProposal: false,
        prepareSignals: async (signals) => signals,
        decideOnSignals: async () => DECISION_STATUS.INVALID_TOOL_ARGS,
    });

    const retriedBatch = inbox.takeBatch({ maxItems: 10, nowMs: startMs + 2 });
    assert.deepEqual(retriedBatch.map((message) => message.messageId), [
        submitted.message.messageId,
    ]);
}

async function run() {
    await testExecuteToolCallsInvalidArgsOutput();
    await testMessageLoopRequeuesInvalidToolArgsStatus();
    console.log('[test] invalid tool args handling OK');
}

run().catch((error) => {
    console.error('[test] invalid tool args handling failed:', error?.message ?? error);
    process.exit(1);
});
