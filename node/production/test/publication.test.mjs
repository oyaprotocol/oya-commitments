import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Wallet } from 'ethers';
import { cid, fixture, gate, ledgerContract, signedMessage } from './runtime-fixture.mjs';

test('HTTP holds one operation through upload and receipt, then repeats independently', async (t) => {
    const setup = await fixture(t);
    await setup.start();
    const upload = gate();
    const receipt = gate();
    t.after(() => { upload.release(); receipt.release(); });
    setup.state.onUpload = upload.wait;
    setup.state.onReceipt = receipt.wait;
    const pending = setup.post();
    await upload.entered;
    const busy = await setup.post();
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '5');
    assert.deepEqual(await busy.json(), { code: 'node_busy', started: false });
    assert.equal((await setup.post(await signedMessage(Wallet.createRandom()))).status, 403);
    assert.equal((await setup.post({ ...setup.message, text: 'tampered' })).status, 401);
    assert.equal(setup.state.uploads, 1);
    assert.equal(setup.state.signs, 0);
    upload.release();
    await receipt.entered;
    assert.equal((await (await setup.health()).json()).status, 'busy');
    assert.equal((await setup.post()).status, 503);
    assert.equal(setup.state.uploads, 1);
    assert.equal(setup.state.signs, 1);
    assert.equal(setup.state.sends, 1);
    receipt.release();
    const response = await pending;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'logged');
    assert.deepEqual(body.publication, {
        status: 'logged', cid, uri: `ipfs://${cid}`, transactionHash: setup.state.transactions[0].hash,
        blockNumber: '1', nodeAddress: setup.wallet.address, ledgerContract,
    });
    assert.equal(Object.hasOwn(body.publication, 'messageId'), false);
    const duplicate = await setup.post();
    assert.equal(duplicate.status, 200);
    assert.notEqual((await duplicate.json()).publication.transactionHash, body.publication.transactionHash);
    assert.deepEqual(setup.state.transactions.map((tx) => tx.nonce), [0, 1]);
    assert.equal(setup.state.uploads, 2);
    assert.equal(setup.state.mined, 2);
    assert.equal((await (await setup.health()).json()).status, 'ready');
});

test('definite failures return sanitized results and release admission', async (t) => {
    for (const failure of ['ipfs', 'preparation', 'reverted', 'missing_event']) await t.test(failure, async (t) => {
        const setup = await fixture(t);
        await setup.start();
        if (failure === 'ipfs') setup.state.ipfsFailure = true;
        else if (failure === 'preparation') setup.state.preparationFailure = true;
        else setup.state.receiptMode = failure;
        const response = await setup.post();
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.equal(body.code, 'publication_failed');
        assert.equal(body.started, true);
        assert.ok(!JSON.stringify([body, setup.logs]).includes('provider-secret-marker'));
        if (failure === 'ipfs') assert.equal(body.publication, undefined);
        else assert.equal(body.publication.cid, cid);
        if (failure === 'ipfs' || failure === 'preparation') {
            assert.equal(body.loggingOutcome, 'not_submitted');
            assert.equal(setup.state.signs, 0);
            assert.equal(setup.state.sends, 0);
        } else {
            assert.equal(body.loggingOutcome, 'failed');
            assert.equal(body.publication.blockNumber, '1');
            assert.equal(body.publication.transactionHash, setup.state.transactions[0].hash);
        }
        setup.state.ipfsFailure = false;
        setup.state.preparationFailure = false;
        setup.state.receiptMode = 'mined';
        assert.equal((await setup.health()).status, 200);
        assert.equal((await setup.post()).status, 200);
    });
});

test('uncertain submission, receipt timeout, and malformed receipt block further work', async (t) => {
    for (const failure of ['submission', 'pending', 'malformed']) await t.test(failure, async (t) => {
        const setup = await fixture(t, { receiptTimeoutMs: 80 });
        await setup.start();
        if (failure === 'submission') setup.state.sendFailure = true;
        else setup.state.receiptMode = failure;
        const response = await setup.post();
        assert.equal(response.status, failure === 'pending' ? 504 : 502);
        const body = await response.json();
        assert.equal(body.loggingOutcome, 'unknown');
        assert.equal(body.publication.cid, cid);
        assert.equal(body.publication.transactionHash, setup.state.transactions[0].hash);
        assert.ok(!JSON.stringify([body, setup.logs]).includes('provider-secret-marker'));
        const previousCalls = [...setup.state.calls];
        const health = await setup.health();
        assert.equal(health.status, 503);
        assert.equal((await health.json()).status, 'transaction_outcome_unknown');
        const rejected = await setup.post();
        assert.equal(rejected.status, 503);
        assert.equal(rejected.headers.get('retry-after'), null);
        assert.deepEqual(await rejected.json(), { code: 'transaction_outcome_unknown', started: false });
        assert.equal((await setup.post(await signedMessage(Wallet.createRandom()))).status, 403);
        assert.equal(setup.state.uploads, 1);
        assert.equal(setup.state.signs, 1);
        assert.equal(setup.state.sends, 1);
        assert.deepEqual(setup.state.calls, previousCalls, 'no host recovery or extra receipt query');
    });
});

test('unexpected unclassified faults return 500 and leave the node unavailable', async (t) => {
    const setup = await fixture(t);
    await setup.start();
    setup.state.onUpload = () => { throw new TypeError('private-fault-marker'); };
    const response = await setup.post();
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { code: 'internal_error', started: true, loggingOutcome: 'unknown' });
    assert.ok(!JSON.stringify(setup.logs).includes('private-fault-marker'));
    assert.equal((await setup.post()).status, 503);
    assert.equal((await setup.health()).status, 503);
});

test('overall deadline aborts held I/O and handles pre- and post-submission outcomes', async (t) => {
    for (const stage of ['Upload', 'Receipt']) await t.test(stage, async (t) => {
        const setup = await fixture(t, { operationTimeoutMs: 80 });
        await setup.start();
        const held = gate();
        t.after(held.release);
        setup.state[`on${stage}`] = held.wait;
        const response = await setup.post();
        assert.equal(response.status, 504);
        const body = await response.json();
        assert.equal(body.code, 'operation_timeout');
        assert.equal(body.loggingOutcome, stage === 'Upload' ? 'not_submitted' : 'unknown');
        held.release();
        if (stage === 'Upload') {
            assert.equal(setup.state.sends, 0);
            assert.equal((await setup.post()).status, 200);
            assert.equal(setup.state.sends, 1, 'late upload completion must not submit a transaction');
        } else assert.equal((await setup.post()).status, 503);
    });
});

test('a disconnected accepted request stays busy and shutdown drains its final result', async (t) => {
    const setup = await fixture(t);
    await setup.start();
    const held = gate();
    t.after(held.release);
    setup.state.onReceipt = held.wait;
    const request = httpRequest(`${setup.url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
    });
    request.on('error', () => {});
    request.end(JSON.stringify(setup.message));
    await held.entered;
    const disconnected = once(request, 'close').catch(() => {});
    request.destroy();
    await disconnected;
    assert.equal((await setup.post()).status, 503);
    assert.equal(setup.state.uploads, 1);
    let drained = false;
    const closing = setup.runtime.close().then(() => { drained = true; });
    await delay(20);
    assert.equal(drained, false);
    held.release();
    await closing;
    assert.equal(setup.state.mined, 1);
    assert.equal(setup.logs.length, 1);
    assert.equal(setup.logs[0].httpStatus, 200);
    assert.equal(setup.logs[0].publication.status, 'logged');
});

test('shutdown rejects a request that finishes authentication after draining begins', async (t) => {
    const setup = await fixture(t);
    await setup.start();
    const body = JSON.stringify(setup.message);
    const requestReceived = once(setup.runtime.server, 'request');
    const response = new Promise((resolve, reject) => {
        const request = httpRequest(`${setup.url}/v1/messages`, { method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
        });
        request.on('error', reject);
        request.write(body.slice(0, 1));
        setup.finishRequest = () => request.end(body.slice(1));
    });
    await requestReceived;
    const closing = setup.runtime.close();
    setup.finishRequest();
    assert.deepEqual(await response, { status: 503, body: { code: 'shutting_down', started: false } });
    await closing;
    assert.equal(setup.state.uploads, 0);
    assert.equal(setup.state.signs, 0);
});
