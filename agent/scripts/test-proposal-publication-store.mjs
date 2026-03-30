import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createProposalPublicationStore } from '../src/lib/proposal-publication-store.js';

const BASE_TIME_MS = 1_774_900_000_000;

function buildSignature(hexChar) {
    return `0x${String(hexChar).repeat(130)}`;
}

function buildArtifact(requestId) {
    return {
        version: 'test-artifact-v1',
        requestId,
    };
}

function buildStoredRecord({ signer, requestId, signatureChar, publishedAtOffset = 0 }) {
    return {
        signer,
        requestId,
        signature: buildSignature(signatureChar),
        canonicalMessage: `canonical:${signer.toLowerCase()}:${requestId}:${signatureChar}`,
        receivedAtMs: BASE_TIME_MS,
        publishedAtMs: BASE_TIME_MS + publishedAtOffset,
        artifact: buildArtifact(requestId),
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
            requestId: 'save-a',
            signatureChar: 'a',
        });
        const saveRecordB = buildStoredRecord({
            signer: '0x2222222222222222222222222222222222222222',
            requestId: 'save-b',
            signatureChar: 'b',
            publishedAtOffset: 1,
        });

        await Promise.all([saveStore.saveRecord(saveRecordA), saveStore.saveRecord(saveRecordB)]);
        assert.ok(
            await saveStore.getRecord({
                signer: saveRecordA.signer,
                requestId: saveRecordA.requestId,
            })
        );
        assert.ok(
            await saveStore.getRecord({
                signer: saveRecordB.signer,
                requestId: saveRecordB.requestId,
            })
        );
        assert.equal(await readRecordCount(saveStateFile), 2);

        const prepareStateFile = path.join(tempDir, 'prepare-state.json');
        const prepareStore = createProposalPublicationStore({ stateFile: prepareStateFile });
        const prepared = await Promise.all([
            prepareStore.prepareRecord({
                signer: '0x3333333333333333333333333333333333333333',
                requestId: 'prepare-a',
                signature: buildSignature('c'),
                canonicalMessage: 'canonical:prepare-a',
                artifact: buildArtifact('prepare-a'),
                receivedAtMs: BASE_TIME_MS,
                publishedAtMs: BASE_TIME_MS,
            }),
            prepareStore.prepareRecord({
                signer: '0x4444444444444444444444444444444444444444',
                requestId: 'prepare-b',
                signature: buildSignature('d'),
                canonicalMessage: 'canonical:prepare-b',
                artifact: buildArtifact('prepare-b'),
                receivedAtMs: BASE_TIME_MS,
                publishedAtMs: BASE_TIME_MS + 1,
            }),
        ]);
        assert.deepEqual(
            prepared.map((result) => result.status),
            ['created', 'created']
        );
        assert.equal(await readRecordCount(prepareStateFile), 2);

        const conflictStateFile = path.join(tempDir, 'conflict-state.json');
        const conflictStore = createProposalPublicationStore({ stateFile: conflictStateFile });
        const firstPrepare = conflictStore.prepareRecord({
            signer: '0x5555555555555555555555555555555555555555',
            requestId: 'same-key',
            signature: buildSignature('e'),
            canonicalMessage: 'canonical:first',
            artifact: buildArtifact('same-key-first'),
            receivedAtMs: BASE_TIME_MS,
            publishedAtMs: BASE_TIME_MS,
        });
        const secondPrepare = conflictStore.prepareRecord({
            signer: '0x5555555555555555555555555555555555555555',
            requestId: 'same-key',
            signature: buildSignature('f'),
            canonicalMessage: 'canonical:second',
            artifact: buildArtifact('same-key-second'),
            receivedAtMs: BASE_TIME_MS,
            publishedAtMs: BASE_TIME_MS + 1,
        });
        const [created, conflicting] = await Promise.all([firstPrepare, secondPrepare]);
        assert.equal(created.status, 'created');
        assert.equal(conflicting.status, 'conflict');
        const finalRecord = await conflictStore.getRecord({
            signer: '0x5555555555555555555555555555555555555555',
            requestId: 'same-key',
        });
        assert.equal(finalRecord.signature, buildSignature('e'));
        assert.equal(await readRecordCount(conflictStateFile), 1);

        console.log('[test] proposal publication store OK');
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('[test] proposal publication store failed:', error?.message ?? error);
    process.exit(1);
});
