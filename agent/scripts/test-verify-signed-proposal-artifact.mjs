import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import {
    buildProposalPublicationArtifact,
    buildSignedProposalEnvelope,
    buildSignedProposalPayload,
    verifySignedProposalArtifact,
} from '../src/lib/signed-proposal.js';
import { loadArtifactInput } from './verify-signed-proposal-artifact.mjs';

async function run() {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'verify-signed-proposal-artifact-'));
    const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
    const envelope = buildSignedProposalEnvelope({
        address: account.address,
        chainId: 11155111,
        timestampMs: Date.now(),
        requestId: 'verify-artifact',
        commitmentSafe: '0x2222222222222222222222222222222222222222',
        ogModule: '0x3333333333333333333333333333333333333333',
        transactions: [
            {
                to: '0x4444444444444444444444444444444444444444',
                value: '0',
                data: '0x1234',
                operation: 0,
            },
        ],
        explanation: 'Verify archived proposal artifact.',
        metadata: { source: 'unit-test' },
    });
    const canonicalMessage = buildSignedProposalPayload(envelope);
    const signature = await account.signMessage({ message: canonicalMessage });
    const artifact = buildProposalPublicationArtifact({
        signer: account.address,
        signature,
        signedAtMs: envelope.timestampMs,
        canonicalMessage,
        envelope,
        receivedAtMs: envelope.timestampMs + 10,
        publishedAtMs: envelope.timestampMs + 20,
        signerAllowlistMode: 'explicit',
        nodeName: 'verify-test-node',
    });

    const artifactPath = path.join(tempDir, 'artifact.json');
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

    const loadedFromFile = await loadArtifactInput({
        argv: ['node', 'verify-signed-proposal-artifact.mjs', `--file=${artifactPath}`],
    });
    assert.deepEqual(loadedFromFile, artifact);

    const loadedFromJson = await loadArtifactInput({
        argv: [
            'node',
            'verify-signed-proposal-artifact.mjs',
            `--json=${JSON.stringify(artifact)}`,
        ],
    });
    assert.deepEqual(loadedFromJson, artifact);

    const verification = await verifySignedProposalArtifact(artifact);
    assert.equal(verification.ok, true);
    assert.equal(verification.requestId, 'verify-artifact');
    assert.equal(verification.signer, account.address.toLowerCase());
    assert.equal(verification.transactionCount, 1);

    const tamperedArtifact = {
        ...artifact,
        signedProposal: {
            ...artifact.signedProposal,
            envelope: {
                ...artifact.signedProposal.envelope,
                explanation: 'tampered explanation',
            },
        },
    };
    await assert.rejects(
        () => verifySignedProposalArtifact(tamperedArtifact),
        /canonicalMessage does not match/
    );

    await rm(tempDir, { recursive: true, force: true });
    console.log('[test] verify signed proposal artifact OK');
}

run().catch((error) => {
    console.error('[test] verify signed proposal artifact failed:', error?.message ?? error);
    process.exit(1);
});
