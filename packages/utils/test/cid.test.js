import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { assertCanonicalCid } from '../dist/index.js';

const fixtures = JSON.parse(readFileSync(new URL('../../test/fixtures/cids.json', import.meta.url), 'utf8'));
const cid = fixtures.cases.find(({ name }) => name === 'hello').cid;

// Independent bit-string encoder for constructing malformed binary CID cases.
function base32(bytes) {
    const bits = Array.from(bytes, (byte) => byte.toString(2).padStart(8, '0')).join('');
    const padded = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0');
    return 'b' + padded.match(/.{5}/g).map((group) => 'abcdefghijklmnopqrstuvwxyz234567'[Number.parseInt(group, 2)]).join('');
}

test('canonical CID validation accepts independent raw and multi-block file CIDs unchanged', () => {
    for (const { cid } of fixtures.cases) assert.equal(assertCanonicalCid(cid, 'cid'), cid);
});

test('canonical CID validation supports minimally encoded multibyte codecs', () => {
    for (const codec of [[0xa9, 0x02], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]]) {
        const value = base32([1, ...codec, 0x12, 32, ...Array(32).fill(0)]);
        assert.equal(assertCanonicalCid(value, 'cid'), value);
    }
});

test('canonical CID validation rejects alternate representations and invalid text without normalization', () => {
    for (const value of [
        undefined, null, 1, {}, new String(cid), '', 'hello', 'bafy-test',
        'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH',
        cid.toUpperCase(), ` ${cid}`, `${cid}\n`, `${cid}\r`, `${cid}\0`,
        `ipfs://${cid}`, `/ipfs/${cid}`, `${cid}/message.json`, `${cid}?x=1`,
        `${cid}=`, `${cid}a`, cid.slice(0, -1), `${cid.slice(0, -1)}f`,
        `b0${cid.slice(2)}`, `b🚀${cid.slice(2)}`, 'b' + 'a'.repeat(100_000),
    ]) {
        assert.throws(() => assertCanonicalCid(value, 'test CID'), /test CID must be a canonical CIDv1/);
    }
});

test('canonical CID validation rejects malformed CID structure and hash parameters', () => {
    const digest = Array(32).fill(0);
    for (const bytes of [
        [0, 0x55, 0x12, 32, ...digest], // CID version.
        [2, 0x55, 0x12, 32, ...digest],
        [0x81, 0, 0x55, 0x12, 32, ...digest], // Nonminimal version.
        [1, 0xd5, 0, 0x12, 32, ...digest], // Nonminimal codec.
        [1, ...Array(9).fill(0x80), 0x12, 32, ...digest], // Codec exceeds 63 bits.
        [1, 0x55, 0x13, 32, ...digest], // Different hash algorithm.
        [1, 0x55, 0, 32, ...digest], // Identity multihash.
        [1, 0x55, 0x92, 0, 32, ...digest], // Nonminimal hash code.
        [1, 0x55, 0x12, 0xa0, 0, ...digest], // Nonminimal digest length.
        [1, 0x55, 0x12, 31, ...digest], // Declared digest length.
        [1, 0x55, 0x12, 32, ...digest.slice(1)], // Truncated digest.
        [1, 0x55, 0x12, 32, ...digest, 0], // Trailing byte.
    ]) {
        assert.throws(() => assertCanonicalCid(base32(bytes), 'cid'), /canonical CIDv1/);
    }
});
