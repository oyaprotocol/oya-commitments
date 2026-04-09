import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createMessagePublicationStore } from '../src/lib/message-publication-store.js';

async function main() {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'message-publication-store-'));
    const stateFile = path.join(tempDir, 'message-publications.json');
    const store = createMessagePublicationStore({ stateFile });
    const signer = '0x1111111111111111111111111111111111111111';
    const chainId = 11155111;
    const requestId = 'message-store-test';
    const signature = `0x${'a'.repeat(130)}`;
    const canonicalMessage = JSON.stringify({
        version: 'oya-signed-message-v1',
        kind: 'generic_message_publication',
        address: signer.toLowerCase(),
        timestampMs: 1_700_000_000_000,
        message: {
            chainId,
            requestId,
            commitmentAddresses: [signer.toLowerCase()],
            agentAddress: signer.toLowerCase(),
            body: {
                event: 'store-test',
            },
        },
    });

    try {
        const created = await store.prepareRecord({
            signer,
            chainId,
            requestId,
            signature,
            canonicalMessage,
            artifact: null,
            receivedAtMs: 1_700_000_000_100,
            publishedAtMs: null,
        });
        assert.equal(created.status, 'created');
        assert.equal(created.record.chainId, chainId);
        assert.equal(created.record.requestId, requestId);
        assert.equal(created.record.cid, null);

        const duplicate = await store.prepareRecord({
            signer,
            chainId,
            requestId,
            signature,
            canonicalMessage,
            artifact: null,
            receivedAtMs: 1_700_000_000_200,
            publishedAtMs: null,
        });
        assert.equal(duplicate.status, 'existing');
        assert.equal(duplicate.record.signature, signature);

        const conflict = await store.prepareRecord({
            signer,
            chainId,
            requestId,
            signature: `0x${'b'.repeat(130)}`,
            canonicalMessage: JSON.stringify({
                ...JSON.parse(canonicalMessage),
                timestampMs: 1_700_000_000_001,
            }),
            artifact: null,
            receivedAtMs: 1_700_000_000_300,
            publishedAtMs: null,
        });
        assert.equal(conflict.status, 'conflict');
        assert.equal(conflict.record.requestId, requestId);

        const saved = await store.saveRecord({
            ...created.record,
            publishedAtMs: 1_700_000_000_400,
            artifact: {
                version: 'oya-message-publication-record-v1',
                publication: {
                    receivedAtMs: 1_700_000_000_100,
                    publishedAtMs: 1_700_000_000_400,
                    signerAllowlistMode: 'explicit',
                    nodeAttestation: {
                        authType: 'eip191',
                        signer: signer.toLowerCase(),
                        signature,
                        signedAtMs: 1_700_000_000_400,
                        canonicalMessage: canonicalMessage,
                        envelope: {
                            version: 'oya-node-message-publication-attestation-v1',
                            kind: 'message_publication_attestation',
                            address: signer.toLowerCase(),
                            timestampMs: 1_700_000_000_400,
                            publication: {
                                receivedAtMs: 1_700_000_000_100,
                                publishedAtMs: 1_700_000_000_400,
                                signerAllowlistMode: 'explicit',
                            },
                            signedMessage: {
                                signer: signer.toLowerCase(),
                                signature,
                                canonicalMessage,
                            },
                        },
                    },
                },
                signedMessage: {
                    authType: 'eip191',
                    signer: signer.toLowerCase(),
                    signature,
                    signedAtMs: 1_700_000_000_000,
                    canonicalMessage,
                    envelope: JSON.parse(canonicalMessage),
                },
            },
            cid: 'bafy-store-test',
            uri: 'ipfs://bafy-store-test',
            pinned: true,
            publishResult: { Hash: 'bafy-store-test' },
            pinResult: { Pins: ['bafy-store-test'] },
        });
        assert.equal(saved.cid, 'bafy-store-test');
        assert.equal(saved.pinned, true);

        const loaded = await store.getRecord({ signer, chainId, requestId });
        assert.equal(loaded.cid, 'bafy-store-test');
        assert.equal(loaded.uri, 'ipfs://bafy-store-test');
        assert.equal(loaded.pinned, true);
        assert.equal(loaded.artifact.signedMessage.envelope.message.requestId, requestId);
        assert.equal(loaded.artifact.publication.nodeAttestation.signer, signer.toLowerCase());
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error('[test] message publication store failed:', error?.message ?? error);
    process.exit(1);
});
