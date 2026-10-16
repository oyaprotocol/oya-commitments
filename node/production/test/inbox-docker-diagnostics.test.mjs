import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createFixtureRedactor } from '../scripts/inbox-docker-diagnostics.mjs';

test('Docker failure diagnostics redact credentials generated before and after setup', () => {
    const password = randomBytes(32).toString('hex');
    const secrets = [password];
    const redact = createFixtureRedactor(secrets, [['<test-directory>', '<fixture>']]);
    const workerToken = randomBytes(32).toString('base64url');
    const privateKey = `0x${randomBytes(32).toString('hex')}`;
    secrets.push(workerToken, privateKey);
    const output = redact(`postgres://oya:${password}@postgres/oya\nBearer ${workerToken}\n${privateKey}\n${password}\n<test-directory>/Caddyfile: permission denied`);
    for (const secret of secrets) assert.equal(output.includes(secret), false);
    assert.equal(output, 'postgres://oya:[redacted]@postgres/oya\nBearer [redacted]\n[redacted]\n[redacted]\n<fixture>/Caddyfile: permission denied');
});
