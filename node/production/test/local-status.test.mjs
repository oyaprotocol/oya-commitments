import assert from 'node:assert/strict';
import test from 'node:test';
import { statusLocalNode } from '../scripts/local-status.mjs';

const settings = {
    config: { host: '127.0.0.1', port: 8787, chainId: 31337,
        ledgerContract: '0x1111111111111111111111111111111111111111' },
    nodeAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
};
const ready = { status: 'ready', busy: false, chainId: settings.config.chainId,
    ledgerContract: settings.config.ledgerContract, nodeAddress: settings.nodeAddress };

test('status validates health state, HTTP status, and all identity fields', async (t) => {
    const cases = [
        ['ready', 200, ready, 0, 'OK ready'],
        ['busy', 200, { ...ready, status: 'busy', busy: true }, 0, 'OK busy'],
        ['address casing', 200, { ...ready, nodeAddress: `0x${settings.nodeAddress.slice(2).toUpperCase()}` }, 0, 'OK ready'],
        ['uncertain', 503, { ...ready, status: 'transaction_outcome_unknown' }, 1, 'FAIL transaction_outcome_unknown'],
        ['draining', 503, { ...ready, status: 'shutting_down', busy: true }, 1, 'FAIL shutting_down'],
        ['wrong chain', 200, { ...ready, chainId: 1 }, 1, 'FAIL Node identity mismatch'],
        ['wrong Ledger', 200, { ...ready, ledgerContract: settings.nodeAddress }, 1, 'FAIL Node identity mismatch'],
        ['wrong node', 200, { ...ready, nodeAddress: settings.config.ledgerContract }, 1, 'FAIL Node identity mismatch'],
        ['wrong HTTP status', 503, ready, 1, 'FAIL Malformed'],
        ['inconsistent busy flag', 200, { ...ready, busy: true }, 1, 'FAIL Malformed'],
        ['missing identity', 200, { status: 'ready', busy: false }, 1, 'FAIL Malformed'],
        ['null body', 200, null, 1, 'FAIL Malformed'],
        ['unknown state', 200, { ...ready, status: 'provider-secret-marker' }, 1, 'FAIL Malformed'],
    ];
    for (const [name, status, body, code, message] of cases) {
        await t.test(name, async () => {
            const output = [];
            let calls = 0;
            assert.equal(await statusLocalNode(settings, { log: (line) => output.push(line), fetch: async (url, options) => {
                calls++;
                assert.equal(url, 'http://127.0.0.1:8787/healthz');
                assert.equal(options.redirect, 'error');
                assert.equal(options.headers, undefined);
                return new Response(JSON.stringify(body), { status });
            } }), code);
            assert.equal(calls, 1);
            assert.ok(output[0].startsWith(message));
            assert.equal(output.join('\n').includes('secret-marker'), false);
            if (name === 'uncertain') assert.match(output[1], /Inspect the prior transaction/);
        });
    }
});

test('status supports IPv6 loopback and reports unreachable or unreadable health safely', async () => {
    const output = [];
    const log = (line) => output.push(line);
    const ipv6 = { ...settings, config: { ...settings.config, host: '::1' } };
    assert.equal(await statusLocalNode(ipv6, { log, fetch: async (url) => {
        assert.equal(url, 'http://[::1]:8787/healthz');
        return new Response(JSON.stringify(ready));
    } }), 0);
    assert.equal(await statusLocalNode(settings, { log, fetch: async () => {
        throw new Error('provider-secret-marker');
    } }), 1);
    assert.match(output.at(-1), /unreachable/);
    assert.equal(await statusLocalNode(settings, { log, fetch: async () => new Response('provider-secret-marker') }), 1);
    assert.match(output.at(-1), /valid node health response/);
    assert.equal(output.join('\n').includes('secret-marker'), false);
});

test('status deadline covers stalled connections and response bodies', { timeout: 2000 }, async () => {
    for (const bodyStalls of [false, true]) {
        const output = [];
        let signal;
        assert.equal(await statusLocalNode(settings, { timeoutMs: 25, log: (line) => output.push(line),
            fetch: async (_url, options) => {
                signal = options.signal;
                const pending = new Promise(() => {});
                return bodyStalls ? { json: () => pending } : pending;
            },
        }), 1);
        assert.equal(signal.aborted, true);
        assert.match(output.at(-1), /timed out/);
    }
});
