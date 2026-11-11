import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress } from '@oyaprotocol/ethereum';

// ERC-55 specification vectors, including all-upper and all-lower checksums.
const vectors = [
    '0x52908400098527886E0F7030069857D2E4169EE7',
    '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
    '0xde709f2102306220921060314715629080e2fb77',
    '0x27b1fdb04752bbc536007a920d24acb045561c26',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
];

test('getAddress exports a pure ERC-55 normalizer from the package root', () => {
    for (const address of vectors) {
        for (const value of [address, address.toLowerCase(), `0x${address.slice(2).toUpperCase()}`]) {
            assert.equal(getAddress(value), address);
            assert.equal(getAddress(value.slice(2)), address);
        }
    }
    assert.equal(getAddress(`0x${'0'.repeat(40)}`), `0x${'0'.repeat(40)}`);
    assert.equal(getAddress(`0x${'f'.repeat(40)}`), '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF');
});

test('getAddress rejects every single-letter checksum mutation when still mixed case', () => {
    for (const address of vectors) {
        for (let i = 2; i < address.length; i++) {
            if (!/[a-fA-F]/.test(address[i])) continue;
            const letter = address[i] === address[i].toLowerCase() ? address[i].toUpperCase() : address[i].toLowerCase();
            const mutated = address.slice(0, i) + letter + address.slice(i + 1);
            if (!/[a-f]/.test(mutated.slice(2)) || !/[A-F]/.test(mutated.slice(2))) continue;
            assert.throws(() => getAddress(mutated), /checksum/);
            assert.throws(() => getAddress(mutated.slice(2)), /checksum/);
        }
    }
});

test('getAddress accepts direct ICAP with validated checksum and preserves leading zeroes', () => {
    assert.equal(getAddress('XE65GB6LDNXYOFTX0NSV3FUWKOWIXAMJK36'), '0x8ba1f109551bD432803012645Ac136ddd64DBA72');
    assert.equal(getAddress('XE65gb6ldnxyoftx0nsv3fuwkowixamjk36'), '0x8ba1f109551bD432803012645Ac136ddd64DBA72');
    assert.equal(getAddress('XE50000000000000000000000000000000'), `0x${'0'.repeat(40)}`);
    assert.equal(getAddress('XE23000000000000000000000000000001'), `0x${'0'.repeat(39)}1`);
});

test('getAddress rejects malformed values without coercion or input disclosure', () => {
    const address = vectors[4];
    for (const value of [
        undefined, null, true, 1, 1n, {}, [], [address], new String(address),
        { toString() { throw new Error('must not coerce'); } },
        '', '0x', address.slice(0, -1), address + '0', address.slice(2, -1),
        '0X' + address.slice(2), ' ' + address, address + ' ', address + '\n',
        address + '\r', address + '\u0000', address.replace('5', 'Ｇ'), 'secret-marker.eth',
        `0x${'f'.repeat(10000)}`, 'XE65GB6LDNXYOFTX0NSV3FUWKOWIXAMJK37',
        'XE00GB6LDNXYOFTX0NSV3FUWKOWIXAMJK36', 'xe65GB6LDNXYOFTX0NSV3FUWKOWIXAMJK36',
        'XE65GB6LDNXYOFTX0NSV3FUWKOWIXAMJK36\n', 'XE65GB6LDNXYOFTX0NSV3FUWKOWIXAMJK3!',
    ]) {
        assert.throws(() => getAddress(value), error => {
            assert.ok(['Invalid Ethereum address.', 'Invalid Ethereum address checksum.', 'Invalid ICAP checksum.'].includes(error.message));
            return true;
        });
    }
});

// Build an independent mod-97 ICAP fixture for the first out-of-range 160-bit value.
function icap(value) {
    const body = value.toString(36).toUpperCase().padStart(30, '0');
    const numeric = [...body + 'XE00'].map(char => parseInt(char, 36).toString()).join('');
    return 'XE' + (98n - BigInt(numeric) % 97n).toString().padStart(2, '0') + body;
}

test('getAddress bounds ICAP to 20 bytes and rejects every wrong check digit', () => {
    assert.throws(() => getAddress(icap(1n << 160n)), /Invalid Ethereum address/);
    assert.equal(getAddress(icap((1n << 160n) - 1n)), getAddress(`0x${'f'.repeat(40)}`));
    const valid = icap(123456789n);
    for (let n = 0; n < 100; n++) {
        const digits = String(n).padStart(2, '0');
        if (digits !== valid.slice(2, 4)) assert.throws(() => getAddress('XE' + digits + valid.slice(4)), /checksum/);
    }
});
