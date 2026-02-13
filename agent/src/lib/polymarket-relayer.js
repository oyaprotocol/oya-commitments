import crypto from 'node:crypto';
import { encodePacked, getAddress, hashTypedData, isHex, keccak256, parseAbi } from 'viem';
import { normalizeAddressOrNull, normalizeHashOrNull } from './utils.js';

const DEFAULT_RELAYER_HOST = 'https://relayer-v2.polymarket.com';
const DEFAULT_RELAYER_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RELAYER_POLL_INTERVAL_MS = 2_000;
const DEFAULT_RELAYER_POLL_TIMEOUT_MS = 120_000;
const SAFE_TX_NONCE_ABI = parseAbi(['function nonce() view returns (uint256)']);
const SAFE_EIP712_TYPES = Object.freeze({
    EIP712Domain: [
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
    ],
    SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'nonce', type: 'uint256' },
    ],
});
const RELAYER_TX_TYPE = Object.freeze({
    SAFE: 'SAFE',
    PROXY: 'PROXY',
});
const RELAYER_SUCCESS_STATUSES = new Set(['MINED', 'CONFIRMED']);
const RELAYER_FAILURE_STATUSES = new Set(['FAILED', 'REVERTED']);

function normalizeNonNegativeInteger(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.floor(parsed);
}

function normalizeRelayerHost(host) {
    return (host ?? DEFAULT_RELAYER_HOST).replace(/\/+$/, '');
}

function normalizeRelayerTxType(value) {
    if (typeof value !== 'string') {
        return RELAYER_TX_TYPE.SAFE;
    }
    const normalized = value.trim().toUpperCase();
    if (normalized === RELAYER_TX_TYPE.PROXY) return RELAYER_TX_TYPE.PROXY;
    return RELAYER_TX_TYPE.SAFE;
}

function normalizeHexData(data) {
    if (!data) return '0x';
    if (typeof data !== 'string' || !isHex(data)) {
        throw new Error('Relayer transaction data must be a hex string.');
    }
    return data;
}

function getBuilderCredentials(config) {
    const apiKey =
        config?.polymarketBuilderApiKey ??
        config?.polymarketApiKey ??
        config?.polymarketClobApiKey;
    const secret =
        config?.polymarketBuilderSecret ??
        config?.polymarketApiSecret ??
        config?.polymarketClobApiSecret;
    const passphrase =
        config?.polymarketBuilderPassphrase ??
        config?.polymarketApiPassphrase ??
        config?.polymarketClobApiPassphrase;
    return { apiKey, secret, passphrase };
}

function buildRelayerAuthHeaders({
    config,
    method,
    path,
    bodyText,
}) {
    const { apiKey, secret, passphrase } = getBuilderCredentials(config);
    if (!apiKey || !secret || !passphrase) {
        throw new Error(
            'Missing Polymarket builder credentials. Set POLYMARKET_BUILDER_API_KEY/POLYMARKET_BUILDER_SECRET/POLYMARKET_BUILDER_PASSPHRASE (or POLYMARKET_API_* / POLYMARKET_CLOB_* fallbacks).'
        );
    }

    const timestamp = Date.now().toString();
    const payload = `${timestamp}${method.toUpperCase()}${path}${bodyText ?? ''}`;
    const secretBytes = Buffer.from(secret, 'base64');
    const signature = crypto
        .createHmac('sha256', secretBytes)
        .update(payload)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

    return {
        POLY_BUILDER_API_KEY: apiKey,
        POLY_BUILDER_SIGNATURE: signature,
        POLY_BUILDER_TIMESTAMP: timestamp,
        POLY_BUILDER_PASSPHRASE: passphrase,
    };
}

async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function relayerRequest({
    config,
    method,
    path,
    body,
}) {
    const host = normalizeRelayerHost(config?.polymarketRelayerHost);
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const timeoutMs = normalizeNonNegativeInteger(
        config?.polymarketRelayerRequestTimeoutMs,
        DEFAULT_RELAYER_REQUEST_TIMEOUT_MS
    );
    const headers = {
        'Content-Type': 'application/json',
        ...buildRelayerAuthHeaders({
            config,
            method,
            path,
            bodyText,
        }),
    };

    const response = await fetch(`${host}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : bodyText,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch (error) {
        parsed = { raw: text };
    }

    if (!response.ok) {
        throw new Error(
            `Relayer request failed (${method} ${path}): ${response.status} ${response.statusText} ${text}`
        );
    }

    return parsed;
}

function collectPayloadObjects(payload) {
    const out = [];
    const seen = new Set();
    const queue = [payload];

    while (queue.length > 0 && out.length < 24) {
        const current = queue.shift();
        if (!current || typeof current !== 'object') continue;
        if (seen.has(current)) continue;
        seen.add(current);
        out.push(current);

        for (const value of Object.values(current)) {
            if (value && typeof value === 'object') {
                queue.push(value);
            }
        }
    }

    return out;
}

function extractStringField(payload, fieldNames) {
    const candidates = collectPayloadObjects(payload);
    for (const candidate of candidates) {
        for (const fieldName of fieldNames) {
            const value = candidate?.[fieldName];
            if (typeof value === 'string' && value.trim().length > 0) {
                return value.trim();
            }
            if (typeof value === 'number' && Number.isFinite(value)) {
                return String(value);
            }
            if (typeof value === 'bigint') {
                return value.toString();
            }
        }
    }
    return null;
}

function extractRelayerTxHash(payload) {
    const hashCandidate = extractStringField(payload, [
        'txHash',
        'relayTxHash',
        'relay_hash',
        'hash',
    ]);
    const normalized = normalizeHashOrNull(hashCandidate);
    return normalized;
}

function extractTransactionHash(payload) {
    const hashCandidate = extractStringField(payload, [
        'transactionHash',
        'transaction_hash',
        'chainTxHash',
    ]);
    return normalizeHashOrNull(hashCandidate);
}

function extractRelayerStatus(payload) {
    const statusCandidate = extractStringField(payload, ['status', 'txStatus', 'state']);
    if (!statusCandidate) return null;
    return statusCandidate.toUpperCase();
}

function isPolymarketRelayerEnabled(config) {
    return Boolean(config?.polymarketRelayerEnabled);
}

async function getRelayerProxyAddress({
    config,
    signerAddress,
}) {
    const response = await relayerRequest({
        config,
        method: 'GET',
        path: `/relayer/proxy-address/${encodeURIComponent(getAddress(signerAddress))}`,
    });
    const candidate = extractStringField(response, [
        'proxyWallet',
        'proxyAddress',
        'walletAddress',
        'address',
    ]);
    const normalized = normalizeAddressOrNull(candidate);
    return normalized ? getAddress(normalized) : null;
}

async function getSafeNonce({
    publicClient,
    safeAddress,
}) {
    return publicClient.readContract({
        address: getAddress(safeAddress),
        abi: SAFE_TX_NONCE_ABI,
        functionName: 'nonce',
    });
}

async function getProxyNonce({
    config,
    proxyAddress,
}) {
    const response = await relayerRequest({
        config,
        method: 'GET',
        path: `/relayer/proxy-nonce/${encodeURIComponent(getAddress(proxyAddress))}`,
    });
    const nonceCandidate = extractStringField(response, ['nonce']);
    if (nonceCandidate === null) {
        throw new Error('Relayer proxy nonce response did not include nonce.');
    }
    return BigInt(nonceCandidate);
}

async function createProxyWallet({
    config,
    signerAddress,
    chainId,
    txType,
}) {
    return relayerRequest({
        config,
        method: 'POST',
        path: '/relayer/create-proxy-wallet',
        body: {
            from: getAddress(signerAddress),
            chainId: Number(chainId),
            relayerTxType: txType,
        },
    });
}

async function waitForRelayerTransaction({
    config,
    txHash,
}) {
    const normalizedTxHash = normalizeHashOrNull(txHash);
    if (!normalizedTxHash) {
        throw new Error(`Invalid relayer txHash: ${txHash}`);
    }
    const pollIntervalMs = normalizeNonNegativeInteger(
        config?.polymarketRelayerPollIntervalMs,
        DEFAULT_RELAYER_POLL_INTERVAL_MS
    );
    const timeoutMs = normalizeNonNegativeInteger(
        config?.polymarketRelayerPollTimeoutMs,
        DEFAULT_RELAYER_POLL_TIMEOUT_MS
    );
    const deadline = Date.now() + timeoutMs;
    let lastPayload = null;

    while (Date.now() <= deadline) {
        lastPayload = await relayerRequest({
            config,
            method: 'GET',
            path: `/relayer/transaction-status/${encodeURIComponent(normalizedTxHash)}`,
        });
        const status = extractRelayerStatus(lastPayload);
        if (status && RELAYER_SUCCESS_STATUSES.has(status)) {
            return lastPayload;
        }
        if (status && RELAYER_FAILURE_STATUSES.has(status)) {
            throw new Error(
                `Relayer transaction failed with status=${status} for txHash=${normalizedTxHash}.`
            );
        }
        await sleep(pollIntervalMs);
    }

    throw new Error(
        `Timed out waiting for relayer transaction ${normalizedTxHash}. Last payload: ${JSON.stringify(
            lastPayload
        )}`
    );
}

async function signSafeTransaction({
    walletClient,
    account,
    chainId,
    fromAddress,
    toAddress,
    value,
    data,
    operation,
    nonce,
}) {
    if (!walletClient || typeof walletClient.signMessage !== 'function') {
        throw new Error(
            'Runtime signer does not support signMessage; cannot sign SAFE relayer transaction.'
        );
    }
    if (!Number.isInteger(operation) || operation < 0 || operation > 1) {
        throw new Error('SAFE relayer transaction operation must be 0 or 1.');
    }

    const txHash = hashTypedData({
        domain: {
            chainId: Number(chainId),
            verifyingContract: getAddress(fromAddress),
        },
        primaryType: 'SafeTx',
        types: SAFE_EIP712_TYPES,
        message: {
            to: getAddress(toAddress),
            value: BigInt(value),
            data: normalizeHexData(data),
            operation,
            nonce: BigInt(nonce),
        },
    });
    const signature = await walletClient.signMessage({
        account,
        message: { raw: txHash },
    });

    return {
        txHash,
        signature,
        signatureParams: {
            to: getAddress(toAddress),
            value: BigInt(value).toString(),
            data: normalizeHexData(data),
            operation,
            nonce: BigInt(nonce).toString(),
        },
    };
}

async function signProxyTransaction({
    walletClient,
    account,
    chainId,
    fromAddress,
    toAddress,
    data,
    nonce,
}) {
    if (!walletClient || typeof walletClient.signMessage !== 'function') {
        throw new Error(
            'Runtime signer does not support signMessage; cannot sign PROXY relayer transaction.'
        );
    }

    const encoded = encodePacked(
        ['uint256', 'address', 'address', 'bytes', 'uint256'],
        [
            BigInt(chainId),
            getAddress(fromAddress),
            getAddress(toAddress),
            normalizeHexData(data),
            BigInt(nonce),
        ]
    );
    const txHash = keccak256(encoded);
    const signature = await walletClient.signMessage({
        account,
        message: { raw: txHash },
    });

    return {
        txHash,
        signature,
        signatureParams: {
            from: getAddress(fromAddress),
            to: getAddress(toAddress),
            data: normalizeHexData(data),
            nonce: BigInt(nonce).toString(),
            chainId: Number(chainId),
        },
    };
}

async function resolveFromAddress({
    config,
    explicitFrom,
    accountAddress,
    chainId,
    txType,
}) {
    if (explicitFrom) {
        return getAddress(explicitFrom);
    }
    if (config?.polymarketRelayerFromAddress) {
        return getAddress(config.polymarketRelayerFromAddress);
    }
    if (config?.polymarketClobAddress) {
        return getAddress(config.polymarketClobAddress);
    }

    const resolveProxyAddress = config?.polymarketRelayerResolveProxyAddress !== false;
    if (resolveProxyAddress) {
        try {
            const existingProxy = await getRelayerProxyAddress({
                config,
                signerAddress: accountAddress,
            });
            if (existingProxy) {
                return existingProxy;
            }
        } catch (error) {
            // Continue to optional deployment/fallback.
        }
    }

    if (config?.polymarketRelayerAutoDeployProxy) {
        const deployResponse = await createProxyWallet({
            config,
            signerAddress: accountAddress,
            chainId,
            txType,
        });
        const deployTxHash = extractRelayerTxHash(deployResponse);
        if (!deployTxHash) {
            throw new Error('Relayer proxy deployment did not return txHash.');
        }
        await waitForRelayerTransaction({
            config,
            txHash: deployTxHash,
        });
        const deployedProxy = await getRelayerProxyAddress({
            config,
            signerAddress: accountAddress,
        });
        if (deployedProxy) {
            return deployedProxy;
        }
    }

    return null;
}

async function relayPolymarketTransaction({
    publicClient,
    walletClient,
    account,
    config,
    from,
    to,
    data,
    value = 0n,
    operation = 0,
    nonce,
    metadata,
}) {
    if (!isPolymarketRelayerEnabled(config)) {
        throw new Error('Polymarket relayer is disabled (POLYMARKET_RELAYER_ENABLED=false).');
    }
    if (!publicClient) {
        throw new Error('publicClient is required for relayer transaction submission.');
    }
    if (!walletClient) {
        throw new Error('walletClient is required for relayer transaction submission.');
    }
    const runtimeAddress = getAddress(account?.address);
    const chainId = Number(
        config?.polymarketRelayerChainId ??
            (typeof publicClient.getChainId === 'function'
                ? await publicClient.getChainId()
                : undefined)
    );
    if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new Error(
            'Unable to resolve chainId for relayer transaction. Set POLYMARKET_RELAYER_CHAIN_ID.'
        );
    }

    const txType = normalizeRelayerTxType(config?.polymarketRelayerTxType);
    const fromAddress = await resolveFromAddress({
        config,
        explicitFrom: from,
        accountAddress: runtimeAddress,
        chainId,
        txType,
    });
    if (!fromAddress) {
        throw new Error(
            'Unable to resolve relayer wallet address. Set POLYMARKET_RELAYER_FROM_ADDRESS or POLYMARKET_CLOB_ADDRESS, or enable POLYMARKET_RELAYER_AUTO_DEPLOY_PROXY.'
        );
    }

    const normalizedTo = getAddress(to);
    const normalizedData = normalizeHexData(data);
    const normalizedValue = BigInt(value ?? 0n);
    const normalizedOperation = Number(operation ?? 0);
    let normalizedNonce;
    if (nonce === undefined || nonce === null) {
        if (txType === RELAYER_TX_TYPE.SAFE) {
            try {
                normalizedNonce = await getSafeNonce({
                    publicClient,
                    safeAddress: fromAddress,
                });
            } catch (error) {
                const reason = error?.shortMessage ?? error?.message ?? String(error);
                throw new Error(
                    `Failed to read SAFE nonce from ${fromAddress}. Ensure POLYMARKET_RELAYER_FROM_ADDRESS points to a deployed Safe proxy on chainId=${chainId}. ${reason}`
                );
            }
        } else {
            normalizedNonce = await getProxyNonce({
                config,
                proxyAddress: fromAddress,
            });
        }
    } else {
        normalizedNonce = BigInt(nonce);
    }

    const signed =
        txType === RELAYER_TX_TYPE.SAFE
            ? await signSafeTransaction({
                walletClient,
                account,
                chainId,
                fromAddress,
                toAddress: normalizedTo,
                value: normalizedValue,
                data: normalizedData,
                operation: normalizedOperation,
                nonce: normalizedNonce,
            })
            : await signProxyTransaction({
                walletClient,
                account,
                chainId,
                fromAddress,
                toAddress: normalizedTo,
                data: normalizedData,
                nonce: normalizedNonce,
            });

    const txRequest = {
        type: txType,
        from: fromAddress,
        to: normalizedTo,
        data: normalizedData,
        value: normalizedValue.toString(),
        nonce: normalizedNonce.toString(),
    };
    if (txType === RELAYER_TX_TYPE.SAFE) {
        txRequest.operation = normalizedOperation;
    }

    const submitResponse = await relayerRequest({
        config,
        method: 'POST',
        path: '/relayer/transaction',
        body: {
            ...txRequest,
            txHash: signed.txHash,
            signature: signed.signature,
            signatureParams: signed.signatureParams,
            metadata,
        },
    });

    const relayTxHash = extractRelayerTxHash(submitResponse) ?? normalizeHashOrNull(signed.txHash);
    if (!relayTxHash) {
        throw new Error('Relayer submission did not return txHash.');
    }

    const statusResponse = await waitForRelayerTransaction({
        config,
        txHash: relayTxHash,
    });
    const status = extractRelayerStatus(statusResponse);
    let transactionHash = extractTransactionHash(statusResponse);
    if (!transactionHash) {
        try {
            await publicClient.getTransactionReceipt({ hash: relayTxHash });
            transactionHash = relayTxHash;
        } catch (error) {
            // Relay tx hash is not necessarily the chain tx hash.
        }
    }

    if (!transactionHash) {
        throw new Error(
            `Relayer transaction ${relayTxHash} reached status=${status ?? 'unknown'} without transactionHash.`
        );
    }

    return {
        relayTxHash,
        transactionHash,
        status,
        from: fromAddress,
        txType,
        nonce: normalizedNonce.toString(),
        submitResponse,
        statusResponse,
    };
}

export {
    RELAYER_TX_TYPE,
    getRelayerProxyAddress,
    isPolymarketRelayerEnabled,
    relayPolymarketTransaction,
};
