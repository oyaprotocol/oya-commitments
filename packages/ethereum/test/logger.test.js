import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { encodeLoggerLogCall, decodeLoggerLogEvent } from '../dist/index.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/logger-abi.json', import.meta.url), 'utf8'));
const { loggerAddress, node, topics } = fixtures;
const sample = fixtures.cases.find(({ cid }) => cid === 'bafy-test');

function createLog(overrides = {}) {
    return { address: loggerAddress, topics: [...topics], data: sample.data, ...overrides };
}

test('Logger call encoding matches independent Foundry ABI fixtures', () => {
    for (const { cid, calldata } of fixtures.cases) {
        assert.equal(encodeLoggerLogCall(cid), calldata, JSON.stringify(cid));
    }
});

test('Logger event decoding matches independent Foundry ABI fixtures', () => {
    for (const { cid, data } of fixtures.cases) {
        assert.deepEqual(decodeLoggerLogEvent(createLog({ data }), loggerAddress), { node, cid });
    }
});

test('Logger helpers preserve arbitrary text across byte and ABI word boundaries', () => {
    for (const length of [0, 1, 30, 31, 32, 33, 63, 64, 65, 255, 1_024]) {
        for (const character of ['a', 'é', '界', '🚀', '\0']) {
            const cid = character.repeat(length);
            const calldata = encodeLoggerLogCall(cid);
            const data = `0x${calldata.slice(10)}`;
            assert.deepEqual(decodeLoggerLogEvent(createLog({ data }), loggerAddress), { node, cid });
        }
    }
});

test('Logger call encoding rejects values that cannot be encoded as exact Unicode text', () => {
    for (const cid of [undefined, null, 1, {}, [], new String('cid'), '\ud800', '\udc00', 'a\ud800b']) {
        assert.throws(() => encodeLoggerLogCall(cid), /cid must be a well-formed Unicode string/);
    }
});

test('Logger event filtering requires the expected emitter and event signature', () => {
    assert.equal(decodeLoggerLogEvent(createLog({ address: node }), loggerAddress), null);
    assert.equal(decodeLoggerLogEvent(createLog({ topics: [] }), loggerAddress), null);
    assert.equal(decodeLoggerLogEvent(createLog({ topics: [`0x${'00'.repeat(32)}`] }), loggerAddress), null);
    // Unrelated contracts or events need not use the Logger event's data layout.
    assert.equal(decodeLoggerLogEvent(createLog({ address: node, data: '0x' }), loggerAddress), null);
    assert.equal(decodeLoggerLogEvent(createLog({ topics: [`0x${'11'.repeat(32)}`], data: '0x' }), loggerAddress), null);
});

test('Logger event matching ignores hex casing and preserves the indexed node casing', () => {
    const upper = (hex) => `0x${hex.slice(2).toUpperCase()}`;
    assert.deepEqual(decodeLoggerLogEvent(createLog({
        address: upper(loggerAddress),
        topics: topics.map(upper),
        data: upper(sample.data),
    }), loggerAddress), { node: upper(node), cid: sample.cid });
    assert.deepEqual(decodeLoggerLogEvent(createLog(), upper(loggerAddress)), { node, cid: sample.cid });
});

test('Logger event decoding preserves optional removed metadata', () => {
    for (const removed of [false, true]) {
        assert.deepEqual(decodeLoggerLogEvent(createLog({ removed }), loggerAddress), {
            node, cid: sample.cid, removed,
        });
    }
    assert.equal('removed' in decodeLoggerLogEvent(createLog(), loggerAddress), false);
    for (const removed of [null, 0, 'false']) {
        assert.throws(() => decodeLoggerLogEvent(createLog({ removed }), loggerAddress), /log.removed/);
    }
});

test('Logger decoder validates the expected address and matching log envelope', () => {
    for (const address of [undefined, null, 12, '0x', node.slice(0, -2), ` ${node}`]) {
        assert.throws(() => decodeLoggerLogEvent(createLog(), address), /loggerAddress/);
        assert.throws(() => decodeLoggerLogEvent(createLog({ address }), loggerAddress), /log.address/);
    }
    for (const log of [undefined, null, [], true]) {
        assert.throws(() => decodeLoggerLogEvent(log, loggerAddress), /log must be a plain object/);
    }
    for (const invalidTopics of [undefined, null, '0x']) {
        assert.throws(() => decodeLoggerLogEvent(createLog({ topics: invalidTopics }), loggerAddress), /log.topics/);
    }
    for (const invalidTopics of [
        [topics[0]], [...topics, topics[0]], [null], ['0x'],
        [topics[0], '0x'], [topics[0], null],
        [topics[0], `0x01${topics[1].slice(4)}`],
    ]) {
        assert.throws(() => decodeLoggerLogEvent(createLog({ topics: invalidTopics }), loggerAddress), /topics|padding/);
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
        `0x${raw.slice(0, 64)}${word(33)}${raw.slice(128)}`, // Declared data exceeds buffer.
        `0x${raw.slice(0, 64)}${word(8)}${raw.slice(128)}`, // Nonzero byte in declared padding.
        `0x${raw.slice(0, -2)}`, // Truncated padding.
        `0x${raw}00`, // Trailing byte.
        `0x${raw}${'0'.repeat(64)}`, // Trailing word.
        `0x${raw.slice(0, -2)}01`, // Nonzero padding.
    ];
    for (const data of invalidData) {
        assert.throws(() => decodeLoggerLogEvent(createLog({ data }), loggerAddress), /log.data|Logger Log event/);
    }
});

test('Logger decoder rejects invalid UTF-8 instead of silently replacing bytes', () => {
    // Each payload uses an otherwise valid ABI layout.
    for (const content of ['ff', 'c0af', 'eda080', 'e282', 'f4908080']) {
        const length = (content.length / 2).toString(16).padStart(64, '0');
        const data = `0x${'20'.padStart(64, '0')}${length}${content.padEnd(64, '0')}`;
        assert.throws(() => decodeLoggerLogEvent(createLog({ data }), loggerAddress), /valid UTF-8/);
    }
});

test('Logger decoder accepts receipt logs without changing their data', () => {
    const log = Object.freeze({
        ...createLog({ topics: Object.freeze([...topics]), removed: false }),
        blockHash: `0x${'aa'.repeat(32)}`,
        transactionHash: `0x${'bb'.repeat(32)}`,
        blockNumber: 123n, transactionIndex: 0n, logIndex: 1n,
    });
    assert.deepEqual(decodeLoggerLogEvent(log, loggerAddress), { node, cid: sample.cid, removed: false });
    assert.equal(log.data, sample.data);
});
