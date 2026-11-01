import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Wallet } from 'ethers';
import { validateJob } from '../src/inbox/protocol.mjs';

const client = fileURLToPath(new URL('../src/inbox/client.mjs', import.meta.url));

test('inbox prepare rejects unsupported text before creating a signed job', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oya-inbox-client-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const wallet = Wallet.createRandom();
    const key = join(directory, 'key');
    const textFile = join(directory, 'message');
    const jobFile = join(directory, 'job.json');
    await writeFile(key, wallet.privateKey + '\n', { mode: 0o600 });
    for (const [name, text] of [
        ['empty', ''], ['non-ASCII', 'café'], ['invalid UTF-8', Buffer.from([0xff])],
        ['oversized', 'a'.repeat(8193)],
    ]) {
        await t.test(name, async () => {
            await writeFile(textFile, text);
            const result = spawnSync(process.execPath, [client, 'prepare', key, 'test', textFile, jobFile], { encoding: 'utf8' });
            assert.equal(result.status, 1);
            assert.equal(result.stdout, '');
            await assert.rejects(stat(jobFile), { code: 'ENOENT' });
        });
        // Keep subtests independent even if the unfixed client wrote a job.
        await rm(jobFile, { force: true });
    }
    await t.test('valid ASCII at the byte limit preserves exact text and signatures', async () => {
        const text = 'a'.repeat(8189) + '\r\n\t';
        await writeFile(textFile, text);
        const result = spawnSync(process.execPath, [client, 'prepare', key, 'test', textFile, jobFile], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const job = JSON.parse(await readFile(jobFile, 'utf8'));
        assert.equal(job.message.text, text);
        await validateJob(job, { target: 'test', allowedSigners: [wallet.address] });
        assert.equal((await stat(jobFile)).mode & 0o777, 0o600);
    });
});
