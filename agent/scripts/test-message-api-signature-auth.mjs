import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { createMessageInbox } from '../src/lib/message-inbox.js';
import { createMessageApiServer } from '../src/lib/message-api.js';
import { buildSignedMessagePayload } from '../src/lib/message-signing.js';

function buildInbox() {
    return createMessageInbox({
        queueLimit: 10,
        defaultTtlSeconds: 60,
        minTtlSeconds: 1,
        maxTtlSeconds: 600,
        idempotencyTtlSeconds: 60,
        maxTextLength: 200,
        rateLimitPerMinute: 20,
        rateLimitBurst: 5,
    });
}

async function main() {
    const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
    const otherAccount = privateKeyToAccount(`0x${'2'.repeat(64)}`);
    const inbox = buildInbox();
    const config = {
        chainId: 11155111,
        messageApiHost: '127.0.0.1',
        messageApiPort: 0,
        messageApiKeys: {},
        messageApiSignerAllowlist: [account.address],
        messageApiRequireSignerAllowlist: true,
        messageApiSignatureMaxAgeSeconds: 300,
        messageApiMaxBodyBytes: 2048,
    };

    const messageApi = createMessageApiServer({
        config,
        inbox,
        logger: { log() {} },
    });
    const server = await messageApi.start();
    const address = server.address();
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        const timestampMs = Date.now();
        const signedBody = {
            chainId: 11155111,
            text: 'Pause proposals for 2 hours',
            command: 'pause_proposals',
            args: { hours: 2 },
            metadata: { source: 'ops' },
            requestId: 'sig-pause-2h',
            deadline: timestampMs + 60_000,
        };
        const payload = buildSignedMessagePayload({
            address: account.address,
            timestampMs,
            ...signedBody,
        });
        const signature = await account.signMessage({ message: payload });

        const accepted = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...signedBody,
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs,
                    signature,
                },
            }),
        });
        assert.equal(accepted.status, 202);
        const acceptedJson = await accepted.json();
        assert.equal(acceptedJson.status, 'queued');
        assert.ok(acceptedJson.messageId);

        const queued = inbox.takeBatch({ maxItems: 1 });
        assert.equal(queued.length, 1);
        assert.equal(queued[0].sender.authType, 'eip191');
        assert.equal(queued[0].sender.address, account.address);
        assert.equal(queued[0].sender.signedAtMs, timestampMs);
        assert.equal(queued[0].sender.signature, signature);
        assert.equal(queued[0].requestId, signedBody.requestId);
        assert.equal(queued[0].deadline, signedBody.deadline);
        assert.equal(queued[0].chainId, 11155111);
        inbox.ackBatch(queued.map((message) => message.messageId));

        const missingChainIdTimestampMs = Date.now();
        const missingChainIdBody = {
            text: 'Missing chain id',
            requestId: 'sig-missing-chain-id',
        };
        const missingChainIdPayload = buildSignedMessagePayload({
            address: account.address,
            timestampMs: missingChainIdTimestampMs,
            ...missingChainIdBody,
        });
        const missingChainIdSignature = await account.signMessage({
            message: missingChainIdPayload,
        });
        const missingChainId = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...missingChainIdBody,
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs: missingChainIdTimestampMs,
                    signature: missingChainIdSignature,
                },
            }),
        });
        assert.equal(missingChainId.status, 202);
        const queuedMissingChainId = inbox.takeBatch({ maxItems: 1 });
        assert.equal(queuedMissingChainId.length, 1);
        assert.equal(queuedMissingChainId[0].requestId, missingChainIdBody.requestId);
        assert.equal(queuedMissingChainId[0].chainId, undefined);
        inbox.ackBatch(queuedMissingChainId.map((message) => message.messageId));

        const wrongChainIdTimestampMs = Date.now();
        const wrongChainIdBody = {
            text: 'Wrong chain id',
            requestId: 'sig-wrong-chain-id',
        };
        const wrongChainIdPayload = buildSignedMessagePayload({
            address: account.address,
            timestampMs: wrongChainIdTimestampMs,
            ...wrongChainIdBody,
        });
        const wrongChainIdSignature = await account.signMessage({
            message: wrongChainIdPayload,
        });
        const wrongChainId = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...wrongChainIdBody,
                chainId: 1,
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs: wrongChainIdTimestampMs,
                    signature: wrongChainIdSignature,
                },
            }),
        });
        assert.equal(wrongChainId.status, 400);

        // Signed request IDs remain replay-locked beyond message expiry.
        const shortTtlTimestampMs = Date.now();
        const shortTtlBody = {
            chainId: 11155111,
            text: 'Short TTL signed command',
            requestId: 'sig-short-ttl',
            deadline: shortTtlTimestampMs + 2_000,
        };
        const shortTtlPayload = buildSignedMessagePayload({
            address: account.address,
            timestampMs: shortTtlTimestampMs,
            ...shortTtlBody,
        });
        const shortTtlSignature = await account.signMessage({ message: shortTtlPayload });
        const shortTtlAccepted = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...shortTtlBody,
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs: shortTtlTimestampMs,
                    signature: shortTtlSignature,
                },
            }),
        });
        assert.equal(shortTtlAccepted.status, 202);
        await new Promise((resolve) => setTimeout(resolve, 2_100));

        const shortTtlReplay = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...shortTtlBody,
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs: shortTtlTimestampMs,
                    signature: shortTtlSignature,
                },
            }),
        });
        assert.equal(shortTtlReplay.status, 409);
        const shortTtlReplayJson = await shortTtlReplay.json();
        assert.equal(shortTtlReplayJson.code, 'request_replay_blocked');

        // Tampered request body with old signature must fail authentication.
        const tampered = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...signedBody,
                text: 'tampered text',
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs,
                    signature,
                },
            }),
        });
        assert.equal(tampered.status, 401);

        // Signed auth requires a requestId to harden replay behavior.
        const missingRequestId = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: signedBody.text,
                command: signedBody.command,
                args: signedBody.args,
                metadata: signedBody.metadata,
                deadline: signedBody.deadline,
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs,
                    signature,
                },
            }),
        });
        assert.equal(missingRequestId.status, 400);

        // Expired signatures should be rejected.
        const expiredTimestampMs = timestampMs - 10 * 60 * 1000;
        const expiredPayload = buildSignedMessagePayload({
            address: account.address,
            timestampMs: expiredTimestampMs,
            ...signedBody,
        });
        const expiredSignature = await account.signMessage({ message: expiredPayload });
        const expired = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...signedBody,
                requestId: 'sig-pause-2h-expired',
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs: expiredTimestampMs,
                    signature: expiredSignature,
                },
            }),
        });
        assert.equal(expired.status, 401);

        // Unknown signers should still be rejected when allowlist mode is enabled.
        const otherTimestampMs = Date.now();
        const otherRequestBody = {
            chainId: 11155111,
            text: 'Open a trade',
            requestId: 'sig-other-signer',
        };
        const otherPayload = buildSignedMessagePayload({
            address: otherAccount.address,
            timestampMs: otherTimestampMs,
            ...otherRequestBody,
        });
        const otherSignature = await otherAccount.signMessage({ message: otherPayload });
        const rejectedOtherSigner = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...otherRequestBody,
                auth: {
                    type: 'eip191',
                    address: otherAccount.address,
                    timestampMs: otherTimestampMs,
                    signature: otherSignature,
                },
            }),
        });
        assert.equal(rejectedOtherSigner.status, 401);
    } finally {
        await messageApi.stop();
    }

    const openInbox = buildInbox();
    const openConfig = {
        chainId: 11155111,
        messageApiHost: '127.0.0.1',
        messageApiPort: 0,
        messageApiKeys: {},
        messageApiSignerAllowlist: [account.address],
        messageApiRequireSignerAllowlist: false,
        messageApiSignatureMaxAgeSeconds: 300,
        messageApiMaxBodyBytes: 2048,
    };
    const openMessageApi = createMessageApiServer({
        config: openConfig,
        inbox: openInbox,
        logger: { log() {} },
    });
    const openServer = await openMessageApi.start();
    const openAddress = openServer.address();
    assert.ok(openAddress && typeof openAddress === 'object' && typeof openAddress.port === 'number');
    const openBaseUrl = `http://127.0.0.1:${openAddress.port}`;

    try {
        const timestampMs = Date.now();
        const openBody = {
            chainId: 11155111,
            text: 'Open a YES trade with 5 USDC',
            requestId: 'sig-open-mode',
        };
        const payload = buildSignedMessagePayload({
            address: otherAccount.address,
            timestampMs,
            ...openBody,
        });
        const signature = await otherAccount.signMessage({ message: payload });

        const accepted = await fetch(`${openBaseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...openBody,
                auth: {
                    type: 'eip191',
                    address: otherAccount.address,
                    timestampMs,
                    signature,
                },
            }),
        });
        assert.equal(accepted.status, 202);
        const acceptedJson = await accepted.json();
        assert.equal(acceptedJson.status, 'queued');

        const queued = openInbox.takeBatch({ maxItems: 1 });
        assert.equal(queued.length, 1);
        assert.equal(queued[0].sender.address, otherAccount.address);
        openInbox.ackBatch(queued.map((message) => message.messageId));
    } finally {
        await openMessageApi.stop();
    }

    console.log('[test] message API signature auth OK');
}

main().catch((error) => {
    console.error('[test] message API signature auth failed:', error?.message ?? error);
    process.exit(1);
});
