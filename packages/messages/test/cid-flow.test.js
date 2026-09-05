import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { publishSignedMessage } from '@oyaprotocol/messages';
import { createIpfsConfig, readIpfsBytes, readIpfsPublicGatewayBytes } from '@oyaprotocol/ipfs';
import { encodeLoggerCall, decodeLoggerEvent, hashLoggerCid } from '@oyaprotocol/ethereum';

const imports = JSON.parse(readFileSync(new URL('../../test/fixtures/cids.json', import.meta.url), 'utf8'));
const logger = JSON.parse(readFileSync(new URL('../../ethereum/test/fixtures/logger-abi.json', import.meta.url), 'utf8'));
const publication = imports.cases.find(({ name }) => name === 'message');
const event = logger.cases.find(({ name }) => name === 'message');

test('a signed message uses the same canonical CID for publication, Logger lookup, and retrieval', async () => {
    const config = createIpfsConfig({
        url: 'https://ipfs.example', headers: {}, timeoutMs: 1_000, maxRetries: 0, retryDelayMs: 0,
    });
    const result = await publishSignedMessage(JSON.parse(publication.text), {
        config,
        fetch: async (url, request) => {
            assert.deepEqual(Object.fromEntries(new URL(url).searchParams), imports.options);
            assert.equal(await request.body.get('file').text(), publication.text);
            return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ Hash: publication.cid }) };
        },
    });
    assert.equal(result.cid, event.cid);
    assert.equal(encodeLoggerCall(result.cid), event.calldata);
    assert.equal(hashLoggerCid(result.cid), event.cidKeccak256Hash);
    const decoded = decodeLoggerEvent({
        address: logger.loggerAddress,
        topics: [...logger.topics, event.cidKeccak256Hash], data: event.data,
    }, logger.loggerAddress);
    assert.equal(decoded.cid, result.cid);

    for (const read of [readIpfsBytes, readIpfsPublicGatewayBytes]) {
        const retrieved = await read({
            config, gatewayUrl: config.url, headers: {}, timeoutMs: 1_000, maxRetries: 0,
            retryDelayMs: 0, cid: decoded.cid, maxBytes: 4096,
            fetch: async (url) => {
                assert.ok(url.endsWith(decoded.cid));
                return {
                    ok: true, status: 200, statusText: 'OK',
                    body: new ReadableStream({ start(controller) {
                        controller.enqueue(new TextEncoder().encode(publication.text));
                        controller.close();
                    } }),
                };
            },
        });
        assert.equal(retrieved.cid, decoded.cid);
        assert.deepEqual(JSON.parse(new TextDecoder().decode(retrieved.bytes)), JSON.parse(publication.text));
    }
});
