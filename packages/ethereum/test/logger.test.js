import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { encodeLoggerCall, decodeLoggerEvent, hashLoggerCid } from '../dist/index.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/logger-abi.json', import.meta.url), 'utf8'));
const { loggerAddress, node } = fixtures;
const sample = fixtures.cases.find(({ name }) => name === 'hello');
const topics = [...fixtures.topics, sample.cidKeccak256Hash];

function createLog(overrides = {}) {
    return { address: loggerAddress, topics: [...topics], data: sample.data, ...overrides };
}

test('Logger call encoding matches independent Foundry ABI fixtures', () => {
    for (const { cid, calldata } of fixtures.cases) {
        assert.equal(encodeLoggerCall(cid), calldata, JSON.stringify(cid));
    }
});

test('Logger event decoding matches independent Foundry ABI fixtures', () => {
    for (const { cid, cidKeccak256Hash, data } of fixtures.cases) {
        const log = createLog({ data, topics: [...fixtures.topics, cidKeccak256Hash] });
        assert.deepEqual(decodeLoggerEvent(log, loggerAddress), { node, cidKeccak256Hash, cid });
    }
});

test('Logger lookup hashes match independent Foundry fixtures', () => {
    for (const { cid, cidKeccak256Hash } of fixtures.cases) {
        assert.equal(hashLoggerCid(cid), cidKeccak256Hash);
    }
});

test('Logger encoding and lookup hashing reject noncanonical CIDs', () => {
    for (const cid of [
        undefined, null, 1, {}, [], new String(sample.cid), '', 'bafy-test',
        '\ud800', '🚀', ` ${sample.cid}`, sample.cid.toUpperCase(), `${sample.cid}/file`,
        'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH',
    ]) {
        assert.throws(() => encodeLoggerCall(cid), /cid must be a canonical CIDv1/);
        assert.throws(() => hashLoggerCid(cid), /cid must be a canonical CIDv1/);
    }
});

test('Logger decoding rejects noncanonical recorded CIDs and mismatched hashes', () => {
    // The contract remains permissive; the kernel enforces its CID protocol.
    for (const cid of ['', 'bafy-test', 'café', sample.cid.toUpperCase(), ` ${sample.cid}`, `${sample.cid}/file`]) {
        const hex = Buffer.from(cid).toString('hex');
        const data = `0x${'20'.padStart(64, '0')}${(hex.length / 2).toString(16).padStart(64, '0')}${hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')}`;
        assert.throws(() => decodeLoggerEvent(createLog({ data }), loggerAddress), /canonical CIDv1/);
    }
    const log = createLog({ topics: [...fixtures.topics, fixtures.cases[0].cidKeccak256Hash] });
    assert.throws(() => decodeLoggerEvent(log, loggerAddress), /cidKeccak256Hash must match/);
});

test('Logger event filtering requires the expected emitter and event signature', () => {
    assert.equal(decodeLoggerEvent(createLog({ address: node }), loggerAddress), null);
    assert.equal(decodeLoggerEvent(createLog({ topics: [] }), loggerAddress), null);
    assert.equal(decodeLoggerEvent(createLog({ topics: [`0x${'00'.repeat(32)}`] }), loggerAddress), null);
    // Unrelated contracts or events need not use the Logger event's data layout.
    assert.equal(decodeLoggerEvent(createLog({ address: node, data: '0x' }), loggerAddress), null);
    assert.equal(decodeLoggerEvent(createLog({ topics: [`0x${'11'.repeat(32)}`], data: '0x' }), loggerAddress), null);
    // The previous Log(address,string) ABI is a different event.
    assert.equal(decodeLoggerEvent(createLog({ topics: [
        '0x0738f4da267a110d810e6e89fc59e46be6de0c37b1d5cd559b267dc3688e74e0', topics[1],
    ] }), loggerAddress), null);
});

test('Logger event matching ignores hex casing and preserves indexed value casing', () => {
    const upper = (hex) => `0x${hex.slice(2).toUpperCase()}`;
    assert.deepEqual(decodeLoggerEvent(createLog({
        address: upper(loggerAddress),
        topics: topics.map(upper),
        data: upper(sample.data),
    }), loggerAddress), {
        node: upper(node), cidKeccak256Hash: upper(sample.cidKeccak256Hash), cid: sample.cid,
    });
    assert.deepEqual(decodeLoggerEvent(createLog(), upper(loggerAddress)), {
        node, cidKeccak256Hash: sample.cidKeccak256Hash, cid: sample.cid,
    });
});

test('Logger event decoding preserves optional removed metadata', () => {
    for (const removed of [false, true]) {
        assert.deepEqual(decodeLoggerEvent(createLog({ removed }), loggerAddress), {
            node, cidKeccak256Hash: sample.cidKeccak256Hash, cid: sample.cid, removed,
        });
    }
    assert.equal('removed' in decodeLoggerEvent(createLog(), loggerAddress), false);
    for (const removed of [null, 0, 'false']) {
        assert.throws(() => decodeLoggerEvent(createLog({ removed }), loggerAddress), /log.removed/);
    }
});

test('Logger decoder validates the expected address and matching log envelope', () => {
    for (const address of [undefined, null, 12, '0x', node.slice(0, -2), ` ${node}`]) {
        assert.throws(() => decodeLoggerEvent(createLog(), address), /loggerAddress/);
        assert.throws(() => decodeLoggerEvent(createLog({ address }), loggerAddress), /log.address/);
    }
    for (const log of [undefined, null, [], true]) {
        assert.throws(() => decodeLoggerEvent(log, loggerAddress), /log must be a plain object/);
    }
    for (const invalidTopics of [undefined, null, '0x']) {
        assert.throws(() => decodeLoggerEvent(createLog({ topics: invalidTopics }), loggerAddress), /log.topics/);
    }
    for (const invalidTopics of [
        [topics[0]], topics.slice(0, 2), [...topics, topics[0]], [null], ['0x'],
        [topics[0], '0x', topics[2]], [topics[0], null, topics[2]],
        [topics[0], `0x01${topics[1].slice(4)}`, topics[2]],
    ]) {
        assert.throws(() => decodeLoggerEvent(createLog({ topics: invalidTopics }), loggerAddress), /topics|padding/);
    }
});

test('Logger decoder requires a 32-byte CID Keccak-256 hash topic', () => {
    for (const cidKeccak256Hash of [
        undefined, null, 0, '0x', `0x${'aa'.repeat(31)}`, `0x${'aa'.repeat(33)}`,
        `${topics[2]}0`, ` ${topics[2]}`, `0x${'gg'.repeat(32)}`,
    ]) {
        const log = createLog({ topics: [topics[0], topics[1], cidKeccak256Hash] });
        assert.throws(() => decodeLoggerEvent(log, loggerAddress), /log.topics\[2\] must be 32-byte hex data/);
    }
});

test('Logger decoder rejects invalid offsets, lengths, sizes, and nonzero padding', () => {
    const raw = sample.data.slice(2);
    const word = (value) => value.toString(16).padStart(64, '0');
    const invalidData = [
        null, '0x', '0x0', ` ${sample.data}`, `${sample.data}gg`,
        `0x${raw.slice(0, 64)}`, // Missing length word.
        `0x${word(0)}${raw.slice(64)}`, // Offset into the head.
        `0x${word(64)}${raw.slice(64)}`, // Noncanonical gap.
        `0x${'f'.repeat(64)}${raw.slice(64)}`, // Huge offset.
        `0x${raw.slice(0, 64)}${'f'.repeat(64)}${raw.slice(128)}`, // Huge declared length.
        `0x${raw.slice(0, 64)}${word(65)}${raw.slice(128)}`, // Declared data exceeds buffer.
        `0x${raw.slice(0, 64)}${word(8)}${raw.slice(128)}`, // Nonzero byte in declared padding.
        `0x${raw.slice(0, -2)}`, // Truncated padding.
        `0x${raw}00`, // Trailing byte.
        `0x${raw}${'0'.repeat(64)}`, // Trailing word.
        `0x${raw.slice(0, -2)}01`, // Nonzero padding.
    ];
    for (const data of invalidData) {
        assert.throws(() => decodeLoggerEvent(createLog({ data }), loggerAddress), /log.data|Logger event/);
    }
});

test('Logger decoder rejects invalid UTF-8 instead of silently replacing bytes', () => {
    // Each payload uses an otherwise valid ABI layout.
    for (const content of ['ff', 'c0af', 'eda080', 'e282', 'f4908080']) {
        const length = (content.length / 2).toString(16).padStart(64, '0');
        const data = `0x${'20'.padStart(64, '0')}${length}${content.padEnd(64, '0')}`;
        assert.throws(() => decodeLoggerEvent(createLog({ data }), loggerAddress), /valid UTF-8/);
    }
});

test('Logger decoder accepts receipt logs without changing their data', () => {
    const log = Object.freeze({
        ...createLog({ topics: Object.freeze([...topics]), removed: false }),
        blockHash: `0x${'aa'.repeat(32)}`,
        transactionHash: `0x${'bb'.repeat(32)}`,
        blockNumber: 123n, transactionIndex: 0n, logIndex: 1n,
    });
    assert.deepEqual(decodeLoggerEvent(log, loggerAddress), {
        node, cidKeccak256Hash: sample.cidKeccak256Hash, cid: sample.cid, removed: false,
    });
    assert.equal(log.data, sample.data);
});
