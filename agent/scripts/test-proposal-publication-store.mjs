import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createProposalPublicationStore } from '../src/lib/proposal-publication-store.js';

const BASE_TIME_MS = 1_774_900_000_000;

function buildSignature(hexChar) {
    return `0x${String(hexChar).repeat(130)}`;
}

function buildArtifact(requestId, chainId) {
    return {
        version: 'test-artifact-v1',
        chainId,
        requestId,
    };
}

function buildStoredRecord({ signer, chainId, requestId, signatureChar, publishedAtOffset = 0 }) {
    return {
        signer,
        chainId,
        requestId,
        signature: buildSignature(signatureChar),
        canonicalMessage: `canonical:${signer.toLowerCase()}:${requestId}:${signatureChar}`,
        receivedAtMs: BASE_TIME_MS,
        publishedAtMs: BASE_TIME_MS + publishedAtOffset,
        artifact: buildArtifact(requestId, chainId),
        cid: null,
        uri: null,
        pinned: false,
        publishResult: null,
        pinResult: null,
        lastError: null,
        createdAtMs: BASE_TIME_MS,
        updatedAtMs: BASE_TIME_MS,
    };
}

async function readRecordCount(stateFile) {
    const raw = JSON.parse(await readFile(stateFile, 'utf8'));
    return Object.keys(raw.records ?? {}).length;
}

async function run() {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'proposal-publication-store-'));

    try {
        const saveStateFile = path.join(tempDir, 'save-state.json');
        const saveStore = createProposalPublicationStore({ stateFile: saveStateFile });
        const saveRecordA = buildStoredRecord({
            signer: '0x1111111111111111111111111111111111111111',
            chainId: 11155111,
            requestId: 'save-a',
            signatureChar: 'a',
        });
        const saveRecordB = buildStoredRecord({
            signer: '0x2222222222222222222222222222222222222222',
            chainId: 11155111,
            requestId: 'save-b',
            signatureChar: 'b',
            publishedAtOffset: 1,
        });

        await Promise.all([saveStore.saveRecord(saveRecordA), saveStore.saveRecord(saveRecordB)]);
        const savedA = await saveStore.getRecord({
            signer: saveRecordA.signer,
            chainId: saveRecordA.chainId,
            requestId: saveRecordA.requestId,
        });
        const savedB = await saveStore.getRecord({
            signer: saveRecordB.signer,
            chainId: saveRecordB.chainId,
            requestId: saveRecordB.requestId,
        });
        assert.equal(savedA.submission.status, 'not_started');
        assert.equal(savedA.submission.transactionHash, null);
        assert.equal(savedB.submission.status, 'not_started');
        assert.equal(await readRecordCount(saveStateFile), 2);

        const prepareStateFile = path.join(tempDir, 'prepare-state.json');
        const prepareStore = createProposalPublicationStore({ stateFile: prepareStateFile });
        const prepared = await Promise.all([
            prepareStore.prepareRecord({
                signer: '0x3333333333333333333333333333333333333333',
                chainId: 11155111,
                requestId: 'prepare-a',
                signature: buildSignature('c'),
                canonicalMessage: 'canonical:prepare-a',
                artifact: buildArtifact('prepare-a', 11155111),
                receivedAtMs: BASE_TIME_MS,
                publishedAtMs: BASE_TIME_MS,
            }),
            prepareStore.prepareRecord({
                signer: '0x4444444444444444444444444444444444444444',
                chainId: 11155111,
                requestId: 'prepare-b',
                signature: buildSignature('d'),
                canonicalMessage: 'canonical:prepare-b',
                artifact: buildArtifact('prepare-b', 11155111),
                receivedAtMs: BASE_TIME_MS,
                publishedAtMs: BASE_TIME_MS + 1,
            }),
        ]);
        assert.deepEqual(
            prepared.map((result) => result.status),
            ['created', 'created']
        );
        assert.equal(await readRecordCount(prepareStateFile), 2);
        assert.equal(prepared[0].record.submission.status, 'not_started');

        const conflictStateFile = path.join(tempDir, 'conflict-state.json');
        const conflictStore = createProposalPublicationStore({ stateFile: conflictStateFile });
        const firstPrepare = conflictStore.prepareRecord({
            signer: '0x5555555555555555555555555555555555555555',
            chainId: 11155111,
            requestId: 'same-key',
            signature: buildSignature('e'),
            canonicalMessage: 'canonical:first',
            artifact: buildArtifact('same-key-first', 11155111),
            receivedAtMs: BASE_TIME_MS,
            publishedAtMs: BASE_TIME_MS,
        });
        const secondPrepare = conflictStore.prepareRecord({
            signer: '0x5555555555555555555555555555555555555555',
            chainId: 11155111,
            requestId: 'same-key',
            signature: buildSignature('f'),
            canonicalMessage: 'canonical:second',
            artifact: buildArtifact('same-key-second', 11155111),
            receivedAtMs: BASE_TIME_MS,
            publishedAtMs: BASE_TIME_MS + 1,
        });
        const [created, conflicting] = await Promise.all([firstPrepare, secondPrepare]);
        assert.equal(created.status, 'created');
        assert.equal(conflicting.status, 'conflict');
        const finalRecord = await conflictStore.getRecord({
            signer: '0x5555555555555555555555555555555555555555',
            chainId: 11155111,
            requestId: 'same-key',
        });
        assert.equal(finalRecord.signature, buildSignature('e'));
        assert.equal(await readRecordCount(conflictStateFile), 1);

        const crossChainStateFile = path.join(tempDir, 'cross-chain-state.json');
        const crossChainStore = createProposalPublicationStore({ stateFile: crossChainStateFile });
        const [sepoliaRecord, polygonRecord] = await Promise.all([
            crossChainStore.prepareRecord({
                signer: '0x6666666666666666666666666666666666666666',
                chainId: 11155111,
                requestId: 'shared-request',
                signature: buildSignature('1'),
                canonicalMessage: 'canonical:shared-request:sepolia',
                artifact: buildArtifact('shared-request', 11155111),
                receivedAtMs: BASE_TIME_MS,
                publishedAtMs: BASE_TIME_MS,
            }),
            crossChainStore.prepareRecord({
                signer: '0x6666666666666666666666666666666666666666',
                chainId: 137,
                requestId: 'shared-request',
                signature: buildSignature('2'),
                canonicalMessage: 'canonical:shared-request:polygon',
                artifact: buildArtifact('shared-request', 137),
                receivedAtMs: BASE_TIME_MS,
                publishedAtMs: BASE_TIME_MS + 1,
            }),
        ]);
        assert.equal(sepoliaRecord.status, 'created');
        assert.equal(polygonRecord.status, 'created');
        assert.ok(
            await crossChainStore.getRecord({
                signer: '0x6666666666666666666666666666666666666666',
                chainId: 11155111,
                requestId: 'shared-request',
            })
        );
        assert.ok(
            await crossChainStore.getRecord({
                signer: '0x6666666666666666666666666666666666666666',
                chainId: 137,
                requestId: 'shared-request',
            })
        );
        assert.equal(await readRecordCount(crossChainStateFile), 2);

        const submissionStateFile = path.join(tempDir, 'submission-state.json');
        const submissionStore = createProposalPublicationStore({ stateFile: submissionStateFile });
        const submissionRecord = await submissionStore.saveRecord({
            ...buildStoredRecord({
                signer: '0x7777777777777777777777777777777777777777',
                chainId: 11155111,
                requestId: 'submission-record',
                signatureChar: '7',
            }),
            submission: {
                status: 'resolved',
                submittedAtMs: BASE_TIME_MS + 2,
                transactionHash: `0x${'a'.repeat(64)}`,
                ogProposalHash: `0x${'b'.repeat(64)}`,
                result: {
                    bondAmount: 123n,
                    skipped: false,
                },
                error: null,
                sideEffectsLikelyCommitted: true,
            },
        });
        assert.equal(submissionRecord.submission.status, 'resolved');
        assert.equal(submissionRecord.submission.result.bondAmount, '123');
        assert.equal(submissionRecord.submission.transactionHash, `0x${'a'.repeat(64)}`);

        console.log('[test] proposal publication store OK');
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('[test] proposal publication store failed:', error?.message ?? error);
    process.exit(1);
});
