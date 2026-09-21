import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Wallet } from 'ethers';
import { parseConfig } from '../src/config.mjs';
import { fixture, gate, ledgerContract, signedMessage } from './runtime-fixture.mjs';

async function limited(response, retryAfter) {
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), String(retryAfter));
    assert.equal(response.headers.get('connection'), 'close');
    assert.deepEqual(await response.json(), { code: 'rate_limited', started: false });
}

test('message request limit defaults to 60 and validates positive integer overrides', () => {
    const input = { chainId: 31337, ledgerContract, allowedSigners: [Wallet.createRandom().address],
        rpcUrl: 'http://rpc.example', ipfsUrl: 'http://ipfs.example' };
    const parse = (overrides = {}) => parseConfig({ ...input, ...overrides }, { env: {} });
    assert.equal(parse().maxMessageRequestsPerMinute, 60);
    for (const value of [1, 120, 2_147_483_647]) {
        assert.equal(parse({ maxMessageRequestsPerMinute: value }).maxMessageRequestsPerMinute, value);
    }
    for (const value of [0, -1, 1.5, '60', true, {}, [], NaN, Infinity, 2_147_483_648]) {
        assert.throws(() => parse({ maxMessageRequestsPerMinute: value }), /maxMessageRequestsPerMinute/);
    }
});

test('allowlisted message attempts share fixed windows; limited requests do not delay reset or affect health', async (t) => {
    let now = 1234;
    t.mock.method(performance, 'now', () => now);
    const setup = await fixture(t, { maxMessageRequestsPerMinute: 3 });
    await setup.start();
    now = 1234 + 10_001;
    assert.equal((await setup.health()).status, 200);
    assert.equal((await fetch(`${setup.url}/v1/messages`)).status, 405);
    assert.equal((await fetch(`${setup.url}/other`, { method: 'POST' })).status, 404);
    for (let i = 0; i < 3; i++) assert.equal((await setup.post()).status, 200);
    await limited(await setup.post(), 50);
    assert.equal(setup.state.uploads, 3);
    assert.equal(setup.state.signs, 3);
    assert.equal(setup.state.sends, 3);
    assert.equal((await setup.health()).status, 200);

    now = 1234 + 59_999;
    await limited(await setup.post(), 1);
    now = 1234 + 60_000;
    const publications = [];
    for (let i = 0; i < 3; i++) {
        const response = await setup.post(); // Identical signed envelopes remain independent operations.
        assert.equal(response.status, 200);
        publications.push((await response.json()).publication);
    }
    assert.equal(new Set(publications.map((result) => result.cid)).size, 1);
    assert.equal(new Set(publications.map((result) => result.transactionHash)).size, 3);
    assert.deepEqual(setup.state.transactions.map((transaction) => transaction.nonce), [0, 1, 2, 3, 4, 5]);
    await limited(await setup.post(), 60);
    assert.equal(setup.state.uploads, 6);
    assert.equal(setup.state.signs, 6);
    assert.equal(setup.state.sends, 6);

    // Idle windows are skipped without moving the original boundaries.
    now = 1234 + 180_500;
    for (let i = 0; i < 3; i++) assert.equal((await setup.post()).status, 200);
    await limited(await setup.post(), 60);
    now = 1234 + 239_999;
    await limited(await setup.post(), 1);
    now = 1234 + 240_000;
    assert.equal((await setup.post()).status, 200);
    assert.equal(setup.state.uploads, 10);
});

test('only verified allowlisted signers share the budget; rejected messages retain their errors at the limit', async (t) => {
    t.mock.method(performance, 'now', () => 0);
    const agents = [Wallet.createRandom(), Wallet.createRandom()];
    const messages = await Promise.all(agents.map((agent) => signedMessage(agent)));
    const disallowed = await signedMessage(Wallet.createRandom());
    const setup = await fixture(t, { maxMessageRequestsPerMinute: 2, maxBodyBytes: 512,
        allowedSigners: agents.map((agent) => agent.address) });
    await setup.start();
    const rejected = async () => {
        assert.equal((await setup.post(null, { body: '{invalid json' })).status, 400);
        assert.equal((await setup.post({ ...messages[0], text: 'tampered' })).status, 401);
        assert.equal((await setup.post({ ...disallowed, signer: agents[0].address })).status, 401);
        assert.equal((await setup.post(disallowed)).status, 403);
        assert.equal((await setup.post(null, { body: 'x'.repeat(513) })).status, 413);
    };
    await rejected();
    assert.equal(setup.state.uploads, 0);
    assert.equal(setup.state.signs, 0);
    assert.equal(setup.state.sends, 0);
    assert.equal((await setup.post(messages[0])).status, 200);
    await rejected();
    assert.equal((await setup.post(messages[1])).status, 200);
    await limited(await setup.post(messages[0]), 60);
    await rejected();
    await limited(await setup.post(messages[1]), 60);
    assert.equal(setup.state.uploads, 2);
    assert.equal(setup.state.signs, 2);
    assert.equal(setup.state.sends, 2);
});

test('busy attempts consume the budget while accepted work still completes', async (t) => {
    t.mock.method(performance, 'now', () => 0);
    const setup = await fixture(t, { maxMessageRequestsPerMinute: 2 });
    const upload = gate();
    t.after(upload.release);
    setup.state.onUpload = upload.wait;
    await setup.start();
    const pending = setup.post();
    pending.catch(() => {});
    await upload.entered;
    const busy = await setup.post();
    assert.equal(busy.status, 503);
    assert.deepEqual(await busy.json(), { code: 'node_busy', started: false });
    await limited(await setup.post(), 60);
    const health = await setup.health();
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'busy');
    assert.equal(setup.state.uploads, 1);
    assert.equal(setup.state.signs, 0);
    upload.release();
    assert.equal((await pending).status, 200);
    await limited(await setup.post(), 60);
    assert.equal(setup.state.uploads, 1);
    assert.equal(setup.state.signs, 1);
    assert.equal(setup.state.sends, 1);
});

test('a restarted node starts with a fresh request budget', async (t) => {
    t.mock.method(performance, 'now', () => 0);
    const setup = await fixture(t, { maxMessageRequestsPerMinute: 1 });
    await setup.start();
    assert.equal((await setup.post()).status, 200);
    await limited(await setup.post(), 60);
    await setup.runtime.close();
    await setup.start();
    assert.equal((await setup.post()).status, 200);
    assert.equal(setup.state.uploads, 2);
    assert.equal(setup.state.signs, 2);
});
