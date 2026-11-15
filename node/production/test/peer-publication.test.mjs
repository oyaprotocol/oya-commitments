import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet, verifyMessage } from 'ethers';
import { publicationSigners } from '../src/peers/config.mjs';
import { signJob, validateJob, jobText } from '../src/inbox/protocol.mjs';
import { processWork } from '../src/inbox/processor.mjs';
import { fixture } from './runtime-fixture.mjs';

async function setup(t) {
    const f = await fixture(t);
    const job = await signJob(f.agent, 'test', ' exact peer text\n');
    const envelope = job;
    const peers = { members: [f.agent.address.toLowerCase()] };
    const allowedSigners = publicationSigners([], peers);
    let checkpoint = {};
    let uploaded;
    const fetch = async (url, request) => {
        if (url.startsWith(f.config.ipfs.url)) {
            uploaded = JSON.parse(await request.body.get('file').text());
        }
        return f.transport(url, request);
    };
    const save = async change => { checkpoint = { ...checkpoint, ...change }; };
    const options = () => ({ work: { job, requestId: job.requestId, checkpoint: structuredClone(checkpoint) },
        config: f.config, target: 'test', allowedSigners, signer: f.signer, fetch, save });
    return { f, envelope, peers, job, options, run: () => processWork(options()),
        checkpoint: () => structuredClone(checkpoint), uploaded: () => uploaded };
}

test('peer message is an ordinary signed job and IPFS preserves its original signed object', async t => {
    const s = await setup(t);
    assert.deepEqual(await validateJob(s.job, { target: 'test', allowedSigners: s.options().allowedSigners }), s.job);
    assert.equal((await s.run()).status, 'logged');
    assert.deepEqual(s.uploaded(), s.envelope.message);
    assert.equal(verifyMessage(s.uploaded().text, s.uploaded().signature), s.f.agent.address);
    assert.equal(s.f.state.signs, 1);
});

test('ordinary job signature cannot hide forged inner signatures', async t => {
    const s = await setup(t);
    const other = Wallet.createRandom();
    for (const changes of [
        { message: { ...s.envelope.message, text: 'forged' } },
        { message: { ...s.envelope.message, signer: other.address } },
        { message: { ...s.envelope.message, signature: await other.signMessage(s.envelope.message.text) } },
        { message: { ...s.envelope.message, extra: true } },
        { requestSignature: s.envelope.message.signature },
    ]) {
        const value = { ...s.envelope, ...changes };
        if (changes.message) value.requestSignature = await s.f.agent.signMessage(jobText(value));
        await assert.rejects(validateJob(value, { target: 'test', allowedSigners: s.options().allowedSigners }), { code: 'invalid_signed_job' });
    }
    assert.equal(s.f.state.uploads, 0);
    assert.equal(s.f.state.signs, 0);
});

test('registry union treats every member ordinarily and does not mutate local authorization', async t => {
    const s = await setup(t);
    const local = [Wallet.createRandom().address];
    const before = [...local];
    const peers = { members: [...s.peers.members, s.f.wallet.address.toLowerCase(), ...s.peers.members] };
    assert.deepEqual(publicationSigners(local, peers), [local[0].toLowerCase(), s.f.agent.address.toLowerCase(), s.f.wallet.address.toLowerCase()]);
    assert.deepEqual(local, before);
    assert.deepEqual(publicationSigners(local, undefined), [local[0].toLowerCase()]);
    const legacyGrants = ['0x' + '0'.repeat(40), '0x' + 'aB'.repeat(20)];
    assert.deepEqual(publicationSigners(legacyGrants, undefined), legacyGrants.map(value => value.toLowerCase()));
    const options = s.options();
    options.allowedSigners = publicationSigners(local, { ...peers, members: [] });
    await assert.rejects(processWork(options));
    assert.equal(s.f.state.uploads, 0);
    assert.equal(s.f.state.signs, 0);
});

for (const failure of ['ipfs', 'prepare', 'sign', 'cid-checkpoint', 'transaction-checkpoint']) {
    test(`peer ${failure} failure never broadcasts and retries through ordinary checkpoints`, async t => {
        const s = await setup(t);
        const options = s.options();
        if (failure === 'ipfs') s.f.state.ipfsFailure = true;
        if (failure === 'prepare') s.f.state.preparationFailure = true;
        if (failure === 'sign') options.signer = { address: s.f.signer.address, signTransaction: async () => { throw new Error('signing failed'); } };
        const save = options.save;
        options.save = async change => {
            if ((failure === 'cid-checkpoint' && change.cid) || (failure === 'transaction-checkpoint' && change.transaction)) {
                // Durable write with lost acknowledgement: resume what was actually saved.
                await save(change);
                throw new Error('checkpoint acknowledgement lost');
            }
            await save(change);
        };
        await assert.rejects(processWork(options));
        assert.equal(s.f.state.sends, 0);
        if (['ipfs', 'prepare', 'sign', 'cid-checkpoint'].includes(failure)) assert.equal(s.f.state.signs, 0);
        const checkpoint = s.checkpoint();
        s.f.state.ipfsFailure = false;
        s.f.state.preparationFailure = false;
        const result = await s.run();
        assert.equal(result.status, 'logged');
        assert.deepEqual(s.uploaded(), s.envelope.message);
        if (checkpoint.transaction) {
            assert.equal(result.transactionHash, checkpoint.transaction.transactionHash);
            assert.equal(s.f.state.signs, 1);
        }
    });
}

test('peer broadcast failure and receipt timeout resume same signed transaction', async t => {
    const s = await setup(t);
    s.f.config.receiptTimeoutMs = 20;
    s.f.state.sendFailure = true;
    s.f.state.receiptMode = 'pending';
    await assert.rejects(s.run());
    const checkpoint = s.checkpoint();
    assert.equal(s.f.state.sends, 1);
    s.f.state.receiptMode = 'mined';
    const result = await s.run();
    assert.equal(result.transactionHash, checkpoint.transaction.transactionHash);
    assert.equal(s.f.state.signs, 1);
    assert.equal(s.f.state.uploads, 1);
    assert.equal(s.f.state.sends, 1);
});

for (const mode of ['reverted', 'malformed']) {
    test(`peer ${mode} receipt is not reported as logged`, async t => {
        const s = await setup(t);
        s.f.state.receiptMode = mode;
        if (mode === 'reverted') assert.equal((await s.run()).status, 'failed');
        else await assert.rejects(s.run());
        assert.equal(s.f.state.signs, 1);
        assert.equal(s.f.state.uploads, 1);
    });
}
