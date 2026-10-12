import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet } from 'ethers';
import { signJob, validateJob, digest, executionIdentity } from '../src/inbox/protocol.mjs';
import { databaseOptions, inboxUrl, parseInboxConfig } from '../src/inbox/config.mjs';
import { processWork } from '../src/inbox/processor.mjs';
import { fixture, cid } from './runtime-fixture.mjs';

test('job signature binds request identity, target, deadline, and message; status can read expired jobs', async () => {
    const wallet = Wallet.createRandom();
    const job = await signJob(wallet, 'test', 'signed content');
    const options = { target: 'test', allowedSigners: [wallet.address] };
    await validateJob(job, options);
    for (const altered of [{ ...job, requestId: crypto.randomUUID() }, { ...job, expiresAt: job.expiresAt + 1 },
        { ...job, target: 'other' }, { ...job, message: { ...job.message, text: 'changed' } }]) {
        await assert.rejects(validateJob(altered, options), { code: 'invalid_signed_job' });
    }
    await assert.rejects(validateJob(job, { ...options, now: job.expiresAt }), { code: 'invalid_job_expiry' });
    await validateJob(job, { ...options, checkExpiry: false, now: job.expiresAt });
    await assert.rejects(validateJob(job, { ...options, allowedSigners: [Wallet.createRandom().address] }));
    assert.equal(digest({ a: 1, b: { c: 2, d: 3 } }), digest({ b: { d: 3, c: 2 }, a: 1 }));
});

test('remote inbox requires HTTPS and database URL cannot override verified TLS', async () => {
    for (const url of ['http://example.com', 'https://secret@example.com', 'https://example.com/path', 'https://example.com?secret=x']) {
        assert.throws(() => inboxUrl(url));
    }
    assert.equal(inboxUrl('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
    const config = parseInboxConfig({ target: 'test', allowedSigners: [Wallet.createRandom().address], execution: { mode: 'ipfs' } });
    const options = await databaseOptions(config, { databaseUrl: 'postgres://test:placeholder@localhost/test' });
    assert.deepEqual(options.ssl, { rejectUnauthorized: true });
    await assert.rejects(databaseOptions(config, { databaseUrl: 'postgres://localhost/test?sslmode=no-verify' }));
});

test('IPFS work reuses committed publication and verifies signatures locally', async t => {
    const f = await fixture(t);
    const job = await signJob(f.agent, 'test', 'ipfs content');
    const work = { job, requestId: job.requestId, checkpoint: { cid, transaction: null } };
    const config = { ...f.config, mode: 'ipfs' };
    assert.deepEqual(await processWork({ work, config, target: 'test', allowedSigners: [f.agent.address],
        fetch: f.transport, save: () => { throw new Error('Must not publish again'); } }), { status: 'published', cid });
    assert.equal(f.state.uploads, 0);
    await assert.rejects(processWork({ work: { ...work, job: { ...job, target: 'other' } }, config,
        target: 'test', allowedSigners: [f.agent.address], fetch: f.transport, save: () => {} }));
});

test('Ledger never broadcasts when transaction checkpoint acknowledgement is lost', async t => {
    const f = await fixture(t);
    const job = await signJob(f.agent, 'test', 'ledger content');
    let checkpoint = {};
    await assert.rejects(processWork({ work: { job, requestId: job.requestId, checkpoint: {} }, config: f.config,
        target: 'test', allowedSigners: [f.agent.address], signer: f.signer, fetch: f.transport,
        save: async change => { checkpoint = { ...checkpoint, ...change }; if (change.transaction) throw new Error('lost ack'); } }));
    assert.equal(f.state.sends, 0);
    assert.equal(f.state.signs, 1);
    const result = await processWork({ work: { job, requestId: job.requestId, checkpoint }, config: f.config,
        target: 'test', allowedSigners: [f.agent.address], signer: f.signer, fetch: f.transport,
        save: () => { throw new Error('No new checkpoints expected'); } });
    assert.equal(result.status, 'logged');
    assert.equal(result.transactionHash, checkpoint.transaction.transactionHash);
    assert.equal(f.state.signs, 1);
    assert.equal(f.state.uploads, 1);
    assert.equal(executionIdentity(f.config, f.signer.address).nodeAddress, f.signer.address.toLowerCase());
});
