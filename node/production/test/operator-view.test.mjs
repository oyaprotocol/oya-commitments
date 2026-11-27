import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createWorkerHealthServer } from '../src/inbox/worker.mjs';

const cli = fileURLToPath(new URL('../scripts/operator-view.mjs', import.meta.url));

test('refuses missing or invalid profiles before listening', () => {
    for (const args of [[], ['--profile', 'absent-private-profile']]) {
        const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.doesNotMatch(result.stderr, /absent-private-profile/);
    }
});

test('page refresh follows a real worker health handler from retrying to idle', { timeout: 20000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'operator-view-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = { mode: 'ipfs', operationTimeoutMs: 1000 };
    const state = { status: 'retrying', extra: '<private-sentinel>' };
    const target = 'local-worker';
    const health = createWorkerHealthServer({ config, target, state });
    let reads = 0;
    health.on('request', () => reads++);
    health.listen(0, '127.0.0.1');
    await once(health, 'listening');
    t.after(() => health.close());
    const profile = join(dir, 'operator.json');
    await writeFile(join(dir, 'node.json'), JSON.stringify(config));
    await writeFile(join(dir, 'worker.json'), JSON.stringify({ target }));
    await writeFile(profile, JSON.stringify({ version: 1, role: 'worker', nodeConfig: 'node.json', workerConfig: 'worker.json',
        healthUrl: `http://127.0.0.1:${health.address().port}/healthz` }), { mode: 0o600 });
    const child = spawn(process.execPath, [cli, '--profile', profile], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const [line] = await once(child.stdout, 'data');
    const url = line.toString().trim();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${url}other`)).status, 404);
    const [foreign] = await once(get(url, { headers: { Host: 'other.invalid' } }), 'response');
    foreign.resume();
    assert.equal(foreign.statusCode, 403);
    assert.equal(reads, 0);
    const [a, b] = await Promise.all([fetch(url), fetch(url)]);
    assert.equal(a.headers.get('cache-control'), 'no-store');
    const page = await a.text();
    assert.equal(page, await b.text());
    assert.equal(reads, 1);
    assert.match(page, /http-equiv="refresh" content="5"/);
    assert.match(page, /Worker is retrying/);
    assert.match(page, /<table><tbody>/);
    assert.match(page, /Inbox queue \(target\)<\/th><td>local-worker<\/td>/);
    for (const label of ['Reachable', 'Identity matches']) {
        assert.ok(page.includes(`${label}</th><td><span aria-hidden="true">✅</span> Yes</td>`));
    }
    assert.ok(page.includes('Healthy</th><td>No</td>'));
    assert.doesNotMatch(page, /private-sentinel|healthz|operator\.json/);
    Object.assign(state, { status: 'idle', lastPollAt: new Date().toISOString() });
    await delay(5100);
    const idle = await (await fetch(url)).text();
    assert.match(idle, /Worker is polling and idle/);
    assert.ok(idle.includes('Healthy</th><td><span aria-hidden="true">✅</span> Yes</td>'));
    assert.equal(reads, 2);
});
