import assert from 'node:assert/strict';
import { createValidatedReadWriteRuntime } from '../src/lib/chain-runtime.js';

async function run() {
    const observedPublicRpcUrls = [];
    const observedSignerRpcUrls = [];

    const inferredRuntime = await createValidatedReadWriteRuntime({
        rpcUrl: 'https://rpc.sepolia.example',
        createPublicClientFn: ({ transport }) => {
            observedPublicRpcUrls.push(transport.rpcUrl);
            return {
                async getChainId() {
                    return 11155111;
                },
            };
        },
        createSignerClientFn: async ({ rpcUrl }) => {
            observedSignerRpcUrls.push(rpcUrl);
            return {
                account: { address: '0x1111111111111111111111111111111111111111' },
                walletClient: {
                    async getChainId() {
                        return 11155111;
                    },
                },
            };
        },
        httpTransportFn: (rpcUrl) => ({ rpcUrl }),
    });
    assert.equal(inferredRuntime.chainId, 11155111);
    assert.equal(inferredRuntime.publicChainId, 11155111);
    assert.equal(inferredRuntime.signerChainId, 11155111);
    assert.deepEqual(observedPublicRpcUrls, ['https://rpc.sepolia.example']);
    assert.deepEqual(observedSignerRpcUrls, ['https://rpc.sepolia.example']);

    await assert.rejects(
        () =>
            createValidatedReadWriteRuntime({
                rpcUrl: 'https://rpc.bad-public.example',
                expectedChainId: 11155111,
                createPublicClientFn: () => ({
                    async getChainId() {
                        return 137;
                    },
                }),
                createSignerClientFn: async () => ({
                    account: { address: '0x1111111111111111111111111111111111111111' },
                    walletClient: {
                        async getChainId() {
                            return 11155111;
                        },
                    },
                }),
                httpTransportFn: (rpcUrl) => ({ rpcUrl }),
            }),
        /Resolved rpcUrl for chainId 11155111 is connected to chainId 137/
    );

    await assert.rejects(
        () =>
            createValidatedReadWriteRuntime({
                rpcUrl: 'https://rpc.bad-signer.example',
                expectedChainId: 11155111,
                createPublicClientFn: () => ({
                    async getChainId() {
                        return 11155111;
                    },
                }),
                createSignerClientFn: async () => ({
                    account: { address: '0x1111111111111111111111111111111111111111' },
                    walletClient: {
                        async request({ method }) {
                            assert.equal(method, 'eth_chainId');
                            return '0x89';
                        },
                    },
                }),
                httpTransportFn: (rpcUrl) => ({ rpcUrl }),
            }),
        /Resolved signer runtime for chainId 11155111 is connected to chainId 137/
    );

    console.log('[test] chain runtime OK');
}

run().catch((error) => {
    console.error('[test] chain runtime failed:', error?.message ?? error);
    process.exit(1);
});
