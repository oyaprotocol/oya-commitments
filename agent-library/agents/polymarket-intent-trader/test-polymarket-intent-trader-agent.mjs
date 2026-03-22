import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { buildSignedMessagePayload } from '../../../agent/src/lib/message-signing.js';
import {
    buildSignedTradeIntentArchiveArtifact,
    enrichSignals,
    getDeterministicToolCalls,
    getSystemPrompt,
    getTradeIntentState,
    interpretSignedTradeIntentSignal,
    onToolOutput,
    resetTradeIntentState,
    setTradeIntentStatePathForTest,
} from './agent.js';

const TEST_SIGNER = '0x1111111111111111111111111111111111111111';
const TEST_AGENT = '0x2222222222222222222222222222222222222222';
const TEST_SAFE = '0x3333333333333333333333333333333333333333';
const TEST_SIGNATURE = `0x${'1a'.repeat(65)}`;

function buildModuleConfig(overrides = {}) {
    return {
        commitmentSafe: TEST_SAFE,
        ipfsEnabled: false,
        agentConfig: {
            polymarketIntentTrader: {
                authorizedAgent: TEST_AGENT,
                marketId: 'market-123',
                yesTokenId: '101',
                noTokenId: '202',
                ...overrides,
            },
        },
    };
}

function buildSignedMessageSignal(overrides = {}) {
    const requestId = overrides.requestId ?? 'pm-intent-001';
    const receivedAtMs = overrides.receivedAtMs ?? 1_800_000_000_000;
    const deadline = overrides.deadline ?? receivedAtMs + 60_000;

    return {
        kind: 'userMessage',
        messageId: overrides.messageId ?? `msg_${requestId}`,
        requestId,
        text:
            overrides.text ??
            'Buy NO for up to 25 USDC if the price is 0.42 or better before 6pm UTC.',
        command: overrides.command ?? 'buy',
        args: overrides.args ?? {
            ignored: true,
        },
        metadata: overrides.metadata ?? {
            source: 'test-suite',
        },
        chainId: overrides.chainId ?? 11155111,
        receivedAtMs,
        expiresAtMs: overrides.expiresAtMs ?? deadline,
        deadline,
        sender: {
            authType: 'eip191',
            address: overrides.signer ?? TEST_SIGNER,
            signature: overrides.signature ?? TEST_SIGNATURE,
            signedAtMs: overrides.signedAtMs ?? receivedAtMs,
        },
    };
}

async function run() {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'polymarket-intent-trader-'));
    setTradeIntentStatePathForTest(path.join(tmpDir, '.trade-intent-state.json'));

    try {
        await resetTradeIntentState();

        const prompt = getSystemPrompt({
            proposeEnabled: false,
            disputeEnabled: false,
            commitmentText: 'Signed Polymarket trade intents may be written in plain English.',
        });
        assert.ok(prompt.includes('kind is "userMessage"'));
        assert.ok(prompt.includes('sender.authType is "eip191"'));
        assert.ok(prompt.includes('signed human-readable message text as the primary source of trading intent'));
        assert.ok(prompt.includes('Parse signed free-text messages into candidate BUY intents'));
        assert.ok(prompt.includes('Archive accepted signed trade intents'));
        assert.ok(prompt.includes('Return strict JSON'));
        assert.ok(prompt.includes('Commitment text'));

        const validSignal = buildSignedMessageSignal();
        const interpreted = interpretSignedTradeIntentSignal(validSignal, {
            policy: {
                authorizedAgent: TEST_AGENT.toLowerCase(),
                marketId: 'market-123',
                yesTokenId: '101',
                noTokenId: '202',
                archiveRetryDelayMs: 30_000,
                signedCommands: new Set(['buy']),
            },
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            nowMs: validSignal.receivedAtMs,
        });
        assert.equal(interpreted.ok, true);
        assert.equal(interpreted.intent.intentKey, `${TEST_SIGNER.toLowerCase()}:pm-intent-001`);
        assert.equal(interpreted.intent.outcome, 'NO');
        assert.equal(interpreted.intent.marketId, 'market-123');
        assert.equal(interpreted.intent.tokenId, '202');
        assert.equal(interpreted.intent.maxSpendUsdc, '25');
        assert.equal(interpreted.intent.maxSpendWei, '25000000');
        assert.equal(interpreted.intent.maxPrice, '0.42');
        assert.equal(interpreted.intent.maxPriceScaled, '420000');
        assert.equal(interpreted.intent.side, 'BUY');

        const archiveArtifact = buildSignedTradeIntentArchiveArtifact({
            record: interpreted.intent,
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
        });
        assert.equal(archiveArtifact.requestId, validSignal.requestId);
        assert.equal(archiveArtifact.interpretedIntent.outcome, 'NO');
        assert.equal(
            archiveArtifact.signedRequest.canonicalMessage,
            buildSignedMessagePayload({
                address: TEST_SIGNER.toLowerCase(),
                chainId: validSignal.chainId,
                timestampMs: validSignal.sender.signedAtMs,
                text: validSignal.text,
                command: validSignal.command,
                args: validSignal.args,
                metadata: validSignal.metadata,
                requestId: validSignal.requestId,
                deadline: validSignal.deadline,
            })
        );

        const invalidSignal = buildSignedMessageSignal({
            requestId: 'pm-intent-invalid',
            text: 'Sell YES at 0.40 for 10 USDC.',
        });
        const invalidInterpreted = interpretSignedTradeIntentSignal(invalidSignal, {
            policy: {
                signedCommands: new Set(['buy']),
            },
            nowMs: invalidSignal.receivedAtMs,
        });
        assert.equal(invalidInterpreted.ok, false);

        const enrichedSignals = await enrichSignals([validSignal], {
            config: buildModuleConfig(),
            account: {
                address: TEST_AGENT,
            },
            nowMs: validSignal.receivedAtMs,
        });
        const tradeIntentSignal = enrichedSignals.find(
            (entry) => entry.kind === 'polymarketTradeIntent'
        );
        const archiveSignal = enrichedSignals.find(
            (entry) => entry.kind === 'polymarketSignedIntentArchive'
        );
        assert.ok(tradeIntentSignal);
        assert.ok(archiveSignal);
        assert.equal(tradeIntentSignal.outcome, 'NO');
        assert.equal(tradeIntentSignal.maxSpendWei, '25000000');
        assert.equal(tradeIntentSignal.maxPriceScaled, '420000');
        assert.equal(archiveSignal.archived, false);

        const archiveCalls = await getDeterministicToolCalls({
            signals: [validSignal],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            config: {
                ...buildModuleConfig(),
                ipfsEnabled: true,
            },
        });
        assert.equal(archiveCalls.length, 1);
        assert.equal(archiveCalls[0].name, 'ipfs_publish');
        const archiveArgs = JSON.parse(archiveCalls[0].arguments);
        assert.equal(archiveArgs.filename, interpreted.intent.archiveFilename);
        assert.equal(archiveArgs.json.interpretedIntent.maxSpendWei, '25000000');
        assert.equal(archiveArgs.json.interpretedIntent.maxPriceScaled, '420000');

        const stateAfterArchiveCall = getTradeIntentState();
        const storedIntent =
            stateAfterArchiveCall.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-001`];
        assert.ok(storedIntent);
        assert.equal(storedIntent.outcome, 'NO');
        assert.equal(typeof storedIntent.lastArchiveAttemptAtMs, 'number');

        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyintent',
                uri: 'ipfs://bafyintent',
                pinned: true,
            },
            config: {
                ...buildModuleConfig(),
                ipfsEnabled: true,
            },
        });

        const stateAfterPublished = getTradeIntentState();
        const archivedIntent =
            stateAfterPublished.intents[`${TEST_SIGNER.toLowerCase()}:pm-intent-001`];
        assert.equal(archivedIntent.artifactCid, 'bafyintent');
        assert.equal(archivedIntent.artifactUri, 'ipfs://bafyintent');
        assert.equal(archivedIntent.pinned, true);
        assert.equal(typeof archivedIntent.archivedAtMs, 'number');

        const noRepeatCalls = await getDeterministicToolCalls({
            signals: [],
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
            config: {
                ...buildModuleConfig(),
                ipfsEnabled: true,
            },
        });
        assert.deepEqual(noRepeatCalls, []);

        console.log('[test] polymarket-intent-trader parser OK');
    } finally {
        await resetTradeIntentState();
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
