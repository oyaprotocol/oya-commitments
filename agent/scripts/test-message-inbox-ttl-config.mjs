import assert from 'node:assert/strict';
import { createMessageInbox } from '../src/lib/message-inbox.js';

async function run() {
    assert.throws(
        () =>
            createMessageInbox({
                defaultTtlSeconds: 60,
                minTtlSeconds: 120,
                maxTtlSeconds: 600,
            }),
        /defaultTtlSeconds must be between minTtlSeconds \(120\) and maxTtlSeconds \(600\); received 60/
    );

    assert.throws(
        () =>
            createMessageInbox({
                defaultTtlSeconds: 900,
                minTtlSeconds: 30,
                maxTtlSeconds: 600,
            }),
        /defaultTtlSeconds must be between minTtlSeconds \(30\) and maxTtlSeconds \(600\); received 900/
    );

    assert.doesNotThrow(() =>
        createMessageInbox({
            defaultTtlSeconds: 300,
            minTtlSeconds: 30,
            maxTtlSeconds: 600,
        })
    );

    console.log('[test] message inbox ttl config OK');
}

run().catch((error) => {
    console.error('[test] message inbox ttl config failed:', error?.message ?? error);
    process.exit(1);
});
