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
    const inbox = buildInbox();
    const config = {
        messageApiHost: '127.0.0.1',
        messageApiPort: 0,
        messageApiKeys: {},
        messageApiSignerAllowlist: [account.address],
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
            text: 'Pause proposals for 2 hours',
            command: 'pause_proposals',
            args: { hours: 2 },
            metadata: { source: 'ops' },
            idempotencyKey: 'sig-pause-2h',
            ttlSeconds: 60,
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
        inbox.ackBatch(queued.map((message) => message.messageId));

        // Signed idempotency keys remain replay-locked beyond message TTL.
        const shortTtlTimestampMs = Date.now();
        const shortTtlBody = {
            text: 'Short TTL signed command',
            idempotencyKey: 'sig-short-ttl',
            ttlSeconds: 1,
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
        await new Promise((resolve) => setTimeout(resolve, 1_100));

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
        assert.equal(shortTtlReplayJson.code, 'idempotency_replay_blocked');

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

        // Signed auth requires an idempotency key to harden replay behavior.
        const missingIdempotency = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: signedBody.text,
                command: signedBody.command,
                args: signedBody.args,
                metadata: signedBody.metadata,
                ttlSeconds: signedBody.ttlSeconds,
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs,
                    signature,
                },
            }),
        });
        assert.equal(missingIdempotency.status, 400);

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
                idempotencyKey: 'sig-pause-2h-expired',
                auth: {
                    type: 'eip191',
                    address: account.address,
                    timestampMs: expiredTimestampMs,
                    signature: expiredSignature,
                },
            }),
        });
        assert.equal(expired.status, 401);
    } finally {
        await messageApi.stop();
    }

    console.log('[test] message API signature auth OK');
}

main().catch((error) => {
    console.error('[test] message API signature auth failed:', error?.message ?? error);
    process.exit(1);
});
