import assert from 'node:assert/strict';
import { main as registerErc8004Main } from './register-erc8004.mjs';

async function run() {
    let writeContractCalled = false;
    let readFileCalled = false;
    let writeFileCalled = false;

    await assert.rejects(
        () =>
            registerErc8004Main({
                argv: ['node', 'register-erc8004.mjs', '--agent=test-agent'],
                env: {
                    RPC_URL: 'https://rpc.polygon.example',
                    AGENT_URI: 'https://example.com/agent.json',
                },
                createValidatedReadWriteRuntimeFn: async () => ({
                    publicClient: {},
                    account: { address: '0x1111111111111111111111111111111111111111' },
                    walletClient: {
                        async writeContract() {
                            writeContractCalled = true;
                            return '0xdeadbeef';
                        },
                    },
                    chainId: 137,
                }),
                resolveConfiguredChainIdForScriptFn: async () => 11155111,
                readFileFn: async () => {
                    readFileCalled = true;
                    return '{}';
                },
                writeFileFn: async () => {
                    writeFileCalled = true;
                },
            }),
        /Resolved chainId 11155111 does not match RPC_URL chainId 137/
    );
    assert.equal(writeContractCalled, false);
    assert.equal(readFileCalled, false);
    assert.equal(writeFileCalled, false);

    console.log('[test] register erc8004 OK');
}

run().catch((error) => {
    console.error('[test] register erc8004 failed:', error?.message ?? error);
    process.exit(1);
});
