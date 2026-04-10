import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { createMessagePublicationApiServer } from '../src/lib/message-publication-api.js';
import { createMessagePublicationStore } from '../src/lib/message-publication-store.js';
import {
    buildMessagePublicationArtifact,
    buildSignedPublishedMessagePayload,
    verifySignedPublishedMessageArtifact,
} from '../src/lib/signed-published-message.js';

const TEST_CHAIN_ID = 11155111;
const TEST_COMMITMENT_ADDRESSES = [
    '0x2222222222222222222222222222222222222222',
    '0x3333333333333333333333333333333333333333',
];

function buildServerConfig(signerAddress, overrides = {}) {
    return {
        chainId: TEST_CHAIN_ID,
        ipfsEnabled: true,
        ipfsApiUrl: 'http://ipfs.mock',
        ipfsHeaders: {
            Authorization: 'Bearer ipfs-test-token',
        },
        ipfsRequestTimeoutMs: 1_000,
        ipfsMaxRetries: 0,
        ipfsRetryDelayMs: 0,
        messagePublishApiHost: '127.0.0.1',
        messagePublishApiPort: 0,
        messagePublishApiKeys: {
            ops: 'k_test_ops_secret',
        },
        messagePublishApiSignerAllowlist: [signerAddress],
        messagePublishApiRequireSignerAllowlist: true,
        messagePublishApiSignatureMaxAgeSeconds: 300,
        messagePublishApiMaxBodyBytes: 65_536,
        messagePublishApiNodeName: 'test-node',
        ...overrides,
    };
}

function textResponse(status, text, statusText = '') {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        async text() {
            return text;
        },
    };
}

async function buildSignedBody({
    account,
    requestId,
    timestampMs = Date.now(),
    chainId = TEST_CHAIN_ID,
    commitmentAddresses = TEST_COMMITMENT_ADDRESSES,
    messagePatch = {},
}) {
    const message = {
        chainId,
        requestId,
        commitmentAddresses,
        agentAddress: account.address,
        kind: 'polymarket_trade_log',
        payload: {
            marketId: 'market-1',
            action: 'initiated',
        },
        ...messagePatch,
    };
    const payload = buildSignedPublishedMessagePayload({
        address: account.address,
        timestampMs,
        message,
    });
    const signature = await account.signMessage({ message: payload });
    return {
        payload,
        signature,
        body: {
            message,
            auth: {
                type: 'eip191',
                address: account.address,
                timestampMs,
                signature,
            },
        },
    };
}

async function postPublication(baseUrl, body, { bearerToken = 'k_test_ops_secret' } = {}) {
    const response = await fetch(`${baseUrl}/v1/messages/publish`, {
        method: 'POST',
        headers: {
            ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const raw = await response.text();
    let parsed;
    try {
        parsed = raw ? JSON.parse(raw) : {};
    } catch (error) {
        parsed = { raw };
    }
    return {
        status: response.status,
        ok: response.ok,
        json: parsed,
    };
}

async function main() {
    const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
    const otherAccount = privateKeyToAccount(`0x${'2'.repeat(64)}`);
    const nodeAccount = privateKeyToAccount(`0x${'3'.repeat(64)}`);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'message-publication-api-'));
    const stateFile = path.join(tempDir, 'message-publications.json');
    const store = createMessagePublicationStore({ stateFile });
    const logger = {
        infos: [],
        warnings: [],
        info(message) {
            this.infos.push(String(message));
        },
        warn(message) {
            this.warnings.push(String(message));
        },
    };

    const originalFetch = globalThis.fetch;
    const addAttemptsByRequestId = new Map();
    const pinAttemptsByRequestId = new Map();
    const artifactByCid = new Map();
    const requestIdByCid = new Map();
    const failPinOnce = new Set(['pin-retry']);

    globalThis.fetch = async (url, options = {}) => {
        const urlString = String(url);
        if (!urlString.startsWith('http://ipfs.mock')) {
            return originalFetch(url, options);
        }

        if (urlString.includes('/api/v0/add')) {
            assert.equal(options.method, 'POST');
            assert.equal(options.headers.Authorization, 'Bearer ipfs-test-token');
            const uploaded = options.body.get('file');
            const uploadedText = await uploaded.text();
            const artifact = JSON.parse(uploadedText);
            const requestId = artifact?.signedMessage?.envelope?.message?.requestId;
            const cid = `bafy${createHash('sha256').update(uploadedText).digest('hex').slice(0, 24)}`;
            addAttemptsByRequestId.set(requestId, (addAttemptsByRequestId.get(requestId) ?? 0) + 1);
            artifactByCid.set(cid, artifact);
            requestIdByCid.set(cid, requestId);
            return textResponse(
                200,
                JSON.stringify({
                    Name: 'artifact.json',
                    Hash: cid,
                    Size: String(uploadedText.length),
                })
            );
        }

        if (urlString.includes('/api/v0/pin/add')) {
            assert.equal(options.method, 'POST');
            assert.equal(options.headers.Authorization, 'Bearer ipfs-test-token');
            const parsed = new URL(urlString);
            const cid = parsed.searchParams.get('arg');
            const requestId = requestIdByCid.get(cid);
            pinAttemptsByRequestId.set(requestId, (pinAttemptsByRequestId.get(requestId) ?? 0) + 1);
            if (failPinOnce.has(requestId)) {
                failPinOnce.delete(requestId);
                return textResponse(500, '{"error":"temporary pin failure"}', 'Internal Server Error');
            }
            return textResponse(200, JSON.stringify({ Pins: [cid] }));
        }

        throw new Error(`Unexpected IPFS request: ${urlString}`);
    };

    const api = createMessagePublicationApiServer({
        config: buildServerConfig(account.address),
        store,
        logger,
        nodeSigner: {
            address: nodeAccount.address,
            async signMessage(message) {
                return nodeAccount.signMessage({ message });
            },
        },
    });
    const server = await api.start();
    const address = server.address();
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal(logger.infos.length, 1);
    assert.match(logger.infos[0], /Message publish API listening on/);
    assert.match(logger.infos[0], new RegExp(nodeAccount.address.slice(2, 8), 'i'));

    const bindFailStore = createMessagePublicationStore({
        stateFile: path.join(tempDir, 'message-publications-bind-fail.json'),
    });
    const bindFailApi = createMessagePublicationApiServer({
        config: buildServerConfig(account.address, {
            messagePublishApiPort: address.port,
        }),
        store: bindFailStore,
        logger: {
            info() {},
            warn() {},
        },
        nodeSigner: {
            address: nodeAccount.address,
            async signMessage(message) {
                return nodeAccount.signMessage({ message });
            },
        },
    });
    await assert.rejects(() => bindFailApi.start(), /EADDRINUSE|listen/i);

    try {
        const health = await fetch(`${baseUrl}/healthz`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { ok: true });

        const missingBearer = await postPublication(
            baseUrl,
            {
                message: {
                    chainId: TEST_CHAIN_ID,
                    requestId: 'missing-bearer',
                    commitmentAddresses: TEST_COMMITMENT_ADDRESSES,
                    agentAddress: account.address,
                },
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs: Date.now(),
                    signature: `0x${'0'.repeat(130)}`,
                },
            },
            { bearerToken: undefined }
        );
        assert.equal(missingBearer.status, 401);

        const acceptedRequest = await buildSignedBody({
            account,
            requestId: 'publish-ok',
            messagePatch: {
                payload: {
                    marketId: 'market-1',
                    action: 'initiated',
                    price: '0.41',
                },
            },
        });
        const accepted = await postPublication(baseUrl, acceptedRequest.body);
        assert.equal(accepted.status, 202);
        assert.equal(accepted.json.status, 'published');
        assert.equal(accepted.json.pinned, true);
        assert.ok(accepted.json.cid);
        assert.equal(addAttemptsByRequestId.get('publish-ok'), 1);
        assert.equal(pinAttemptsByRequestId.get('publish-ok'), 1);

        const publishedArtifact = artifactByCid.get(accepted.json.cid);
        assert.ok(publishedArtifact);
        const verification = await verifySignedPublishedMessageArtifact(publishedArtifact);
        assert.equal(verification.ok, true);
        assert.equal(verification.requestId, 'publish-ok');
        assert.equal(verification.signer, account.address.toLowerCase());
        assert.equal(verification.agentAddress, account.address.toLowerCase());
        assert.deepEqual(
            verification.commitmentAddresses,
            TEST_COMMITMENT_ADDRESSES.map((value) => value.toLowerCase())
        );
        assert.equal(verification.publishedAtMs >= verification.receivedAtMs, true);
        assert.ok(verification.nodeAttestation);
        assert.equal(
            verification.nodeAttestation.signer,
            nodeAccount.address.toLowerCase()
        );
        assert.equal(
            verification.nodeAttestation.envelope.signedMessage.signer,
            account.address.toLowerCase()
        );
        assert.equal(accepted.json.nodeSigner, nodeAccount.address.toLowerCase());

        const duplicate = await postPublication(baseUrl, acceptedRequest.body);
        assert.equal(duplicate.status, 200);
        assert.equal(duplicate.json.status, 'duplicate');
        assert.equal(duplicate.json.cid, accepted.json.cid);
        assert.equal(duplicate.json.nodeSigner, nodeAccount.address.toLowerCase());
        assert.equal(addAttemptsByRequestId.get('publish-ok'), 1);
        assert.equal(pinAttemptsByRequestId.get('publish-ok'), 1);

        const conflicting = await buildSignedBody({
            account,
            requestId: 'publish-ok',
            messagePatch: {
                payload: {
                    marketId: 'market-1',
                    action: 'continuation',
                },
            },
        });
        const conflictingResponse = await postPublication(baseUrl, conflicting.body);
        assert.equal(conflictingResponse.status, 409);
        assert.equal(conflictingResponse.json.code, 'request_conflict');
        assert.equal(conflictingResponse.json.cid, accepted.json.cid);

        const tampered = await postPublication(baseUrl, {
            ...acceptedRequest.body,
            message: {
                ...acceptedRequest.body.message,
                payload: {
                    marketId: 'market-1',
                    action: 'tampered',
                },
            },
        });
        assert.equal(tampered.status, 401);

        const rejectedOtherSignerRequest = await buildSignedBody({
            account: otherAccount,
            requestId: 'other-signer',
        });
        const rejectedOtherSigner = await postPublication(baseUrl, rejectedOtherSignerRequest.body);
        assert.equal(rejectedOtherSigner.status, 401);

        const pinRetryRequest = await buildSignedBody({
            account,
            requestId: 'pin-retry',
            messagePatch: {
                payload: {
                    marketId: 'market-1',
                    action: 'initiated',
                    price: '0.55',
                },
            },
        });
        const pinRetryFirst = await postPublication(baseUrl, pinRetryRequest.body);
        assert.equal(pinRetryFirst.status, 502);
        assert.equal(pinRetryFirst.json.code, 'publish_failed');
        assert.ok(pinRetryFirst.json.cid);
        assert.equal(addAttemptsByRequestId.get('pin-retry'), 1);
        assert.equal(pinAttemptsByRequestId.get('pin-retry'), 1);

        const failedPinRecord = await store.getRecord({
            signer: account.address,
            chainId: TEST_CHAIN_ID,
            requestId: 'pin-retry',
        });
        assert.equal(failedPinRecord.cid, pinRetryFirst.json.cid);
        assert.equal(failedPinRecord.pinned, false);
        assert.ok(failedPinRecord.artifact);
        assert.ok(failedPinRecord.lastError);

        const pinRetrySecond = await postPublication(baseUrl, pinRetryRequest.body);
        assert.equal(pinRetrySecond.status, 200);
        assert.equal(pinRetrySecond.json.status, 'duplicate');
        assert.equal(pinRetrySecond.json.cid, pinRetryFirst.json.cid);
        assert.equal(addAttemptsByRequestId.get('pin-retry'), 1);
        assert.equal(pinAttemptsByRequestId.get('pin-retry'), 2);

        const recoveredPinRecord = await store.getRecord({
            signer: account.address,
            chainId: TEST_CHAIN_ID,
            requestId: 'pin-retry',
        });
        assert.equal(recoveredPinRecord.cid, pinRetryFirst.json.cid);
        assert.equal(recoveredPinRecord.pinned, true);
        assert.equal(recoveredPinRecord.lastError, null);

        const timestampIntegrityRequest = await buildSignedBody({
            account,
            requestId: 'timestamp-integrity',
            timestampMs: Date.now(),
        });
        const timestampIntegrityAccepted = await postPublication(
            baseUrl,
            timestampIntegrityRequest.body
        );
        assert.equal(timestampIntegrityAccepted.status, 202);
        const timestampIntegrityArtifact = artifactByCid.get(
            timestampIntegrityAccepted.json.cid
        );
        assert.ok(timestampIntegrityArtifact);

        const tamperedSignedAtArtifact = structuredClone(timestampIntegrityArtifact);
        tamperedSignedAtArtifact.signedMessage.signedAtMs += 1;
        await assert.rejects(
            () => verifySignedPublishedMessageArtifact(tamperedSignedAtArtifact),
            /signedAtMs must match envelope\.timestampMs\./
        );

        const tamperedSignerEnvelopeArtifact = structuredClone(timestampIntegrityArtifact);
        tamperedSignerEnvelopeArtifact.signedMessage.envelope.address =
            otherAccount.address.toLowerCase();
        await assert.rejects(
            () => verifySignedPublishedMessageArtifact(tamperedSignerEnvelopeArtifact),
            /message\.agentAddress must match the signing address\.|artifact signer does not match the signed message envelope address\./
        );

        const tamperedNodeSignedAtArtifact = structuredClone(timestampIntegrityArtifact);
        tamperedNodeSignedAtArtifact.publication.nodeAttestation.signedAtMs += 1;
        await assert.rejects(
            () => verifySignedPublishedMessageArtifact(tamperedNodeSignedAtArtifact),
            /signedAtMs must match envelope\.timestampMs\./
        );

        const tamperedNodeEnvelopeArtifact = structuredClone(timestampIntegrityArtifact);
        tamperedNodeEnvelopeArtifact.publication.nodeAttestation.envelope.address =
            otherAccount.address.toLowerCase();
        await assert.rejects(
            () => verifySignedPublishedMessageArtifact(tamperedNodeEnvelopeArtifact),
            /canonicalMessage does not match the normalized message publication node attestation envelope\.|artifact node attestation signer does not match the node attestation envelope address\./
        );

        assert.throws(
            () =>
                buildMessagePublicationArtifact({
                    signer: account.address,
                    signature: timestampIntegrityRequest.signature,
                    signedAtMs: timestampIntegrityRequest.body.auth.timestampMs + 1,
                    canonicalMessage: timestampIntegrityRequest.payload,
                    envelope: JSON.parse(timestampIntegrityRequest.payload),
                    receivedAtMs: Date.now(),
                    publishedAtMs: Date.now(),
                    signerAllowlistMode: 'explicit',
                    nodeName: 'test-node',
                    nodeAttestation: timestampIntegrityArtifact.publication.nodeAttestation,
                }),
            /signedAtMs must match envelope\.timestampMs\./
        );

        const expiredFirstAttempt = await buildSignedBody({
            account,
            requestId: 'expired-first-attempt',
            timestampMs: Date.now() - 301_000,
        });
        const expiredRejected = await postPublication(baseUrl, expiredFirstAttempt.body);
        assert.equal(expiredRejected.status, 401);

        const expiredDuplicate = await buildSignedBody({
            account,
            requestId: 'expired-duplicate',
        });
        const expiredDuplicateAccepted = await postPublication(baseUrl, expiredDuplicate.body);
        assert.equal(expiredDuplicateAccepted.status, 202);

        const expiredDuplicateReplay = await postPublication(baseUrl, {
            ...expiredDuplicate.body,
            auth: {
                ...expiredDuplicate.body.auth,
                timestampMs: Date.now() - 301_000,
            },
        });
        assert.equal(expiredDuplicateReplay.status, 401);

        const exactExpiredDuplicateReplay = await postPublication(baseUrl, {
            ...expiredDuplicate.body,
            auth: {
                ...expiredDuplicate.body.auth,
                timestampMs: expiredDuplicate.body.auth.timestampMs,
            },
        });
        assert.equal(exactExpiredDuplicateReplay.status, 200);
        assert.equal(exactExpiredDuplicateReplay.json.status, 'duplicate');
    } finally {
        await api.stop();
        globalThis.fetch = originalFetch;
        await rm(tempDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error('[test] message publication API failed:', error?.message ?? error);
    process.exit(1);
});
