import assert from 'node:assert/strict';
import { formatMessageApiBaseUrl } from './lib/testnet-harness-agent.mjs';

async function run() {
    assert.equal(formatMessageApiBaseUrl('127.0.0.1', 9888), 'http://127.0.0.1:9888');
    assert.equal(formatMessageApiBaseUrl('agent.local', 9888), 'http://agent.local:9888');
    assert.equal(formatMessageApiBaseUrl('::1', 9888), 'http://[::1]:9888');
    assert.equal(
        formatMessageApiBaseUrl('[2001:db8::1]', 9888),
        'http://[2001:db8::1]:9888'
    );

    console.log('ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
