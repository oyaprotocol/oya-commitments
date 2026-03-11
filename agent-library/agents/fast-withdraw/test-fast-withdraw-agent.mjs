import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { buildSignedMessagePayload } from '../../../agent/src/lib/message-signing.js';
import {
    buildSignedRequestArchiveArtifact,
    enrichSignals,
    decodeRequestIdFromFilename,
    getRequestArchiveState,
    getSystemPrompt,
    onToolOutput,
    resetRequestArchiveState,
    setRequestArchiveStatePathForTest,
    validateToolCalls,
} from './agent.js';
const TEST_SIGNER = '0x1111111111111111111111111111111111111111';
const TEST_SAFE = '0x2222222222222222222222222222222222222222';
const TEST_AGENT = '0x3333333333333333333333333333333333333333';
const TEST_SIGNATURE = `0x${'1a'.repeat(65)}`;

function buildSignedMessageSignal() {
    return {
        kind: 'userMessage',
        messageId: 'msg_fast_1',
        requestId: 'withdrawal-request-001',
        text: 'Please withdraw 10 USDC to 0x4444444444444444444444444444444444444444.',
        command: 'withdraw',
        args: {
            asset: 'USDC',
            amount: '10',
            recipient: '0x4444444444444444444444444444444444444444',
        },
        metadata: {
            source: 'test-suite',
        },
        deadline: 1_900_000_000_000,
        receivedAtMs: 1_800_000_000_000,
        expiresAtMs: 1_900_000_000_000,
        sender: {
            authType: 'eip191',
            address: TEST_SIGNER,
            signature: TEST_SIGNATURE,
            signedAtMs: 1_800_000_000_000,
        },
    };
}

async function run() {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'fast-withdraw-agent-'));
    setRequestArchiveStatePathForTest(path.join(tmpDir, '.request-archive-state.json'));

    try {
        await resetRequestArchiveState();
        const prompt = getSystemPrompt({
            proposeEnabled: true,
            disputeEnabled: true,
            commitmentText: 'Fast withdraw commitment.',
        });
        assert.ok(prompt.includes('fast-withdraw commitment agent'));
        assert.ok(prompt.includes('archive each signed request to IPFS'));
        assert.ok(prompt.includes('canonical signed message'));
        assert.ok(prompt.includes('ipfs_publish'));
        assert.ok(prompt.includes('Do not treat args as authoritative'));

        const signal = buildSignedMessageSignal();
        const artifact = buildSignedRequestArchiveArtifact({
            message: signal,
            commitmentSafe: TEST_SAFE,
            agentAddress: TEST_AGENT,
        });
        assert.equal(artifact.requestId, signal.requestId);
        assert.equal(artifact.signedRequest.signer, TEST_SIGNER);
        assert.equal(artifact.signedRequest.signature, TEST_SIGNATURE);
        assert.equal(
            artifact.signedRequest.canonicalMessage,
            buildSignedMessagePayload({
                address: TEST_SIGNER,
                timestampMs: signal.sender.signedAtMs,
                text: signal.text,
                command: signal.command,
                args: signal.args,
                metadata: signal.metadata,
                requestId: signal.requestId,
                deadline: signal.deadline,
            })
        );

        const enrichedSignals = await enrichSignals([signal], {
            config: {
                commitmentSafe: TEST_SAFE,
            },
            account: {
                address: TEST_AGENT,
            },
        });
        assert.equal(enrichedSignals.length, 2);
        const archiveSignal = enrichedSignals.find((entry) => entry.kind === 'signedRequestArchive');
        assert.ok(archiveSignal);
        assert.equal(archiveSignal.requestId, signal.requestId);
        assert.equal(archiveSignal.archived, false);
        assert.equal(archiveSignal.archiveArtifact.signedRequest.signature, TEST_SIGNATURE);
        assert.equal(
            decodeRequestIdFromFilename(archiveSignal.archiveFilename),
            signal.requestId
        );

        const validatedToolCalls = await validateToolCalls({
            toolCalls: [
                {
                    callId: 'archive-1',
                    name: 'ipfs_publish',
                    arguments: JSON.stringify({
                        json: archiveSignal.archiveArtifact,
                        filename: archiveSignal.archiveFilename,
                        pin: false,
                    }),
                },
            ],
            signals: enrichedSignals,
            config: {
                ipfsEnabled: true,
            },
        });
        assert.equal(validatedToolCalls.length, 1);
        assert.equal(validatedToolCalls[0].name, 'ipfs_publish');
        const toolArgs = validatedToolCalls[0].parsedArguments;
        assert.equal(toolArgs.pin, true);
        assert.equal(toolArgs.json.requestId, signal.requestId);
        assert.equal(toolArgs.json.signedRequest.signature, TEST_SIGNATURE);

        await assert.rejects(
            () =>
                validateToolCalls({
                    toolCalls: [
                        {
                            callId: 'archive-bad',
                            name: 'ipfs_publish',
                            arguments: JSON.stringify({
                                json: {
                                    ...archiveSignal.archiveArtifact,
                                    requestId: 'tampered-request-id',
                                },
                                filename: archiveSignal.archiveFilename,
                                pin: true,
                            }),
                        },
                    ],
                    signals: enrichedSignals,
                    config: {
                        ipfsEnabled: true,
                    },
                }),
            /exactly match/
        );

        await assert.rejects(
            () =>
                validateToolCalls({
                    toolCalls: [
                        {
                            callId: 'archive-disabled',
                            name: 'ipfs_publish',
                            arguments: JSON.stringify({
                                json: archiveSignal.archiveArtifact,
                                filename: archiveSignal.archiveFilename,
                                pin: true,
                            }),
                        },
                    ],
                    signals: enrichedSignals,
                    config: {
                        ipfsEnabled: false,
                    },
                }),
            /IPFS_ENABLED=true/
        );

        await onToolOutput({
            name: 'ipfs_publish',
            parsedOutput: {
                status: 'published',
                cid: 'bafyfastwithdrawcid',
                uri: 'ipfs://bafyfastwithdrawcid',
                pinned: true,
                publishResult: {
                    Name: toolArgs.filename,
                },
            },
        });

        const state = await getRequestArchiveState();
        assert.equal(state.requests[signal.requestId].artifactCid, 'bafyfastwithdrawcid');
        assert.equal(state.requests[signal.requestId].artifactUri, 'ipfs://bafyfastwithdrawcid');
        assert.equal(state.requests[signal.requestId].signer, TEST_SIGNER);
        assert.equal(state.requests[signal.requestId].signature, TEST_SIGNATURE);

        const enrichedSignalsAfterArchive = await enrichSignals([signal], {
            config: {
                commitmentSafe: TEST_SAFE,
            },
            account: {
                address: TEST_AGENT,
            },
        });
        const archivedSignal = enrichedSignalsAfterArchive.find(
            (entry) => entry.kind === 'signedRequestArchive'
        );
        assert.ok(archivedSignal);
        assert.equal(archivedSignal.archived, true);
        assert.equal(archivedSignal.artifactCid, 'bafyfastwithdrawcid');

        const unsignedSignals = await enrichSignals([
            {
                ...signal,
                requestId: 'unsigned-test',
                sender: {
                    authType: 'apiKey',
                    keyId: 'test',
                },
            },
        ], {
            config: {
                commitmentSafe: TEST_SAFE,
            },
            account: {
                address: TEST_AGENT,
            },
        });
        assert.equal(unsignedSignals.length, 1);

        console.log('[test] fast-withdraw agent OK');
    } finally {
        await resetRequestArchiveState();
        setRequestArchiveStatePathForTest(null);
    }
}

run().catch((error) => {
    console.error('[test] fast-withdraw agent failed:', error?.message ?? error);
    process.exit(1);
});
