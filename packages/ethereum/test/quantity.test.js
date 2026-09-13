import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTransactionQuantity } from '@oyaprotocol/ethereum';

test('public quantity parser preserves zero, mixed-case hex, and the uint256 maximum', () => {
    assert.equal(parseTransactionQuantity('0x0', 'balance'), 0n);
    assert.equal(parseTransactionQuantity('0x7a69', 'chainId'), 31337n);
    assert.equal(parseTransactionQuantity('0xAbCd', 'balance'), 43981n);
    assert.equal(parseTransactionQuantity(`0x${'f'.repeat(64)}`, 'balance'), (1n << 256n) - 1n);
});

test('public quantity parser rejects malformed and oversized values without echoing them', () => {
    for (const value of [
        undefined, null, true, 1, 1n, {}, [], ['0x1'], '', '0x', '0x00', '0x01',
        '0X1', '1', '-1', '0x-1', '0x1.0', ' 0x1', '0x1 ', '0x1\n', '0xsecret-marker',
        `0x1${'0'.repeat(64)}`, `0x${'f'.repeat(10_000)}`,
    ]) {
        assert.throws(() => parseTransactionQuantity(value, 'RPC result'), (error) => {
            assert.ok([
                'RPC result must be an Ethereum quantity hex string without leading zeros.',
                'RPC result must fit in 256 bits.',
            ].includes(error.message));
            return true;
        });
    }
});
