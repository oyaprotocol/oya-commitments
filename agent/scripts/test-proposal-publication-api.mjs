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
const BASE_TIME_MS = 1_774_900_000_000;
const TEST_TRANSACTIONS = [
    {
        to: '0x4444444444444444444444444444444444444444',
        value: '0',
        data: '0x1234',
        operation: 0,
    },
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
        proposalPublishApiHost: '127.0.0.1',
        proposalPublishApiPort: 0,
        proposalPublishApiMode: 'publish',
        proposalPublishApiKeys: {
            ops: 'k_test_ops_secret',
        },
        proposalPublishApiSignerAllowlist: [signerAddress],
        proposalPublishApiRequireSignerAllowlist: true,
        proposalPublishApiSignatureMaxAgeSeconds: 300,
        proposalPublishApiMaxBodyBytes: 65_536,
        proposalPublishApiNodeName: 'test-node',
        proposalVerificationMode: 'off',
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

async function postVerification(baseUrl, body, { bearerToken = 'k_test_ops_secret' } = {}) {
    const response = await fetch(`${baseUrl}/v1/proposals/verify`, {
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
    const failAddOnce = new Set(['publish-retry-expired', 'publish-retry-resigned']);
    let releaseConcurrentAdd;
    const concurrentAddBlocked = new Promise((resolve) => {
        releaseConcurrentAdd = resolve;
    });
    let concurrentAddObservedResolve;
    const concurrentAddObserved = new Promise((resolve) => {
        concurrentAddObservedResolve = resolve;
    });
    const holdAddOnce = new Set(['concurrent-duplicate']);
    const originalDateNow = Date.now;
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
            if (holdAddOnce.has(requestId)) {
                holdAddOnce.delete(requestId);
                concurrentAddObservedResolve();
                await concurrentAddBlocked;
            }
            if (failAddOnce.has(requestId)) {
                failAddOnce.delete(requestId);
                return textResponse(500, '{"error":"temporary add failure"}', 'Internal Server Error');
            }
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
    assert.equal(logger.infos.length, 1);
    assert.match(logger.infos[0], /Proposal publish API \(publish\) listening on/);

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

        const concurrentRequest = await buildSignedBody({
            account,
            requestId: 'concurrent-duplicate',
            explanation: 'Concurrent identical publish requests.',
        });
        const concurrentFirstPromise = postPublication(baseUrl, concurrentRequest.body);
        await concurrentAddObserved;
        const concurrentSecondPromise = postPublication(baseUrl, concurrentRequest.body);
        releaseConcurrentAdd();
        const [concurrentFirst, concurrentSecond] = await Promise.all([
            concurrentFirstPromise,
            concurrentSecondPromise,
        ]);
        assert.deepEqual(
            [concurrentFirst.status, concurrentSecond.status].sort((left, right) => left - right),
            [200, 202]
        );
        assert.equal(concurrentFirst.json.cid, concurrentSecond.json.cid);
        assert.equal(addAttemptsByRequestId.get('concurrent-duplicate'), 1);
        assert.equal(pinAttemptsByRequestId.get('concurrent-duplicate'), 1);

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
            chainId: TEST_CHAIN_ID,
            requestId: 'pin-retry',
        });
        assert.equal(pinnedRecord.pinned, true);
        assert.equal(pinnedRecord.cid, pinRetryFirst.json.cid);
        assert.equal(pinnedRecord.lastError, null);

        const publishPersistStateFile = path.join(
            tempDir,
            'proposal-publications-persist-retry.json'
        );
        const publishPersistStoreBase = createProposalPublicationStore({
            stateFile: publishPersistStateFile,
        });
        let publishPersistFailures = 0;
        const publishPersistStore = {
            async getRecord(args) {
                return publishPersistStoreBase.getRecord(args);
            },
            async prepareRecord(args) {
                return publishPersistStoreBase.prepareRecord(args);
            },
            async updateRecord(recordOrKey, updater) {
                return publishPersistStoreBase.updateRecord(recordOrKey, async (current) => {
                    const nextRecord = await updater(current);
                    if (
                        nextRecord.cid &&
                        !nextRecord.pinned &&
                        nextRecord.lastError === null &&
                        publishPersistFailures < 3
                    ) {
                        publishPersistFailures += 1;
                        throw new Error('simulated publish persistence failure');
                    }
                    return nextRecord;
                });
            },
            async saveRecord(record) {
                if (
                    record.cid &&
                    !record.pinned &&
                    record.lastError === null &&
                    publishPersistFailures < 3
                ) {
                    publishPersistFailures += 1;
                    throw new Error('simulated publish persistence failure');
                }
                return publishPersistStoreBase.saveRecord(record);
            },
        };
        const publishPersistApi = createProposalPublicationApiServer({
            config: buildServerConfig(account.address),
            store: publishPersistStore,
            logger: {
                info() {},
                warn() {},
            },
        });
        const publishPersistServer = await publishPersistApi.start();
        const publishPersistAddress = publishPersistServer.address();
        assert.ok(
            publishPersistAddress &&
                typeof publishPersistAddress === 'object' &&
                typeof publishPersistAddress.port === 'number'
        );
        const publishPersistBaseUrl = `http://127.0.0.1:${publishPersistAddress.port}`;

        try {
            const publishPersistRequest = await buildSignedBody({
                account,
                requestId: 'publish-persist-retry',
                explanation: 'Reuse CID after persistence failure.',
            });
            const publishPersistFirst = await postPublication(
                publishPersistBaseUrl,
                publishPersistRequest.body
            );
            assert.equal(publishPersistFirst.status, 502);
            assert.equal(publishPersistFirst.json.code, 'publish_persist_failed');
            assert.ok(publishPersistFirst.json.cid);
            assert.equal(addAttemptsByRequestId.get('publish-persist-retry'), 1);
            assert.equal(pinAttemptsByRequestId.get('publish-persist-retry') ?? 0, 0);

            const publishPersistPendingRecord = await publishPersistStoreBase.getRecord({
                signer: account.address,
                chainId: TEST_CHAIN_ID,
                requestId: 'publish-persist-retry',
            });
            assert.equal(publishPersistPendingRecord.cid, null);
            assert.equal(publishPersistPendingRecord.pinned, false);

            const publishPersistSecond = await postPublication(
                publishPersistBaseUrl,
                publishPersistRequest.body
            );
            assert.equal(publishPersistSecond.status, 202);
            assert.equal(publishPersistSecond.json.status, 'published');
            assert.equal(
                publishPersistSecond.json.cid,
                publishPersistFirst.json.cid
            );
            assert.equal(addAttemptsByRequestId.get('publish-persist-retry'), 1);
            assert.equal(pinAttemptsByRequestId.get('publish-persist-retry'), 1);

            const publishPersistRecoveredRecord = await publishPersistStoreBase.getRecord({
                signer: account.address,
                chainId: TEST_CHAIN_ID,
                requestId: 'publish-persist-retry',
            });
            assert.equal(
                publishPersistRecoveredRecord.cid,
                publishPersistFirst.json.cid
            );
            assert.equal(publishPersistRecoveredRecord.pinned, true);
            assert.equal(
                publishPersistRecoveredRecord.publishedAtMs,
                publishPersistFirst.json.publishedAtMs
            );
        } finally {
            await publishPersistApi.stop();
        }

        const publishPersistRestartStateFile = path.join(
            tempDir,
            'proposal-publications-persist-restart.json'
        );
        const publishPersistRestartStoreBase = createProposalPublicationStore({
            stateFile: publishPersistRestartStateFile,
        });
        let publishPersistRestartFailures = 0;
        const publishPersistRestartFailingStore = {
            async getRecord(args) {
                return publishPersistRestartStoreBase.getRecord(args);
            },
            async prepareRecord(args) {
                return publishPersistRestartStoreBase.prepareRecord(args);
            },
            async updateRecord(recordOrKey, updater) {
                return publishPersistRestartStoreBase.updateRecord(recordOrKey, async (current) => {
                    const nextRecord = await updater(current);
                    if (
                        nextRecord.cid &&
                        !nextRecord.pinned &&
                        nextRecord.lastError === null &&
                        publishPersistRestartFailures < 3
                    ) {
                        publishPersistRestartFailures += 1;
                        throw new Error('simulated publish persistence failure across restart');
                    }
                    return nextRecord;
                });
            },
            async saveRecord(record) {
                if (
                    record.cid &&
                    !record.pinned &&
                    record.lastError === null &&
                    publishPersistRestartFailures < 3
                ) {
                    publishPersistRestartFailures += 1;
                    throw new Error('simulated publish persistence failure across restart');
                }
                return publishPersistRestartStoreBase.saveRecord(record);
            },
        };
        const publishPersistRestartApi = createProposalPublicationApiServer({
            config: buildServerConfig(account.address),
            store: publishPersistRestartFailingStore,
            logger: {
                info() {},
                warn() {},
            },
        });
        const publishPersistRestartServer = await publishPersistRestartApi.start();
        const publishPersistRestartAddress = publishPersistRestartServer.address();
        assert.ok(
            publishPersistRestartAddress &&
                typeof publishPersistRestartAddress === 'object' &&
                typeof publishPersistRestartAddress.port === 'number'
        );
        const publishPersistRestartBaseUrl = `http://127.0.0.1:${publishPersistRestartAddress.port}`;
        let publishPersistRestartStopped = false;

        try {
            const publishPersistRestartRequest = await buildSignedBody({
                account,
                requestId: 'publish-persist-restart',
                explanation: 'Recover stable CID after node restart.',
            });
            const publishPersistRestartFirst = await postPublication(
                publishPersistRestartBaseUrl,
                publishPersistRestartRequest.body
            );
            assert.equal(publishPersistRestartFirst.status, 502);
            assert.equal(publishPersistRestartFirst.json.code, 'publish_persist_failed');
            assert.ok(publishPersistRestartFirst.json.cid);
            assert.equal(addAttemptsByRequestId.get('publish-persist-restart'), 1);
            assert.equal(pinAttemptsByRequestId.get('publish-persist-restart') ?? 0, 0);

            const publishPersistRestartCheckpoint =
                await publishPersistRestartStoreBase.getRecord({
                    signer: account.address,
                    chainId: TEST_CHAIN_ID,
                    requestId: 'publish-persist-restart',
                });
            assert.equal(publishPersistRestartCheckpoint.cid, null);
            assert.equal(publishPersistRestartCheckpoint.pinned, false);
            assert.ok(publishPersistRestartCheckpoint.artifact);
            assert.equal(
                publishPersistRestartCheckpoint.publishedAtMs,
                publishPersistRestartFirst.json.publishedAtMs
            );

            await publishPersistRestartApi.stop();
            publishPersistRestartStopped = true;

            const publishPersistRestartRecoveryApi = createProposalPublicationApiServer({
                config: buildServerConfig(account.address),
                store: publishPersistRestartStoreBase,
                logger: {
                    info() {},
                    warn() {},
                },
            });
            const publishPersistRestartRecoveryServer =
                await publishPersistRestartRecoveryApi.start();
            const publishPersistRestartRecoveryAddress =
                publishPersistRestartRecoveryServer.address();
            assert.ok(
                publishPersistRestartRecoveryAddress &&
                    typeof publishPersistRestartRecoveryAddress === 'object' &&
                    typeof publishPersistRestartRecoveryAddress.port === 'number'
            );
            const publishPersistRestartRecoveryBaseUrl = `http://127.0.0.1:${publishPersistRestartRecoveryAddress.port}`;

            try {
                const publishPersistRestartSecond = await postPublication(
                    publishPersistRestartRecoveryBaseUrl,
                    publishPersistRestartRequest.body
                );
                assert.equal(publishPersistRestartSecond.status, 202);
                assert.equal(publishPersistRestartSecond.json.status, 'published');
                assert.equal(
                    publishPersistRestartSecond.json.cid,
                    publishPersistRestartFirst.json.cid
                );
                assert.equal(addAttemptsByRequestId.get('publish-persist-restart'), 2);
                assert.equal(pinAttemptsByRequestId.get('publish-persist-restart'), 1);

                const publishPersistRestartRecovered =
                    await publishPersistRestartStoreBase.getRecord({
                        signer: account.address,
                        chainId: TEST_CHAIN_ID,
                        requestId: 'publish-persist-restart',
                    });
                assert.equal(
                    publishPersistRestartRecovered.cid,
                    publishPersistRestartFirst.json.cid
                );
                assert.equal(publishPersistRestartRecovered.pinned, true);
                assert.equal(
                    publishPersistRestartRecovered.publishedAtMs,
                    publishPersistRestartFirst.json.publishedAtMs
                );
            } finally {
                await publishPersistRestartRecoveryApi.stop();
            }
        } finally {
            if (!publishPersistRestartStopped) {
                await publishPersistRestartApi.stop();
            }
        }

        const retryBaseNowMs = originalDateNow();
        Date.now = () => retryBaseNowMs;
        const publishRetryRequest = await buildSignedBody({
            account,
            requestId: 'publish-retry-expired',
            explanation: 'Retry exact same signed payload after add outage.',
            timestampMs: retryBaseNowMs,
        });
        const publishRetryFirst = await postPublication(baseUrl, publishRetryRequest.body);
        assert.equal(publishRetryFirst.status, 502);
        assert.equal(publishRetryFirst.json.code, 'publish_failed');
        assert.equal(publishRetryFirst.json.cid, null);
        const pendingAfterAddFailure = await store.getRecord({
            signer: account.address,
            chainId: TEST_CHAIN_ID,
            requestId: 'publish-retry-expired',
        });
        assert.equal(pendingAfterAddFailure.cid, null);
        assert.equal(pendingAfterAddFailure.publishedAtMs, null);
        assert.equal(pendingAfterAddFailure.artifact, null);

        Date.now = () => retryBaseNowMs + 301_000;
        const publishRetrySecond = await postPublication(baseUrl, publishRetryRequest.body);
        assert.equal(publishRetrySecond.status, 202);
        assert.equal(publishRetrySecond.json.status, 'published');
        assert.ok(publishRetrySecond.json.cid);
        assert.equal(addAttemptsByRequestId.get('publish-retry-expired'), 2);
        const exactRetryRecord = await store.getRecord({
            signer: account.address,
            chainId: TEST_CHAIN_ID,
            requestId: 'publish-retry-expired',
        });
        assert.ok(exactRetryRecord.publishedAtMs >= retryBaseNowMs + 301_000);
        assert.ok(exactRetryRecord.artifact);
        assert.equal(
            exactRetryRecord.artifact.publication.publishedAtMs,
            exactRetryRecord.publishedAtMs
        );

        Date.now = () => retryBaseNowMs + 400_000;
        const resignedFirst = await buildSignedBody({
            account,
            requestId: 'publish-retry-resigned',
            explanation: 'Retry with a refreshed signature after add outage.',
            timestampMs: retryBaseNowMs + 400_000,
        });
        const resignedFailure = await postPublication(baseUrl, resignedFirst.body);
        assert.equal(resignedFailure.status, 502);
        assert.equal(resignedFailure.json.code, 'publish_failed');

        Date.now = () => retryBaseNowMs + 801_000;
        const resignedSecond = await buildSignedBody({
            account,
            requestId: 'publish-retry-resigned',
            explanation: 'Retry with a refreshed signature after add outage.',
            timestampMs: retryBaseNowMs + 801_000,
        });
        const resignedSuccess = await postPublication(baseUrl, resignedSecond.body);
        assert.equal(resignedSuccess.status, 202);
        assert.equal(resignedSuccess.json.status, 'published');
        assert.ok(resignedSuccess.json.cid);
        const resignedRecord = await store.getRecord({
            signer: account.address,
            chainId: TEST_CHAIN_ID,
            requestId: 'publish-retry-resigned',
        });
        assert.equal(resignedRecord.signature, resignedSecond.signature);
        assert.equal(resignedRecord.canonicalMessage, resignedSecond.payload);
        assert.ok(resignedRecord.publishedAtMs >= retryBaseNowMs + 801_000);
        assert.equal(addAttemptsByRequestId.get('publish-retry-resigned'), 2);

        const verifyStateFile = path.join(tempDir, 'proposal-publications-verify.json');
        const verifyStore = createProposalPublicationStore({ stateFile: verifyStateFile });
        const observedVerifyCalls = [];
        const verifyApi = createProposalPublicationApiServer({
            config: buildServerConfig(account.address),
            store: verifyStore,
            logger: {
                info() {},
                warn() {},
            },
            verifyProposal: async ({ envelope }) => {
                observedVerifyCalls.push({
                    requestId: envelope.requestId,
                });
                return {
                    status: 'valid',
                    verifiedAtMs: 1_760_000_000_123,
                    proposalKind: 'agent_proxy_reimbursement',
                    rules: {
                        rulesHash: `0x${'a'.repeat(64)}`,
                        matchedTemplates: [],
                        unparsedSections: [],
                    },
                    checks: [
                        {
                            id: 'stubbed_verifier',
                            status: 'pass',
                            message: 'Stub verifier accepted the request.',
                        },
                    ],
                    derivedFacts: {
                        requestId: envelope.requestId,
                    },
                };
            },
        });
        const verifyServer = await verifyApi.start();
        const verifyAddress = verifyServer.address();
        assert.ok(
            verifyAddress &&
                typeof verifyAddress === 'object' &&
                typeof verifyAddress.port === 'number'
        );
        const verifyBaseUrl = `http://127.0.0.1:${verifyAddress.port}`;

        try {
            const verifyRequest = await buildSignedBody({
                account,
                requestId: 'verify-ok',
                explanation: 'Verify only request.',
            });
            const verifyResponse = await postVerification(verifyBaseUrl, verifyRequest.body);
            assert.equal(verifyResponse.status, 200);
            assert.equal(verifyResponse.json.status, 'valid');
            assert.equal(verifyResponse.json.derivedFacts.requestId, 'verify-ok');
            assert.deepEqual(observedVerifyCalls, [
                {
                    requestId: 'verify-ok',
                },
            ]);
            const verifyRecord = await verifyStore.getRecord({
                signer: account.address,
                chainId: TEST_CHAIN_ID,
                requestId: 'verify-ok',
            });
            assert.equal(verifyRecord, null);

            const verifyUnsupportedRulesText = await postVerification(verifyBaseUrl, {
                ...verifyRequest.body,
                rulesText:
                    'Agent Proxy\n---\nThe agent at address 0x1111111111111111111111111111111111111111 may trade tokens in this commitment for different tokens.',
            });
            assert.equal(verifyUnsupportedRulesText.status, 400);
            assert.match(
                verifyUnsupportedRulesText.json.error,
                /Unsupported field: rulesText/
            );
        } finally {
            await verifyApi.stop();
        }

        const verifyNoHistoryStateFile = path.join(
            tempDir,
            'proposal-publications-verify-no-history.json'
        );
        const verifyNoHistoryStoreBase = createProposalPublicationStore({
            stateFile: verifyNoHistoryStateFile,
        });
        const verifyNoHistoryStore = {
            async getRecord(args) {
                return verifyNoHistoryStoreBase.getRecord(args);
            },
        };
        let verifyNoHistoryCalls = 0;
        const verifyNoHistoryApi = createProposalPublicationApiServer({
            config: buildServerConfig(account.address),
            store: verifyNoHistoryStore,
            logger: {
                info() {},
                warn() {},
            },
            verifyProposal: async () => {
                verifyNoHistoryCalls += 1;
                return {
                    status: 'valid',
                    verifiedAtMs: BASE_TIME_MS + 1,
                    proposalKind: 'agent_proxy_reimbursement',
                    rules: {
                        rulesHash: `0x${'f'.repeat(64)}`,
                        matchedTemplates: [],
                        unparsedSections: [],
                    },
                    checks: [],
                    derivedFacts: {},
                };
            },
        });
        const verifyNoHistoryServer = await verifyNoHistoryApi.start();
        const verifyNoHistoryAddress = verifyNoHistoryServer.address();
        assert.ok(
            verifyNoHistoryAddress &&
                typeof verifyNoHistoryAddress === 'object' &&
                typeof verifyNoHistoryAddress.port === 'number'
        );
        const verifyNoHistoryBaseUrl = `http://127.0.0.1:${verifyNoHistoryAddress.port}`;

        try {
            const verifyNoHistoryRequest = await buildSignedBody({
                account,
                requestId: 'verify-no-history',
                explanation: 'Verify should fail closed without record enumeration.',
            });
            const verifyNoHistoryResponse = await postVerification(
                verifyNoHistoryBaseUrl,
                verifyNoHistoryRequest.body
            );
            assert.equal(verifyNoHistoryResponse.status, 503);
            assert.equal(
                verifyNoHistoryResponse.json.code,
                'verification_history_unavailable'
            );
            assert.match(
                verifyNoHistoryResponse.json.error,
                /supports listRecords\(\)/
            );
            assert.equal(verifyNoHistoryCalls, 0);
        } finally {
            await verifyNoHistoryApi.stop();
        }

        const verifyExistingStateFile = path.join(
            tempDir,
            'proposal-publications-verify-existing.json'
        );
        const verifyExistingStoreBase = createProposalPublicationStore({
            stateFile: verifyExistingStateFile,
        });
        const verifyExistingRequest = await buildSignedBody({
            account,
            requestId: 'verify-existing',
            explanation: 'Verify existing exact-match request.',
        });
        await verifyExistingStoreBase.saveRecord({
            signer: account.address,
            chainId: TEST_CHAIN_ID,
            requestId: 'verify-existing',
            signature: verifyExistingRequest.signature,
            canonicalMessage: verifyExistingRequest.payload,
            receivedAtMs: BASE_TIME_MS,
            publishedAtMs: BASE_TIME_MS + 1,
            artifact: {
                version: 'test-artifact-v1',
                requestId: 'verify-existing',
            },
            cid: 'bafy-verify-existing-old',
            uri: 'ipfs://bafy-verify-existing-old',
            pinned: true,
            publishResult: {
                cid: 'bafy-verify-existing-old',
            },
            pinResult: {
                Pins: ['bafy-verify-existing-old'],
            },
            lastError: null,
            verification: null,
            submission: {
                status: 'not_started',
                submittedAtMs: null,
                transactionHash: null,
                ogProposalHash: null,
                result: null,
                error: null,
                sideEffectsLikelyCommitted: false,
            },
            createdAtMs: BASE_TIME_MS,
            updatedAtMs: BASE_TIME_MS,
        });
        let injectedVerifyExistingUpdate = false;
        const verifyExistingStore = {
            async getRecord(args) {
                return verifyExistingStoreBase.getRecord(args);
            },
            async prepareRecord(args) {
                return verifyExistingStoreBase.prepareRecord(args);
            },
            async saveRecord(record) {
                return verifyExistingStoreBase.saveRecord(record);
            },
            async listRecords() {
                return verifyExistingStoreBase.listRecords();
            },
            async updateRecord(recordOrKey, updater) {
                if (!injectedVerifyExistingUpdate) {
                    injectedVerifyExistingUpdate = true;
                    const current = await verifyExistingStoreBase.getRecord(recordOrKey);
                    await verifyExistingStoreBase.saveRecord({
                        ...current,
                        cid: 'bafy-verify-existing-new',
                        uri: 'ipfs://bafy-verify-existing-new',
                        publishResult: {
                            cid: 'bafy-verify-existing-new',
                        },
                        submission: {
                            status: 'resolved',
                            submittedAtMs: BASE_TIME_MS + 2,
                            transactionHash: `0x${'d'.repeat(64)}`,
                            ogProposalHash: `0x${'e'.repeat(64)}`,
                            result: {
                                transactionHash: `0x${'d'.repeat(64)}`,
                            },
                            error: null,
                            sideEffectsLikelyCommitted: true,
                        },
                    });
                }
                return verifyExistingStoreBase.updateRecord(recordOrKey, updater);
            },
        };
        const verifyExistingApi = createProposalPublicationApiServer({
            config: buildServerConfig(account.address),
            store: verifyExistingStore,
            logger: {
                info() {},
                warn() {},
            },
            verifyProposal: async ({ envelope }) => ({
                status: 'valid',
                verifiedAtMs: BASE_TIME_MS + 3,
                proposalKind: 'agent_proxy_reimbursement',
                rules: {
                    rulesHash: `0x${'b'.repeat(64)}`,
                    matchedTemplates: [],
                    unparsedSections: [],
                },
                checks: [
                    {
                        id: 'stubbed_verifier',
                        status: 'pass',
                        message: `Stub verifier accepted ${envelope.requestId}.`,
                    },
                ],
                derivedFacts: {
                    requestId: envelope.requestId,
                },
            }),
        });
        const verifyExistingServer = await verifyExistingApi.start();
        const verifyExistingAddress = verifyExistingServer.address();
        assert.ok(
            verifyExistingAddress &&
                typeof verifyExistingAddress === 'object' &&
                typeof verifyExistingAddress.port === 'number'
        );
        const verifyExistingBaseUrl = `http://127.0.0.1:${verifyExistingAddress.port}`;

        try {
            const verifyExistingResponse = await postVerification(verifyExistingBaseUrl, {
                ...verifyExistingRequest.body,
            });
            assert.equal(verifyExistingResponse.status, 200);
            assert.equal(verifyExistingResponse.json.status, 'valid');
            const verifyExistingRecord = await verifyExistingStoreBase.getRecord({
                signer: account.address,
                chainId: TEST_CHAIN_ID,
                requestId: 'verify-existing',
            });
            assert.equal(verifyExistingRecord.cid, 'bafy-verify-existing-new');
            assert.equal(verifyExistingRecord.uri, 'ipfs://bafy-verify-existing-new');
            assert.equal(verifyExistingRecord.submission.status, 'resolved');
            assert.equal(
                verifyExistingRecord.submission.transactionHash,
                `0x${'d'.repeat(64)}`
            );
            assert.equal(verifyExistingRecord.verification.status, 'valid');
            assert.equal(
                verifyExistingRecord.verification.derivedFacts.requestId,
                'verify-existing'
            );
        } finally {
            await verifyExistingApi.stop();
        }

        const proposeStateFile = path.join(tempDir, 'proposal-publications-propose.json');
        const proposeStore = createProposalPublicationStore({ stateFile: proposeStateFile });
        const submitAttemptsByExplanation = new Map();
        const verifyAttemptsByExplanation = new Map();
        const resolvedProposalHashes = new Map([
            [`0x${'3'.repeat(64)}`, `0x${'4'.repeat(64)}`],
        ]);
        const resolveProposalHashCalls = [];
        const proposalRuntimeAvailableByChain = new Map([
            [11155111, true],
            [137, true],
        ]);
        const verificationRuntimeAvailableByChain = new Map([
            [11155111, true],
            [137, true],
        ]);
        const proposeApi = createProposalPublicationApiServer({
            config: buildServerConfig(account.address, {
                chainId: undefined,
                proposalPublishApiMode: 'propose',
                proposalVerificationMode: 'enforce',
            }),
            store: proposeStore,
            logger: {
                info() {},
                warn() {},
            },
            resolveProposalRuntime: async ({ chainId }) => {
                if (proposalRuntimeAvailableByChain.get(chainId) === false) {
                    const error = new Error(`Proposal runtime unavailable for chainId ${chainId}.`);
                    error.code = 'proposal_runtime_unavailable';
                    error.statusCode = 502;
                    throw error;
                }
                if (chainId !== 11155111 && chainId !== 137) {
                    const error = new Error(`Unsupported chainId ${chainId}.`);
                    error.code = 'unsupported_chain';
                    error.statusCode = 400;
                    throw error;
                }
                return {
                    runtimeConfig: {
                        chainId,
                        proposeEnabled: true,
                        bondSpender: 'og',
                        proposalHashResolveTimeoutMs: 1,
                        proposalHashResolvePollIntervalMs: 1,
                    },
                    publicClient: {
                        async getChainId() {
                            return chainId;
                        },
                    },
                    walletClient: {},
                    account: { address: account.address },
                };
            },
            resolveVerificationRuntime: async ({ chainId }) => {
                if (verificationRuntimeAvailableByChain.get(chainId) === false) {
                    const error = new Error(
                        `Verification runtime unavailable for chainId ${chainId}.`
                    );
                    error.code = 'verification_runtime_unavailable';
                    error.statusCode = 502;
                    throw error;
                }
                return {
                    publicClient: {
                        async getChainId() {
                            return chainId;
                        },
                    },
                };
            },
            submitProposal: async ({ config, explanation }) => {
                submitAttemptsByExplanation.set(
                    explanation,
                    (submitAttemptsByExplanation.get(explanation) ?? 0) + 1
                );
                if (explanation === 'Retry after submission failure.') {
                    if (submitAttemptsByExplanation.get(explanation) === 1) {
                        throw new Error('submit unavailable');
                    }
                    return {
                        transactionHash: `0x${'5'.repeat(64)}`,
                        proposalHash: `0x${'6'.repeat(64)}`,
                        ogProposalHash: `0x${'6'.repeat(64)}`,
                        sideEffectsLikelyCommitted: true,
                    };
                }
                if (explanation === 'Resolve proposal hash on duplicate retry.') {
                    return {
                        transactionHash: `0x${'3'.repeat(64)}`,
                        proposalHash: `0x${'3'.repeat(64)}`,
                        ogProposalHash: null,
                        sideEffectsLikelyCommitted: true,
                    };
                }
                if (explanation === 'Duplicate while runtime unavailable.') {
                    return {
                        transactionHash: `0x${'9'.repeat(64)}`,
                        proposalHash: `0x${'9'.repeat(64)}`,
                        ogProposalHash: null,
                        sideEffectsLikelyCommitted: true,
                    };
                }
                if (explanation === 'Propose success on polygon.') {
                    assert.equal(config.chainId, 137);
                    return {
                        transactionHash: `0x${'7'.repeat(64)}`,
                        proposalHash: `0x${'8'.repeat(64)}`,
                        ogProposalHash: `0x${'8'.repeat(64)}`,
                        sideEffectsLikelyCommitted: true,
                    };
                }
                assert.equal(config.chainId, 11155111);
                return {
                    transactionHash: `0x${'1'.repeat(64)}`,
                    proposalHash: `0x${'2'.repeat(64)}`,
                    ogProposalHash: `0x${'2'.repeat(64)}`,
                    sideEffectsLikelyCommitted: true,
                };
            },
            resolveProposalHash: async ({ proposalTxHash }) => {
                resolveProposalHashCalls.push(proposalTxHash);
                return resolvedProposalHashes.get(proposalTxHash) ?? null;
            },
            verifyProposal: async ({ envelope }) => {
                verifyAttemptsByExplanation.set(
                    envelope.explanation,
                    (verifyAttemptsByExplanation.get(envelope.explanation) ?? 0) + 1
                );
                if (
                    envelope.explanation === 'Resolve proposal hash on duplicate retry.' &&
                    verifyAttemptsByExplanation.get(envelope.explanation) > 1
                ) {
                    throw new Error(
                        'Verification should not rerun for duplicate requests with an existing submission tx hash.'
                    );
                }
                if (envelope.explanation === 'Block submit via verification.') {
                    return {
                        status: 'invalid',
                        verifiedAtMs: 1_760_000_000_555,
                        proposalKind: 'agent_proxy_reimbursement',
                        rules: {
                            rulesHash: `0x${'c'.repeat(64)}`,
                            matchedTemplates: [],
                            unparsedSections: [],
                        },
                        checks: [
                            {
                                id: 'stubbed_verifier',
                                status: 'fail',
                                message: 'Stub verifier blocked the proposal.',
                            },
                        ],
                        derivedFacts: {},
                    };
                }
                return {
                    status: 'valid',
                    verifiedAtMs: 1_760_000_000_444,
                    proposalKind: 'agent_proxy_reimbursement',
                    rules: {
                        rulesHash: `0x${'d'.repeat(64)}`,
                        matchedTemplates: [],
                        unparsedSections: [],
                    },
                    checks: [
                        {
                            id: 'stubbed_verifier',
                            status: 'pass',
                            message: 'Stub verifier accepted the proposal.',
                        },
                    ],
                    derivedFacts: {},
                };
            },
        });
        const proposeServer = await proposeApi.start();
        const proposeAddress = proposeServer.address();
        assert.ok(
            proposeAddress &&
                typeof proposeAddress === 'object' &&
                typeof proposeAddress.port === 'number'
        );
        const proposeBaseUrl = `http://127.0.0.1:${proposeAddress.port}`;

        try {
            const proposeAcceptedRequest = await buildSignedBody({
                account,
                chainId: 11155111,
                requestId: 'propose-ok',
                explanation: 'Propose success on sepolia.',
            });
            const proposeAccepted = await postPublication(
                proposeBaseUrl,
                proposeAcceptedRequest.body
            );
            assert.equal(proposeAccepted.status, 202);
            assert.equal(proposeAccepted.json.status, 'published');
            assert.equal(proposeAccepted.json.mode, 'propose');
            assert.equal(proposeAccepted.json.submission.status, 'resolved');
            assert.equal(
                proposeAccepted.json.submission.transactionHash,
                `0x${'1'.repeat(64)}`
            );
            assert.equal(submitAttemptsByExplanation.get('Propose success on sepolia.'), 1);
            assert.equal(verifyAttemptsByExplanation.get('Propose success on sepolia.'), 1);

            verificationRuntimeAvailableByChain.set(11155111, false);
            const proposeDuplicate = await postPublication(
                proposeBaseUrl,
                proposeAcceptedRequest.body
            );
            assert.equal(proposeDuplicate.status, 200);
            assert.equal(proposeDuplicate.json.status, 'duplicate');
            assert.equal(proposeDuplicate.json.submission.status, 'resolved');
            assert.equal(submitAttemptsByExplanation.get('Propose success on sepolia.'), 1);
            assert.equal(verifyAttemptsByExplanation.get('Propose success on sepolia.'), 1);
            verificationRuntimeAvailableByChain.set(11155111, true);

            const retryFailureRequest = await buildSignedBody({
                account,
                chainId: 11155111,
                requestId: 'submit-retry',
                explanation: 'Retry after submission failure.',
            });
            const retryFailureFirst = await postPublication(
                proposeBaseUrl,
                retryFailureRequest.body
            );
            assert.equal(retryFailureFirst.status, 502);
            assert.equal(retryFailureFirst.json.code, 'submission_failed');
            assert.ok(retryFailureFirst.json.cid);
            assert.equal(retryFailureFirst.json.submission.status, 'failed');
            assert.equal(addAttemptsByRequestId.get('submit-retry'), 1);

            const retryFailureSecond = await postPublication(
                proposeBaseUrl,
                retryFailureRequest.body
            );
            assert.equal(retryFailureSecond.status, 202);
            assert.equal(retryFailureSecond.json.status, 'published');
            assert.equal(retryFailureSecond.json.cid, retryFailureFirst.json.cid);
            assert.equal(retryFailureSecond.json.submission.status, 'resolved');
            assert.equal(
                retryFailureSecond.json.submission.transactionHash,
                `0x${'5'.repeat(64)}`
            );
            assert.equal(addAttemptsByRequestId.get('submit-retry'), 1);
            assert.equal(submitAttemptsByExplanation.get('Retry after submission failure.'), 2);

            const pendingSubmissionRequest = await buildSignedBody({
                account,
                chainId: 11155111,
                requestId: 'submit-pending',
                explanation: 'Resolve proposal hash on duplicate retry.',
            });
            const pendingSubmissionFirst = await postPublication(
                proposeBaseUrl,
                pendingSubmissionRequest.body
            );
            assert.equal(pendingSubmissionFirst.status, 202);
            assert.equal(pendingSubmissionFirst.json.submission.status, 'submitted');
            assert.equal(
                pendingSubmissionFirst.json.submission.transactionHash,
                `0x${'3'.repeat(64)}`
            );

            const pendingSubmissionSecond = await postPublication(
                proposeBaseUrl,
                pendingSubmissionRequest.body
            );
            assert.equal(pendingSubmissionSecond.status, 200);
            assert.equal(pendingSubmissionSecond.json.status, 'duplicate');
            assert.equal(pendingSubmissionSecond.json.submission.status, 'resolved');
            assert.equal(
                pendingSubmissionSecond.json.submission.ogProposalHash,
                `0x${'4'.repeat(64)}`
            );
            assert.equal(
                submitAttemptsByExplanation.get('Resolve proposal hash on duplicate retry.'),
                1
            );
            assert.equal(
                verifyAttemptsByExplanation.get('Resolve proposal hash on duplicate retry.'),
                1
            );
            assert.deepEqual(resolveProposalHashCalls, [`0x${'3'.repeat(64)}`]);

            const runtimeOutageDuplicateRequest = await buildSignedBody({
                account,
                chainId: 11155111,
                requestId: 'submit-pending-runtime-outage',
                explanation: 'Duplicate while runtime unavailable.',
            });
            const runtimeOutageFirst = await postPublication(
                proposeBaseUrl,
                runtimeOutageDuplicateRequest.body
            );
            assert.equal(runtimeOutageFirst.status, 202);
            assert.equal(runtimeOutageFirst.json.submission.status, 'submitted');
            proposalRuntimeAvailableByChain.set(11155111, false);
            const runtimeOutageDuplicate = await postPublication(
                proposeBaseUrl,
                runtimeOutageDuplicateRequest.body
            );
            assert.equal(runtimeOutageDuplicate.status, 200);
            assert.equal(runtimeOutageDuplicate.json.status, 'duplicate');
            assert.equal(runtimeOutageDuplicate.json.submission.status, 'submitted');
            assert.equal(
                submitAttemptsByExplanation.get('Duplicate while runtime unavailable.'),
                1
            );
            assert.equal(
                verifyAttemptsByExplanation.get('Duplicate while runtime unavailable.'),
                1
            );

            const expiredWhileRuntimeDownRequest = await buildSignedBody({
                account,
                chainId: 11155111,
                requestId: 'expired-while-runtime-down',
                explanation: 'Expired request should not resolve runtime.',
                timestampMs: Date.now() - 600_000,
            });
            const expiredWhileRuntimeDown = await postPublication(
                proposeBaseUrl,
                expiredWhileRuntimeDownRequest.body
            );
            assert.equal(expiredWhileRuntimeDown.status, 401);
            assert.match(
                expiredWhileRuntimeDown.json.error,
                /Signed request expired or has an invalid timestamp/
            );

            const conflictingWhileRuntimeDownRequest = await buildSignedBody({
                account,
                chainId: 11155111,
                requestId: 'propose-ok',
                explanation: 'Conflict should beat runtime outage.',
            });
            const conflictingWhileRuntimeDown = await postPublication(
                proposeBaseUrl,
                conflictingWhileRuntimeDownRequest.body
            );
            assert.equal(conflictingWhileRuntimeDown.status, 409);
            assert.equal(conflictingWhileRuntimeDown.json.code, 'request_conflict');
            proposalRuntimeAvailableByChain.set(11155111, true);

            const blockedByVerificationRequest = await buildSignedBody({
                account,
                chainId: 11155111,
                requestId: 'blocked-by-verification',
                explanation: 'Block submit via verification.',
            });
            const blockedByVerification = await postPublication(
                proposeBaseUrl,
                blockedByVerificationRequest.body
            );
            assert.equal(blockedByVerification.status, 409);
            assert.equal(blockedByVerification.json.code, 'verification_invalid');
            assert.equal(blockedByVerification.json.verification.status, 'invalid');
            assert.equal(
                submitAttemptsByExplanation.get('Block submit via verification.') ?? 0,
                0
            );

            const polygonRequest = await buildSignedBody({
                account,
                chainId: 137,
                requestId: 'polygon-propose',
                explanation: 'Propose success on polygon.',
            });
            const polygonAccepted = await postPublication(proposeBaseUrl, polygonRequest.body);
            assert.equal(polygonAccepted.status, 202);
            assert.equal(polygonAccepted.json.submission.status, 'resolved');
            assert.equal(
                polygonAccepted.json.submission.transactionHash,
                `0x${'7'.repeat(64)}`
            );

            const unsupportedChainRequest = await buildSignedBody({
                account,
                chainId: 10,
                requestId: 'unsupported-chain',
                explanation: 'Unsupported chain request.',
            });
            const unsupportedChainResponse = await postPublication(
                proposeBaseUrl,
                unsupportedChainRequest.body
            );
            assert.equal(unsupportedChainResponse.status, 400);
            assert.equal(unsupportedChainResponse.json.code, 'unsupported_chain');
            assert.equal(addAttemptsByRequestId.get('unsupported-chain') ?? 0, 0);
        } finally {
            await proposeApi.stop();
        }

        const proposeNoHistoryStateFile = path.join(
            tempDir,
            'proposal-publications-propose-no-history.json'
        );
        const proposeNoHistoryStoreBase = createProposalPublicationStore({
            stateFile: proposeNoHistoryStateFile,
        });
        const proposeNoHistoryStore = {
            async getRecord(args) {
                return proposeNoHistoryStoreBase.getRecord(args);
            },
            async prepareRecord(args) {
                return proposeNoHistoryStoreBase.prepareRecord(args);
            },
            async saveRecord(record) {
                return proposeNoHistoryStoreBase.saveRecord(record);
            },
            async updateRecord(recordOrKey, updater) {
                return proposeNoHistoryStoreBase.updateRecord(recordOrKey, updater);
            },
        };
        let proposeNoHistorySubmitCalls = 0;
        let proposeNoHistoryVerifyCalls = 0;
        const proposeNoHistoryApi = createProposalPublicationApiServer({
            config: buildServerConfig(account.address, {
                chainId: undefined,
                proposalPublishApiMode: 'propose',
                proposalVerificationMode: 'enforce',
            }),
            store: proposeNoHistoryStore,
            logger: {
                info() {},
                warn() {},
            },
            resolveProposalRuntime: async ({ chainId }) => ({
                runtimeConfig: {
                    chainId,
                    proposeEnabled: true,
                    bondSpender: 'og',
                    proposalHashResolveTimeoutMs: 1,
                    proposalHashResolvePollIntervalMs: 1,
                },
                publicClient: {
                    async getChainId() {
                        return chainId;
                    },
                },
                walletClient: {},
                account: { address: account.address },
            }),
            verifyProposal: async () => {
                proposeNoHistoryVerifyCalls += 1;
                return {
                    status: 'valid',
                    verifiedAtMs: BASE_TIME_MS + 4,
                    proposalKind: 'agent_proxy_reimbursement',
                    rules: {
                        rulesHash: `0x${'b'.repeat(64)}`,
                        matchedTemplates: [],
                        unparsedSections: [],
                    },
                    checks: [],
                    derivedFacts: {},
                };
            },
            submitProposal: async () => {
                proposeNoHistorySubmitCalls += 1;
                return {
                    transactionHash: `0x${'c'.repeat(64)}`,
                    proposalHash: `0x${'d'.repeat(64)}`,
                    ogProposalHash: `0x${'d'.repeat(64)}`,
                    sideEffectsLikelyCommitted: true,
                };
            },
        });
        const proposeNoHistoryServer = await proposeNoHistoryApi.start();
        const proposeNoHistoryAddress = proposeNoHistoryServer.address();
        assert.ok(
            proposeNoHistoryAddress &&
                typeof proposeNoHistoryAddress === 'object' &&
                typeof proposeNoHistoryAddress.port === 'number'
        );
        const proposeNoHistoryBaseUrl = `http://127.0.0.1:${proposeNoHistoryAddress.port}`;

        try {
            const proposeNoHistoryRequest = await buildSignedBody({
                account,
                chainId: 11155111,
                requestId: 'propose-no-history',
                explanation: 'Enforce mode should fail closed without record enumeration.',
            });
            const proposeNoHistoryResponse = await postPublication(
                proposeNoHistoryBaseUrl,
                proposeNoHistoryRequest.body
            );
            assert.equal(proposeNoHistoryResponse.status, 503);
            assert.equal(
                proposeNoHistoryResponse.json.code,
                'verification_history_unavailable'
            );
            assert.equal(proposeNoHistoryResponse.json.submission.status, 'not_started');
            assert.equal(proposeNoHistoryResponse.json.verification, null);
            assert.equal(proposeNoHistoryVerifyCalls, 0);
            assert.equal(proposeNoHistorySubmitCalls, 0);
        } finally {
            await proposeNoHistoryApi.stop();
        }

        const advisoryStateFile = path.join(tempDir, 'proposal-publications-propose-advisory.json');
        const advisoryStore = createProposalPublicationStore({ stateFile: advisoryStateFile });
        const advisorySubmitAttemptsByExplanation = new Map();
        const advisoryApi = createProposalPublicationApiServer({
            config: buildServerConfig(account.address, {
                chainId: undefined,
                proposalPublishApiMode: 'propose',
                proposalVerificationMode: 'advisory',
            }),
            store: advisoryStore,
            logger: {
                info() {},
                warn() {},
            },
            resolveProposalRuntime: async ({ chainId }) => {
                assert.equal(chainId, 11155111);
                return {
                    runtimeConfig: {
                        chainId,
                        proposeEnabled: true,
                        bondSpender: 'og',
                        proposalHashResolveTimeoutMs: 1,
                        proposalHashResolvePollIntervalMs: 1,
                    },
                    publicClient: {
                        async getChainId() {
                            return chainId;
                        },
                    },
                    walletClient: {},
                    account: { address: account.address },
                };
            },
            submitProposal: async ({ explanation }) => {
                advisorySubmitAttemptsByExplanation.set(
                    explanation,
                    (advisorySubmitAttemptsByExplanation.get(explanation) ?? 0) + 1
                );
                return {
                    transactionHash: `0x${'e'.repeat(64)}`,
                    proposalHash: `0x${'f'.repeat(64)}`,
                    ogProposalHash: `0x${'f'.repeat(64)}`,
                    sideEffectsLikelyCommitted: true,
                };
            },
            verifyProposal: async () => {
                const error = new Error(
                    'Verification runtime unavailable for chainId 11155111.'
                );
                error.code = 'verification_runtime_unavailable';
                error.statusCode = 502;
                throw error;
            },
        });
        const advisoryServer = await advisoryApi.start();
        const advisoryAddress = advisoryServer.address();
        assert.ok(
            advisoryAddress &&
                typeof advisoryAddress === 'object' &&
                typeof advisoryAddress.port === 'number'
        );
        const advisoryBaseUrl = `http://127.0.0.1:${advisoryAddress.port}`;

        try {
            const advisoryRequest = await buildSignedBody({
                account,
                chainId: 11155111,
                requestId: 'advisory-runtime-outage',
                explanation: 'Advisory submit despite verification outage.',
            });
            const advisoryResponse = await postPublication(advisoryBaseUrl, advisoryRequest.body);
            assert.equal(advisoryResponse.status, 202);
            assert.equal(advisoryResponse.json.status, 'published');
            assert.equal(advisoryResponse.json.submission.status, 'resolved');
            assert.equal(advisoryResponse.json.verification.status, 'unknown');
            assert.equal(advisoryResponse.json.verification.checks[0]?.id, 'verification_runtime');
            assert.equal(
                advisoryResponse.json.verification.checks[0]?.code,
                'verification_runtime_unavailable'
            );
            assert.match(
                advisoryResponse.json.verification.checks[0]?.message ?? '',
                /advisory mode/i
            );
            assert.equal(
                advisorySubmitAttemptsByExplanation.get(
                    'Advisory submit despite verification outage.'
                ),
                1
            );
            const advisoryRecord = await advisoryStore.getRecord({
                signer: account.address,
                chainId: 11155111,
                requestId: 'advisory-runtime-outage',
            });
            assert.equal(advisoryRecord?.verification?.status, 'unknown');
            assert.equal(
                advisoryRecord?.verification?.checks?.[0]?.id,
                'verification_runtime'
            );
        } finally {
            await advisoryApi.stop();
        }

        const uncertainPersistStateFile = path.join(
            tempDir,
            'proposal-publications-propose-uncertain.json'
        );
        const uncertainPersistStoreBase = createProposalPublicationStore({
            stateFile: uncertainPersistStateFile,
        });
        const observedTxHash = `0x${'a'.repeat(64)}`;
        let observedTxPersistFailures = 0;
        let uncertainSubmitAttempts = 0;
        const uncertainPersistStore = {
            async getRecord(args) {
                return uncertainPersistStoreBase.getRecord(args);
            },
            async prepareRecord(args) {
                return uncertainPersistStoreBase.prepareRecord(args);
            },
            async updateRecord(recordOrKey, updater) {
                return uncertainPersistStoreBase.updateRecord(recordOrKey, async (current) => {
                    const nextRecord = await updater(current);
                    if (
                        nextRecord.submission?.transactionHash === observedTxHash &&
                        observedTxPersistFailures === 0
                    ) {
                        observedTxPersistFailures += 1;
                        throw new Error('simulated submission store write failure');
                    }
                    return nextRecord;
                });
            },
            async saveRecord(record) {
                if (
                    record.submission?.transactionHash === observedTxHash &&
                    observedTxPersistFailures === 0
                ) {
                    observedTxPersistFailures += 1;
                    throw new Error('simulated submission store write failure');
                }
                return uncertainPersistStoreBase.saveRecord(record);
            },
        };
        const uncertainPersistApi = createProposalPublicationApiServer({
            config: buildServerConfig(account.address, {
                chainId: undefined,
                proposalPublishApiMode: 'propose',
            }),
            store: uncertainPersistStore,
            logger: {
                info() {},
                warn() {},
            },
            resolveProposalRuntime: async ({ chainId }) => ({
                runtimeConfig: {
                    chainId,
                    proposeEnabled: true,
                    bondSpender: 'og',
                    proposalHashResolveTimeoutMs: 1,
                    proposalHashResolvePollIntervalMs: 1,
                },
                publicClient: {
                    async getChainId() {
                        return chainId;
                    },
                },
                walletClient: {},
                account: { address: account.address },
            }),
            submitProposal: async ({ explanation }) => {
                uncertainSubmitAttempts += 1;
                assert.equal(explanation, 'Observed tx before store failure.');
                return {
                    transactionHash: observedTxHash,
                    proposalHash: observedTxHash,
                    ogProposalHash: null,
                    sideEffectsLikelyCommitted: true,
                };
            },
            resolveProposalHash: async () => null,
        });
        const uncertainPersistServer = await uncertainPersistApi.start();
        const uncertainPersistAddress = uncertainPersistServer.address();
        assert.ok(
            uncertainPersistAddress &&
                typeof uncertainPersistAddress === 'object' &&
                typeof uncertainPersistAddress.port === 'number'
        );
        const uncertainPersistBaseUrl = `http://127.0.0.1:${uncertainPersistAddress.port}`;

        try {
            const uncertainPersistRequest = await buildSignedBody({
                account,
                chainId: 11155111,
                requestId: 'submit-observed-tx-store-failure',
                explanation: 'Observed tx before store failure.',
            });
            const uncertainPersistFirst = await postPublication(
                uncertainPersistBaseUrl,
                uncertainPersistRequest.body
            );
            assert.equal(uncertainPersistFirst.status, 409);
            assert.equal(uncertainPersistFirst.json.code, 'submission_uncertain');
            assert.equal(uncertainPersistFirst.json.submission.status, 'uncertain');
            assert.equal(
                uncertainPersistFirst.json.submission.transactionHash,
                observedTxHash
            );
            assert.equal(uncertainSubmitAttempts, 1);

            const uncertainPersistRecord = await uncertainPersistStoreBase.getRecord({
                signer: account.address,
                chainId: 11155111,
                requestId: 'submit-observed-tx-store-failure',
            });
            assert.equal(uncertainPersistRecord.submission.status, 'uncertain');
            assert.equal(uncertainPersistRecord.submission.transactionHash, observedTxHash);

            const uncertainPersistSecond = await postPublication(
                uncertainPersistBaseUrl,
                uncertainPersistRequest.body
            );
            assert.equal(uncertainPersistSecond.status, 409);
            assert.equal(uncertainPersistSecond.json.code, 'submission_uncertain');
            assert.equal(uncertainPersistSecond.json.submission.status, 'uncertain');
            assert.equal(uncertainSubmitAttempts, 1);
        } finally {
            await uncertainPersistApi.stop();
        }

        const reconcileFailureStateFile = path.join(
            tempDir,
            'proposal-publications-propose-reconcile-failure.json'
        );
        const reconcileFailureStore = createProposalPublicationStore({
            stateFile: reconcileFailureStateFile,
        });
        let reconcileFailureSubmitAttempts = 0;
        const reconcileFailureTxHash = `0x${'b'.repeat(64)}`;
        const reconcileFailureApi = createProposalPublicationApiServer({
            config: buildServerConfig(account.address, {
                chainId: undefined,
                proposalPublishApiMode: 'propose',
            }),
            store: reconcileFailureStore,
            logger: {
                info() {},
                warn() {},
            },
            resolveProposalRuntime: async ({ chainId }) => ({
                runtimeConfig: {
                    chainId,
                    proposeEnabled: true,
                    bondSpender: 'og',
                    proposalHashResolveTimeoutMs: 1,
                    proposalHashResolvePollIntervalMs: 1,
                },
                publicClient: {
                    async getChainId() {
                        return chainId;
                    },
                },
                walletClient: {},
                account: { address: account.address },
            }),
            submitProposal: async ({ explanation, onProposalTxSubmitted }) => {
                reconcileFailureSubmitAttempts += 1;
                assert.equal(
                    explanation,
                    'Known transaction hash should survive reconcile failure.'
                );
                await onProposalTxSubmitted(reconcileFailureTxHash);
                throw new Error('submit completed but post-submit handling failed');
            },
            resolveProposalHash: async () => {
                throw new Error('temporary receipt lookup failure');
            },
        });
        const reconcileFailureServer = await reconcileFailureApi.start();
        const reconcileFailureAddress = reconcileFailureServer.address();
        assert.ok(
            reconcileFailureAddress &&
                typeof reconcileFailureAddress === 'object' &&
                typeof reconcileFailureAddress.port === 'number'
        );
        const reconcileFailureBaseUrl = `http://127.0.0.1:${reconcileFailureAddress.port}`;

        try {
            const reconcileFailureRequest = await buildSignedBody({
                account,
                chainId: 11155111,
                requestId: 'known-tx-reconcile-failure',
                explanation: 'Known transaction hash should survive reconcile failure.',
            });
            const reconcileFailureResponse = await postPublication(
                reconcileFailureBaseUrl,
                reconcileFailureRequest.body
            );
            assert.equal(reconcileFailureResponse.status, 202);
            assert.equal(reconcileFailureResponse.json.status, 'published');
            assert.equal(reconcileFailureResponse.json.submission.status, 'submitted');
            assert.equal(
                reconcileFailureResponse.json.submission.transactionHash,
                reconcileFailureTxHash
            );
            assert.equal(reconcileFailureSubmitAttempts, 1);
        } finally {
            await reconcileFailureApi.stop();
        }
    } finally {
        Date.now = originalDateNow;
        globalThis.fetch = originalFetch;
        await api.stop();
        await rm(tempDir, { recursive: true, force: true });
    }

    console.log('[test] proposal publication API OK');
}

main().catch((error) => {
    console.error('[test] proposal publication API failed:', error?.stack ?? error?.message ?? error);
    process.exit(1);
});
