import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Wallet } from 'ethers';
import { signJob, validateJob } from '../src/inbox/protocol.mjs';
import { main } from '../src/inbox/client.mjs';

const now = 1_800_000_000_000;
const week = 604_800_000;
const cli = fileURLToPath(new URL('../src/inbox/client.mjs', import.meta.url));

test('new jobs default to exactly seven days and preserve explicit older deadlines', async t => {
    t.mock.method(Date, 'now', () => now);
    const wallet = Wallet.createRandom();
    const options = { target: 'test', allowedSigners: [wallet.address], now };
    const job = await signJob(wallet, 'test', 'offline for several days');
    assert.equal(job.expiresAt, now + week);
    await validateJob(job, options);
    await validateJob(job, { ...options, now: now + 2 * 86400_000 });
    for (const lifetime of [1, 86400_000, week]) {
        const explicit = await signJob(wallet, 'test', 'explicit lifetime', { expiresAt: now + lifetime });
        assert.equal(explicit.expiresAt, now + lifetime);
        await validateJob(explicit, options);
    }
    await assert.rejects(validateJob({ ...job, expiresAt: job.expiresAt + 1 }, options), { code: 'invalid_signed_job' });
    const tooLong = await signJob(wallet, 'test', 'over maximum', { expiresAt: now + week + 1 });
    await assert.rejects(validateJob(tooLong, options), { code: 'invalid_job_expiry' });
    // A sender ahead of the server must use a shorter deadline, not a relaxed maximum.
    await assert.rejects(validateJob(job, { ...options, now: now - 1 }), { code: 'invalid_job_expiry' });
    for (const clock of [job.expiresAt, job.expiresAt + week]) {
        await assert.rejects(validateJob(job, { ...options, now: clock }), { code: 'invalid_job_expiry' });
        await validateJob(job, { ...options, now: clock, checkExpiry: false });
    }
});

test('prepare CLI saves and reports exact default, shorter and boundary deadlines', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'oya-lifetime-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const wallet = Wallet.createRandom();
    const key = join(dir, 'key');
    const text = join(dir, 'message');
    const clock = join(dir, 'clock.mjs');
    await writeFile(key, wallet.privateKey, { mode: 0o600 });
    await writeFile(text, 'queued while the laptop sleeps\n');
    await writeFile(clock, `Date.now = () => ${now};\n`);
    for (const [label, extra, duration] of [
        ['default', [], week], ['short', ['--expires-in', '3600'], 3_600_000],
        ['minimum', ['--expires-in', '1'], 1000], ['maximum', ['--expires-in', '604800'], week],
    ]) {
        const file = join(dir, `${label}.json`);
        const args = ['--import', clock, cli, 'prepare', key, 'test', text, file, ...extra];
        const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        const bytes = await readFile(file);
        const job = JSON.parse(bytes);
        assert.equal(job.expiresAt, now + duration);
        assert.deepEqual(JSON.parse(result.stdout), { requestId: job.requestId, expiresAt: job.expiresAt });
        await validateJob(job, { target: 'test', allowedSigners: [wallet.address], now });
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        const repeated = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
        assert.equal(repeated.status, 1);
        assert.deepEqual(await readFile(file), bytes, 'existing signed job stays byte-identical');
    }
});

test('prepare rejects invalid lifetime options before opening a signing key or writing output', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'oya-lifetime-invalid-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const args = ['prepare', join(dir, 'absent-private-key'), 'test', join(dir, 'absent-text'), join(dir, 'job')];
    for (const value of ['0', '-1', '604801', '1.5', '1e3', '+1', '01', ' 1', '1\n', 'Infinity', '9'.repeat(200), '']) {
        await assert.rejects(main([...args, '--expires-in', value]), /expires-in/);
    }
    for (const extra of [['--expires-in'], ['--expires-in', '1', '--expires-in', '2'], ['--unknown', '1']]) {
        await assert.rejects(main([...args, ...extra]), /Usage|expires-in/);
    }
    assert.deepEqual(await readdir(dir), []);
});
