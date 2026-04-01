import { createPublicClient, http } from 'viem';
import { createSignerClient } from './signer.js';

function normalizeChainId(value, label = 'chainId') {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

async function resolveWalletClientChainId(walletClient) {
    if (!walletClient) {
        return null;
    }

    if (typeof walletClient.getChainId === 'function') {
        return normalizeChainId(await walletClient.getChainId(), 'wallet signer chainId');
    }

    if (typeof walletClient.request === 'function') {
        return normalizeChainId(
            await walletClient.request({ method: 'eth_chainId' }),
            'wallet signer chainId'
        );
    }

    throw new Error('walletClient must expose getChainId() or request({ method: "eth_chainId" }).');
}

async function assertExpectedRuntimeChain({
    expectedChainId,
    publicClient,
    walletClient = undefined,
    buildError = (message) => new Error(message),
    publicClientLabel = 'Resolved rpcUrl',
    signerClientLabel = 'Resolved signer runtime',
} = {}) {
    const normalizedExpectedChainId = normalizeChainId(expectedChainId, 'expected chainId');
    const publicChainId = normalizeChainId(
        await publicClient.getChainId(),
        'public client chainId'
    );
    if (publicChainId !== normalizedExpectedChainId) {
        throw buildError(
            `${publicClientLabel} for chainId ${normalizedExpectedChainId} is connected to chainId ${publicChainId}.`
        );
    }

    if (!walletClient) {
        return {
            publicChainId,
            signerChainId: null,
        };
    }

    const signerChainId = await resolveWalletClientChainId(walletClient);
    if (signerChainId !== normalizedExpectedChainId) {
        throw buildError(
            `${signerClientLabel} for chainId ${normalizedExpectedChainId} is connected to chainId ${signerChainId}.`
        );
    }

    return {
        publicChainId,
        signerChainId,
    };
}

async function createValidatedReadWriteRuntime({
    rpcUrl,
    expectedChainId = undefined,
    buildError = (message) => new Error(message),
    publicClientLabel = 'Resolved rpcUrl',
    signerClientLabel = 'Resolved signer runtime',
    createPublicClientFn = createPublicClient,
    createSignerClientFn = createSignerClient,
    httpTransportFn = http,
} = {}) {
    if (typeof rpcUrl !== 'string' || !rpcUrl.trim()) {
        throw new Error('rpcUrl must be a non-empty string.');
    }

    const publicClient = createPublicClientFn({
        transport: httpTransportFn(rpcUrl),
    });
    const { account, walletClient } = await createSignerClientFn({ rpcUrl });
    const publicChainId = normalizeChainId(
        await publicClient.getChainId(),
        'public client chainId'
    );
    const normalizedExpectedChainId =
        expectedChainId === undefined || expectedChainId === null
            ? publicChainId
            : normalizeChainId(expectedChainId, 'expected chainId');
    if (publicChainId !== normalizedExpectedChainId) {
        throw buildError(
            `${publicClientLabel} for chainId ${normalizedExpectedChainId} is connected to chainId ${publicChainId}.`
        );
    }

    const signerChainId = await resolveWalletClientChainId(walletClient);
    if (signerChainId !== normalizedExpectedChainId) {
        throw buildError(
            `${signerClientLabel} for chainId ${normalizedExpectedChainId} is connected to chainId ${signerChainId}.`
        );
    }

    return {
        publicClient,
        account,
        walletClient,
        chainId: normalizedExpectedChainId,
        publicChainId,
        signerChainId,
    };
}

export {
    assertExpectedRuntimeChain,
    createValidatedReadWriteRuntime,
    normalizeChainId,
    resolveWalletClientChainId,
};
