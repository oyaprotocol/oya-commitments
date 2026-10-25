import assert from 'node:assert/strict';
import test from 'node:test';
import { supportsComposeVersion } from '../scripts/docker-prerequisites.mjs';

test('Docker fixtures accept Compose 2.30 and later major versions', () => {
    for (const version of ['2.30.0', 'v2.30.0', '2.31.0-desktop.2', 'v2.40.3', '3.0.0', '5.1.3', 'v5.1.3', '5.1.3+build.1\n']) {
        assert.equal(supportsComposeVersion(version), true, version);
    }
});

test('Docker fixtures reject Compose versions without raw env-file support', () => {
    for (const version of ['0.30.0', '1.29.2', 'v1.99.0', '2.9.0', '2.29.9', 'v2.29.9-desktop.1']) {
        assert.equal(supportsComposeVersion(version), false, version);
    }
});

test('Docker fixtures reject missing or malformed Compose version output', () => {
    for (const version of ['', 'unknown', 'Docker Compose version v5.1.3', '2', '2.30', '5.1.invalid', '5.1.3 unexpected']) {
        assert.equal(supportsComposeVersion(version), false, version);
    }
});
