import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { createProposalPublicationApiServer } from '../../../agent/src/lib/proposal-publication-api.js';
import { createProposalPublicationStore } from '../../../agent/src/lib/proposal-publication-store.js';
import {
    buildSignedProposalPayload,
    verifySignedProposalArtifact,
} from '../../../agent/src/lib/signed-proposal.js';
import { resolveProposalPublishServerConfig } from '../../../agent/scripts/lib/proposal-publish-runtime.mjs';

function getHarnessDefinition() {
    return {
        scenario: 'signed-proposal-publish-smoke',
        description:
            'Starts the standalone proposal publication node, submits one signed proposal publication request, and verifies the archived artifact.',
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

async function runSmokeScenario() {
    const repoRootPath = path.resolve(new URL('../../..', import.meta.url).pathname);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'signed-proposal-publish-smoke-'));
    const overlayPath = path.join(tempDir, 'overlay.json');
    const stateFile = path.join(tempDir, 'proposal-publications.json');
    const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
    const requestId = 'smoke-proposal-publication';

    await writeFile(
        overlayPath,
        JSON.stringify(
            {
                proposalPublishApi: {
                    requireSignerAllowlist: true,
                    signerAllowlist: [account.address],
                    stateFile,
                },
                ipfsApiUrl: 'http://ipfs.mock',
            },
            null,
            2
        ),
        'utf8'
    );

    const { runtimeConfig } = await resolveProposalPublishServerConfig({
        argv: [
            'node',
            'start-proposal-publish-node.mjs',
            '--module=signed-proposal-publish-smoke',
            `--overlay=${overlayPath}`,
        ],
        env: {},
        repoRootPath,
    });
    runtimeConfig.proposalPublishApiPort = 0;

    const store = createProposalPublicationStore({ stateFile });
    const artifactByCid = new Map();
    const requestIdByCid = new Map();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        const urlString = String(url);
        if (!urlString.startsWith('http://ipfs.mock')) {
            return originalFetch(url, options);
        }

        if (urlString.includes('/api/v0/add')) {
            const uploaded = options.body.get('file');
            const uploadedText = await uploaded.text();
            const artifact = JSON.parse(uploadedText);
            const cid = `bafy${createHash('sha256').update(uploadedText).digest('hex').slice(0, 24)}`;
            artifactByCid.set(cid, artifact);
            requestIdByCid.set(cid, artifact?.signedProposal?.envelope?.requestId ?? null);
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
            const parsed = new URL(urlString);
            const cid = parsed.searchParams.get('arg');
            return textResponse(200, JSON.stringify({ Pins: [cid], requestId: requestIdByCid.get(cid) }));
        }
        throw new Error(`Unexpected mock IPFS request: ${urlString}`);
    };

    const api = createProposalPublicationApiServer({
        config: runtimeConfig,
        store,
        logger: { log() {}, warn() {} },
    });
    const server = await api.start();
    const address = server.address();
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        const timestampMs = Date.now();
        const explanation = 'Smoke-test proposal publication explanation.';
        const transactions = [
            {
                to: '0x4444444444444444444444444444444444444444',
                value: '0',
                data: '0x1234',
                operation: 0,
            },
        ];
        const payload = buildSignedProposalPayload({
            address: account.address,
            chainId: runtimeConfig.chainId,
            timestampMs,
            requestId,
            commitmentSafe: '0x2222222222222222222222222222222222222222',
            ogModule: '0x3333333333333333333333333333333333333333',
            transactions,
            explanation,
            metadata: {
                module: 'signed-proposal-publish-smoke',
            },
        });
        const signature = await account.signMessage({ message: payload });
        const response = await fetch(`${baseUrl}/v1/proposals/publish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chainId: runtimeConfig.chainId,
                requestId,
                commitmentSafe: '0x2222222222222222222222222222222222222222',
                ogModule: '0x3333333333333333333333333333333333333333',
                transactions,
                explanation,
                metadata: {
                    module: 'signed-proposal-publish-smoke',
                },
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs,
                    signature,
                },
            }),
        });
        assert.equal(response.status, 202);
        const responseJson = await response.json();
        assert.equal(responseJson.status, 'published');
        assert.equal(responseJson.pinned, true);
        assert.ok(responseJson.cid);

        const artifact = artifactByCid.get(responseJson.cid);
        assert.ok(artifact, 'Expected archived artifact to be captured by mock IPFS.');
        const verification = await verifySignedProposalArtifact(artifact);
        assert.equal(verification.ok, true);
        assert.equal(verification.requestId, requestId);
        assert.equal(verification.signer, account.address.toLowerCase());

        return {
            scenario: 'signed-proposal-publish-smoke',
            signer: account.address,
            requestId,
            cid: responseJson.cid,
            uri: responseJson.uri,
            publishedAtMs: responseJson.publishedAtMs,
        };
    } finally {
        globalThis.fetch = originalFetch;
        await api.stop();
        await rm(tempDir, { recursive: true, force: true });
    }
}

export { getHarnessDefinition, runSmokeScenario };
