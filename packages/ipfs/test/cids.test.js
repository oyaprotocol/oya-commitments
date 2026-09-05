import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    createIpfsConfig, publishToIpfs, readIpfsBytes, readIpfsText,
    readIpfsPublicGatewayBytes, readIpfsPublicGatewayText,
} from '../dist/index.js';

const fixtures = JSON.parse(readFileSync(new URL('../../test/fixtures/cids.json', import.meta.url), 'utf8'));
const sample = fixtures.cases.find(({ name }) => name === 'hello');
const config = createIpfsConfig({
    url: 'https://ipfs.example', headers: {}, timeoutMs: 1_000, maxRetries: 1, retryDelayMs: 0,
});
const response = (payload, status = 200) => ({
    ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Unavailable',
    text: async () => JSON.stringify(payload),
});

test('IPFS uploads request the fixed import profile for independent CID fixtures across chunk boundaries', async () => {
    for (const entry of fixtures.cases) {
        const content = entry.text !== undefined ? Buffer.from(entry.text)
            : entry.hex !== undefined ? Buffer.from(entry.hex, 'hex')
            : Buffer.alloc(entry.byteLength, entry.repeatByte);
        const result = await publishToIpfs({
            config, content, filename: 'artifact.bin', mediaType: 'application/octet-stream',
            fetch: async (url, request) => {
                const parsed = new URL(url);
                assert.equal(parsed.pathname, '/api/v0/add');
                assert.deepEqual(Object.fromEntries(parsed.searchParams), fixtures.options);
                assert.deepEqual([...request.body.keys()], ['file']);
                assert.deepEqual(Buffer.from(await request.body.get('file').arrayBuffer()), content);
                return response({ Hash: entry.cid });
            },
        });
        assert.equal(result.cid, entry.cid);
        assert.equal(result.uri, `ipfs://${entry.cid}`);
        assert.equal(result.contentByteLength, content.length);
        assert.equal(result.pinned, true);
    }
});

test('IPFS publication validates every supported provider CID response shape', async () => {
    const shapes = [
        (cid) => ({ Hash: cid }), (cid) => ({ IpfsHash: cid }), (cid) => ({ cid }),
        (cid) => ({ Cid: { '/': cid } }), (cid) => ({ cid: { '/': cid } }),
    ];
    for (const shape of shapes) {
        for (const cid of [sample.cid, 'bafy-invalid', ` ${sample.cid}`, sample.cid.toUpperCase(), `ipfs://${sample.cid}`]) {
            let calls = 0;
            const options = {
                config, content: sample.text, filename: 'message.json', mediaType: 'application/json',
                fetch: async () => { calls += 1; return response(shape(cid)); },
            };
            if (cid === sample.cid) assert.equal((await publishToIpfs(options)).cid, cid);
            else await assert.rejects(publishToIpfs(options), /IPFS add response CID must be a canonical CIDv1/);
            assert.equal(calls, 1, 'Invalid CIDs must not cause transport retries');
        }
    }
});

test('all IPFS read helpers reject noncanonical CIDs before invoking a transport', async () => {
    let calls = 0;
    for (const read of [readIpfsBytes, readIpfsText, readIpfsPublicGatewayBytes, readIpfsPublicGatewayText]) {
        for (const cid of [
            '', undefined, 'hello', ` ${sample.cid}`, `${sample.cid}\n`, sample.cid.toUpperCase(),
            `ipfs://${sample.cid}`, `${sample.cid}/message.json`,
            'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH',
        ]) {
            await assert.rejects(read({
                config, gatewayUrl: config.url, headers: {}, timeoutMs: 1_000, maxRetries: 1,
                retryDelayMs: 0, cid, maxBytes: 128,
                fetch: async () => { calls += 1; throw new Error('Unexpected fetch'); },
            }), /cid must be a canonical CIDv1/);
        }
    }
    assert.equal(calls, 0);
});

test('IPFS publication snapshots mutable content so retries cannot change the CID input', async () => {
    const content = new Uint8Array([1, 2, 3]);
    const expectedCid = fixtures.cases.find(({ name }) => name === 'bytes').cid;
    const uploads = [];
    const result = await publishToIpfs({
        config, content, filename: 'artifact.bin', mediaType: 'application/octet-stream',
        fetch: async (_url, request) => {
            uploads.push([...new Uint8Array(await request.body.get('file').arrayBuffer())]);
            content.fill(0);
            return uploads.length === 1 ? response({}, 503) : response({ Hash: expectedCid });
        },
    });
    assert.deepEqual(uploads, [[1, 2, 3], [1, 2, 3]]);
    assert.equal(result.cid, expectedCid);
    assert.equal(result.attemptCount, 2);
});

test('IPFS publication rejects filenames that could introduce a directory structure', async () => {
    let calls = 0;
    for (const filename of ['folder/file.json', 'folder\\file.json', '.', '..', 'name\0', 'name\r\n']) {
        await assert.rejects(publishToIpfs({
            config, content: sample.text, filename, mediaType: 'application/json',
            fetch: async () => { calls += 1; return response({ Hash: sample.cid }); },
        }), /filename must be a single filename/);
    }
    assert.equal(calls, 0);
});
