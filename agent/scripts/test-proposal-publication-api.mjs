import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { createProposalPublicationApiServer } from '../src/lib/proposal-publication-api.js';
import { createProposalPublicationStore } from '../src/lib/proposal-publication-store.js';
import {
    buildSignedProposalPayload,
    verifySignedProposalArtifact,
} from '../src/lib/signed-proposal.js';

const TEST_CHAIN_ID = 11155111;
const TEST_SAFE = '0x2222222222222222222222222222222222222222';
const TEST_OG_MODULE = '0x3333333333333333333333333333333333333333';
const TEST_TRANSACTIONS = [
    {
        to: '0x4444444444444444444444444444444444444444',
        value: '0',
        data: '0x1234',
        operation: 0,
    },
];

function buildServerConfig(signerAddress) {
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
        proposalPublishApiHost: '127.0.0.1',
        proposalPublishApiPort: 0,
        proposalPublishApiKeys: {
            ops: 'k_test_ops_secret',
        },
        proposalPublishApiSignerAllowlist: [signerAddress],
        proposalPublishApiRequireSignerAllowlist: true,
        proposalPublishApiSignatureMaxAgeSeconds: 300,
        proposalPublishApiMaxBodyBytes: 65_536,
        proposalPublishApiNodeName: 'test-node',
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
    explanation = 'Archive the signed proposal for review.',
    metadata = undefined,
    timestampMs = Date.now(),
    deadline = undefined,
    transactions = TEST_TRANSACTIONS,
    chainId = TEST_CHAIN_ID,
    commitmentSafe = TEST_SAFE,
    ogModule = TEST_OG_MODULE,
}) {
    const payload = buildSignedProposalPayload({
        address: account.address,
        chainId,
        timestampMs,
        requestId,
        commitmentSafe,
        ogModule,
        transactions,
        explanation,
        metadata,
        deadline,
    });
    const signature = await account.signMessage({ message: payload });
    return {
        payload,
        signature,
        body: {
            chainId,
            requestId,
            commitmentSafe,
            ogModule,
            transactions,
            explanation,
            ...(metadata !== undefined ? { metadata } : {}),
            ...(deadline !== undefined ? { deadline } : {}),
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
    const response = await fetch(`${baseUrl}/v1/proposals/publish`, {
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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'proposal-publication-api-'));
    const stateFile = path.join(tempDir, 'proposal-publications.json');
    const store = createProposalPublicationStore({ stateFile });
    const logger = {
        logs: [],
        warnings: [],
        log(message) {
            this.logs.push(String(message));
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
            const requestId = artifact?.signedProposal?.envelope?.requestId;
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

    const api = createProposalPublicationApiServer({
        config: buildServerConfig(account.address),
        store,
        logger,
    });
    const server = await api.start();
    const address = server.address();
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        const health = await fetch(`${baseUrl}/healthz`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { ok: true });

        const missingBearer = await postPublication(baseUrl, {
            chainId: TEST_CHAIN_ID,
            requestId: 'missing-bearer',
            commitmentSafe: TEST_SAFE,
            ogModule: TEST_OG_MODULE,
            transactions: TEST_TRANSACTIONS,
            explanation: 'Missing bearer token test.',
            auth: {
                type: 'eip191',
                address: account.address,
                timestampMs: Date.now(),
                signature: `0x${'0'.repeat(130)}`,
            },
        }, { bearerToken: undefined });
        assert.equal(missingBearer.status, 401);

        const acceptedRequest = await buildSignedBody({
            account,
            requestId: 'publish-ok',
            metadata: { module: 'proposal-publication-api-test' },
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
        const verification = await verifySignedProposalArtifact(publishedArtifact);
        assert.equal(verification.ok, true);
        assert.equal(verification.requestId, 'publish-ok');
        assert.equal(verification.signer, account.address.toLowerCase());
        assert.equal(verification.publishedAtMs >= verification.receivedAtMs, true);

        const duplicate = await postPublication(baseUrl, acceptedRequest.body);
        assert.equal(duplicate.status, 200);
        assert.equal(duplicate.json.status, 'duplicate');
        assert.equal(duplicate.json.cid, accepted.json.cid);
        assert.equal(addAttemptsByRequestId.get('publish-ok'), 1);
        assert.equal(pinAttemptsByRequestId.get('publish-ok'), 1);

        const conflicting = await buildSignedBody({
            account,
            requestId: 'publish-ok',
            explanation: 'Conflicting explanation text.',
        });
        const conflictingResponse = await postPublication(baseUrl, conflicting.body);
        assert.equal(conflictingResponse.status, 409);
        assert.equal(conflictingResponse.json.code, 'request_conflict');
        assert.equal(conflictingResponse.json.cid, accepted.json.cid);

        const tampered = await postPublication(baseUrl, {
            ...acceptedRequest.body,
            explanation: 'tampered explanation',
        });
        assert.equal(tampered.status, 401);

        const rejectedOtherSignerRequest = await buildSignedBody({
            account: otherAccount,
            requestId: 'other-signer',
        });
        const rejectedOtherSigner = await postPublication(
            baseUrl,
            rejectedOtherSignerRequest.body
        );
        assert.equal(rejectedOtherSigner.status, 401);

        const expiredRequest = await buildSignedBody({
            account,
            requestId: 'expired-request',
            timestampMs: Date.now() - 301_000,
        });
        const expired = await postPublication(baseUrl, expiredRequest.body);
        assert.equal(expired.status, 401);

        const pinRetryRequest = await buildSignedBody({
            account,
            requestId: 'pin-retry',
            explanation: 'Pin retry scenario.',
        });
        const pinRetryFirst = await postPublication(baseUrl, pinRetryRequest.body);
        assert.equal(pinRetryFirst.status, 502);
        assert.equal(pinRetryFirst.json.code, 'pin_failed');
        assert.ok(pinRetryFirst.json.cid);
        assert.equal(addAttemptsByRequestId.get('pin-retry'), 1);
        assert.equal(pinAttemptsByRequestId.get('pin-retry'), 1);

        const pinRetrySecond = await postPublication(baseUrl, pinRetryRequest.body);
        assert.equal(pinRetrySecond.status, 202);
        assert.equal(pinRetrySecond.json.status, 'published');
        assert.equal(pinRetrySecond.json.cid, pinRetryFirst.json.cid);
        assert.equal(addAttemptsByRequestId.get('pin-retry'), 1);
        assert.equal(pinAttemptsByRequestId.get('pin-retry'), 2);

        const pinnedRecord = await store.getRecord({
            signer: account.address,
            requestId: 'pin-retry',
        });
        assert.equal(pinnedRecord.pinned, true);
        assert.equal(pinnedRecord.cid, pinRetryFirst.json.cid);
        assert.equal(pinnedRecord.lastError, null);
    } finally {
        globalThis.fetch = originalFetch;
        await api.stop();
        await rm(tempDir, { recursive: true, force: true });
    }

    console.log('[test] proposal publication API OK');
}

main().catch((error) => {
    console.error('[test] proposal publication API failed:', error?.message ?? error);
    process.exit(1);
});
