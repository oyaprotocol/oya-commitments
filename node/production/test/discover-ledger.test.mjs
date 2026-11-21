import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { discoverLedger } from '../src/discover-ledger.mjs';

const ledger = `0x${'11'.repeat(20)}`;
const topic = '0xce2d845fcf02211a951a2153c1ddf64ec48ef6d54644ea188101f10018b871dc';
const tx = `0x${'ab'.repeat(32)}`;
const log = { address: ledger, topics: [topic], transactionHash: tx, blockNumber: '0x5', logIndex: '0x1', removed: false };
async function fixture(t) {
    const results = { eth_chainId: '0x1', eth_blockNumber: '0x8', eth_getLogs: [] }, calls = [];
    const server = createServer(async (req, res) => {
        let data = '';
        for await (const chunk of req) data += chunk;
        const call = JSON.parse(data);
        calls.push(call);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: results[call.method] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const rpcUrl = `http://127.0.0.1:${server.address().port}`;
    const scan = (from = 5, to = 8) => discoverLedger(from, to, { chainId: 1, ledgerContract: ledger, rpcUrl, ipfsUrl: rpcUrl });
    return { results, calls, scan };
}

test('returns verifier records in chain order from a single address and topic query', async t => {
    const { results, calls, scan } = await fixture(t);
    results.eth_getLogs = [{ ...log, blockNumber: '0x8', logIndex: '0x0', transactionHash: `0x${'cd'.repeat(32)}` }, log];
    const records = await scan();
    assert.deepEqual(records, [{ transactionHash: tx, logIndex: 1 }, { transactionHash: results.eth_getLogs[0].transactionHash, logIndex: 0 }]);
    assert.deepEqual(calls.map(c => c.method), ['eth_chainId', 'eth_blockNumber', 'eth_getLogs']);
    assert.deepEqual(calls[2].params, [{ fromBlock: '0x5', toBlock: '0x8', address: ledger, topics: [topic] }]);
    results.eth_getLogs = [];
    assert.deepEqual(await scan(), []);
});

test('rejects invalid ranges, the wrong chain and future blocks before log lookup', async t => {
    const { results, calls, scan } = await fixture(t);
    for (const [from, to] of [[-1, 1], [1, 0], [0, 1024], [0, Infinity]]) await assert.rejects(scan(from, to));
    assert.equal(calls.length, 0);
    await assert.rejects(scan(8, 9));
    results.eth_chainId = '0x2';
    await assert.rejects(scan());
    assert.deepEqual(calls.map(c => c.method), ['eth_chainId', 'eth_blockNumber', 'eth_chainId']);
});

test('rejects the whole response for inconsistent locations or filter results', async t => {
    const { results, scan } = await fixture(t);
    for (const bad of [{}, { removed: true }, { blockNumber: '0x4' }, { logIndex: '0x01' },
        { logIndex: '0x20000000000000' }, { address: tx }, { topics: [] }, { transactionHash: null }]) {
        results.eth_getLogs = [log, { ...log, logIndex: '0x2', ...bad }];
        if (!Object.keys(bad).length) results.eth_getLogs = [log, log];
        await assert.rejects(scan());
    }
});
