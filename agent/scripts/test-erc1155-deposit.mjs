import assert from 'node:assert/strict';
import {
    decodeFunctionData,
    encodeAbiParameters,
    getCreate2Address,
    keccak256,
    parseAbi,
} from 'viem';
import { makeErc1155Deposit } from '../src/lib/tx.js';

async function run() {
    const token = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
    const account = { address: '0x1111111111111111111111111111111111111111' };
    const config = { commitmentSafe: '0x2222222222222222222222222222222222222222' };

    let writeContractArgs;
    const walletClient = {
        async writeContract(args) {
            writeContractArgs = args;
            return '0xabc123';
        },
    };

    const txHash = await makeErc1155Deposit({
        walletClient,
        account,
        config,
        token,
        tokenId: '7',
        amount: '3',
        data: null,
    });

    assert.equal(txHash, '0xabc123');
    assert.equal(writeContractArgs.address.toLowerCase(), token.toLowerCase());
    assert.equal(writeContractArgs.functionName, 'safeTransferFrom');
    assert.equal(writeContractArgs.args[0].toLowerCase(), account.address.toLowerCase());
    assert.equal(writeContractArgs.args[1].toLowerCase(), config.commitmentSafe.toLowerCase());
    assert.equal(writeContractArgs.args[2], 7n);
    assert.equal(writeContractArgs.args[3], 3n);
    assert.equal(writeContractArgs.args[4], '0x');

    await assert.rejects(
        () =>
            makeErc1155Deposit({
                walletClient,
                account,
                config,
                token,
                tokenId: '7',
                amount: '0',
                data: '0x',
            }),
        /amount must be > 0/
    );

    const relayerFromAddress = getCreate2Address({
        from: '0xaacfeea03eb1561c4e67d661e40682bd20e3541b',
        salt: keccak256(
            encodeAbiParameters(
                [
                    {
                        type: 'address',
                    },
                ],
                [account.address]
            )
        ),
        bytecodeHash:
            '0xb61d27f6f0f1579b6af9d23fafd567586f35f7d2f43d6bd5f85c0b690952d469',
    });
    const relayedTxHash = `0x${'1'.repeat(64)}`;
    const onchainTxHash = `0x${'2'.repeat(64)}`;
    const relayerTransactionId = 'relayer-tx-1';
    let relayerSubmitBody;
    let relayerSubmitHeaders;
    let statusPollCount = 0;
    let sawSubmitEndpoint = false;
    const oldFetch = globalThis.fetch;
    try {
        globalThis.fetch = async (url, options = {}) => {
            const asText = String(url);
            const asLower = asText.toLowerCase();
            if (asLower.includes('/deployed?') && asLower.includes(relayerFromAddress.toLowerCase())) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({ deployed: true });
                    },
                };
            }

            if (asText.includes('/relay-payload?')) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({
                            address: relayerFromAddress,
                            nonce: '12',
                        });
                    },
                };
            }

            if (asText.endsWith('/submit')) {
                sawSubmitEndpoint = true;
                relayerSubmitBody = JSON.parse(options.body);
                relayerSubmitHeaders = options.headers;
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({
                            transactionID: relayerTransactionId,
                            hash: relayedTxHash,
                            state: 'STATE_PENDING',
                        });
                    },
                };
            }

            if (
                asText.includes('/transaction?') &&
                (asText.includes(`id=${relayerTransactionId}`) ||
                    asText.includes(`transactionID=${relayerTransactionId}`))
            ) {
                statusPollCount += 1;
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        if (statusPollCount === 1) {
                            return JSON.stringify([
                                {
                                    transactionID: relayerTransactionId,
                                    hash: relayedTxHash,
                                    state: 'STATE_PENDING',
                                },
                            ]);
                        }
                        return JSON.stringify([
                            {
                                transactionID: relayerTransactionId,
                                hash: relayedTxHash,
                                state: 'STATE_CONFIRMED',
                                transactionHash: onchainTxHash,
                            },
                        ]);
                    },
                };
            }

            throw new Error(`Unexpected relayer fetch URL: ${asText}`);
        };

        let relayerSignedMessage;
        const relayerWalletClient = {
            async signMessage({ message }) {
                relayerSignedMessage = message;
                return `0x${'a'.repeat(128)}1b`;
            },
        };

        const relayerPublicClient = {
            async getChainId() {
                return 137;
            },
            async readContract() {
                return 12n;
            },
        };

        const relayerConfig = {
            commitmentSafe: config.commitmentSafe,
            polymarketRelayerEnabled: true,
            polymarketRelayerHost: 'https://relayer-v2.polymarket.com',
            polymarketRelayerFromAddress: relayerFromAddress,
            polymarketRelayerTxType: 'SAFE',
            polymarketBuilderApiKey: 'builder-key',
            polymarketBuilderSecret: Buffer.from('builder-secret').toString('base64'),
            polymarketBuilderPassphrase: 'builder-passphrase',
            polymarketRelayerPollIntervalMs: 0,
            polymarketRelayerPollTimeoutMs: 1_000,
        };

        const relayerDepositHash = await makeErc1155Deposit({
            publicClient: relayerPublicClient,
            walletClient: relayerWalletClient,
            account,
            config: relayerConfig,
            token,
            tokenId: '7',
            amount: '3',
            data: null,
        });

        assert.equal(relayerDepositHash, onchainTxHash);
        assert.equal(sawSubmitEndpoint, true);
        assert.equal(relayerSubmitBody.type, 'SAFE');
        assert.equal(relayerSubmitBody.from.toLowerCase(), account.address.toLowerCase());
        assert.equal(relayerSubmitBody.proxyWallet.toLowerCase(), relayerFromAddress.toLowerCase());
        assert.equal(relayerSubmitBody.to.toLowerCase(), token.toLowerCase());
        assert.equal(relayerSubmitBody.nonce, '12');
        assert.equal(typeof relayerSubmitBody.signatureParams, 'object');
        assert.equal(relayerSubmitBody.signatureParams.gasPrice, '0');
        assert.equal(relayerSubmitBody.signatureParams.safeTxnGas, '0');
        assert.equal(relayerSubmitBody.signatureParams.baseGas, '0');
        assert.equal(relayerSubmitBody.signatureParams.operation, '0');
        assert.equal(typeof relayerSubmitBody.signature, 'string');
        assert.equal(typeof relayerSubmitBody.metadata, 'string');
        assert.equal(relayerSubmitBody.metadata.includes('make_erc1155_deposit'), true);
        assert.equal(relayerSubmitHeaders.POLY_BUILDER_API_KEY, 'builder-key');
        assert.equal(relayerSubmitHeaders.POLY_BUILDER_PASSPHRASE, 'builder-passphrase');
        assert.equal(typeof relayerSubmitHeaders.POLY_BUILDER_SIGNATURE, 'string');
        assert.equal(typeof relayerSubmitHeaders.POLY_BUILDER_TIMESTAMP, 'string');
        assert.ok(relayerSignedMessage?.raw);

        const decoded = decodeFunctionData({
            abi: parseAbi([
                'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
            ]),
            data: relayerSubmitBody.data,
        });
        assert.equal(decoded.functionName, 'safeTransferFrom');
        assert.equal(decoded.args[0].toLowerCase(), relayerFromAddress.toLowerCase());
        assert.equal(decoded.args[1].toLowerCase(), config.commitmentSafe.toLowerCase());
        assert.equal(decoded.args[2], 7n);
        assert.equal(decoded.args[3], 3n);
        assert.equal(decoded.args[4], '0x');
    } finally {
        globalThis.fetch = oldFetch;
    }

    const deployedUnavailableRelayTxHash = `0x${'d'.repeat(64)}`;
    const deployedUnavailableOnchainTxHash = `0x${'e'.repeat(64)}`;
    const deployedUnavailableTransactionId = 'relayer-safe-deployed-unavailable-1';
    let deployedUnavailableSubmitBody;
    let sawUnavailableDeployedCheck = false;
    const oldFetchDeployedUnavailable = globalThis.fetch;
    try {
        globalThis.fetch = async (url, options = {}) => {
            const asText = String(url);
            const asLower = asText.toLowerCase();
            if (asLower.includes('/deployed?') && asLower.includes(relayerFromAddress.toLowerCase())) {
                sawUnavailableDeployedCheck = true;
                return {
                    ok: false,
                    status: 503,
                    statusText: 'Service Unavailable',
                    async text() {
                        return JSON.stringify({ error: 'temporarily unavailable' });
                    },
                };
            }

            if (asText.includes('/relay-payload?')) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({
                            address: relayerFromAddress,
                            nonce: '14',
                        });
                    },
                };
            }

            if (asText.endsWith('/submit')) {
                deployedUnavailableSubmitBody = JSON.parse(options.body);
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({
                            transactionID: deployedUnavailableTransactionId,
                            hash: deployedUnavailableRelayTxHash,
                            state: 'STATE_PENDING',
                        });
                    },
                };
            }

            if (
                asText.includes('/transaction?') &&
                (asText.includes(`id=${deployedUnavailableTransactionId}`) ||
                    asText.includes(`transactionID=${deployedUnavailableTransactionId}`))
            ) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify([
                            {
                                transactionID: deployedUnavailableTransactionId,
                                hash: deployedUnavailableRelayTxHash,
                                state: 'STATE_CONFIRMED',
                                transactionHash: deployedUnavailableOnchainTxHash,
                            },
                        ]);
                    },
                };
            }

            throw new Error(`Unexpected relayer fetch URL (deployed unavailable test): ${asText}`);
        };

        const deployedUnavailableDepositHash = await makeErc1155Deposit({
            publicClient: {
                async getChainId() {
                    return 137;
                },
            },
            walletClient: {
                async signMessage() {
                    return `0x${'f'.repeat(128)}1b`;
                },
            },
            account,
            config: {
                commitmentSafe: config.commitmentSafe,
                polymarketRelayerEnabled: true,
                polymarketRelayerHost: 'https://relayer-v2.polymarket.com',
                polymarketRelayerTxType: 'SAFE',
                polymarketRelayerFromAddress: relayerFromAddress,
                polymarketBuilderApiKey: 'builder-key',
                polymarketBuilderSecret: Buffer.from('builder-secret').toString('base64'),
                polymarketBuilderPassphrase: 'builder-passphrase',
                polymarketRelayerPollIntervalMs: 0,
                polymarketRelayerPollTimeoutMs: 1_000,
            },
            token,
            tokenId: '12',
            amount: '1',
            data: null,
        });

        assert.equal(sawUnavailableDeployedCheck, true);
        assert.equal(deployedUnavailableDepositHash, deployedUnavailableOnchainTxHash);
        assert.equal(
            deployedUnavailableSubmitBody.proxyWallet.toLowerCase(),
            relayerFromAddress.toLowerCase()
        );
    } finally {
        globalThis.fetch = oldFetchDeployedUnavailable;
    }

    const clobOnlyAddress = '0x3333333333333333333333333333333333333333';
    const clobIgnoredRelayTxHash = `0x${'9'.repeat(64)}`;
    const clobIgnoredOnchainTxHash = `0x${'a'.repeat(64)}`;
    const clobIgnoredTransactionId = 'relayer-safe-from-resolved-1';
    let clobIgnoredSubmitBody;
    const oldFetchClobIgnored = globalThis.fetch;
    try {
        globalThis.fetch = async (url, options = {}) => {
            const asText = String(url);
            const asLower = asText.toLowerCase();
            if (asLower.includes('/deployed?') && asLower.includes(relayerFromAddress.toLowerCase())) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({ deployed: true });
                    },
                };
            }

            if (asText.includes('/relay-payload?')) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({
                            address: relayerFromAddress,
                            nonce: '13',
                        });
                    },
                };
            }

            if (asText.endsWith('/submit')) {
                clobIgnoredSubmitBody = JSON.parse(options.body);
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({
                            transactionID: clobIgnoredTransactionId,
                            hash: clobIgnoredRelayTxHash,
                            state: 'STATE_PENDING',
                        });
                    },
                };
            }

            if (
                asText.includes('/transaction?') &&
                (asText.includes(`id=${clobIgnoredTransactionId}`) ||
                    asText.includes(`transactionID=${clobIgnoredTransactionId}`))
            ) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify([
                            {
                                transactionID: clobIgnoredTransactionId,
                                hash: clobIgnoredRelayTxHash,
                                state: 'STATE_CONFIRMED',
                                transactionHash: clobIgnoredOnchainTxHash,
                            },
                        ]);
                    },
                };
            }

            throw new Error(`Unexpected relayer fetch URL (CLOB ignored test): ${asText}`);
        };

        const clobIgnoredDepositHash = await makeErc1155Deposit({
            publicClient: {
                async getChainId() {
                    return 137;
                },
            },
            walletClient: {
                async signMessage() {
                    return `0x${'b'.repeat(128)}1b`;
                },
            },
            account,
            config: {
                commitmentSafe: config.commitmentSafe,
                polymarketRelayerEnabled: true,
                polymarketRelayerHost: 'https://relayer-v2.polymarket.com',
                polymarketRelayerTxType: 'SAFE',
                polymarketClobAddress: clobOnlyAddress,
                polymarketBuilderApiKey: 'builder-key',
                polymarketBuilderSecret: Buffer.from('builder-secret').toString('base64'),
                polymarketBuilderPassphrase: 'builder-passphrase',
                polymarketRelayerPollIntervalMs: 0,
                polymarketRelayerPollTimeoutMs: 1_000,
            },
            token,
            tokenId: '11',
            amount: '2',
            data: null,
        });

        assert.equal(clobIgnoredDepositHash, clobIgnoredOnchainTxHash);
        assert.equal(clobIgnoredSubmitBody.proxyWallet.toLowerCase(), relayerFromAddress.toLowerCase());
        assert.notEqual(clobIgnoredSubmitBody.proxyWallet.toLowerCase(), clobOnlyAddress.toLowerCase());

        const decodedClobIgnored = decodeFunctionData({
            abi: parseAbi([
                'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
            ]),
            data: clobIgnoredSubmitBody.data,
        });
        assert.equal(decodedClobIgnored.functionName, 'safeTransferFrom');
        assert.equal(decodedClobIgnored.args[0].toLowerCase(), relayerFromAddress.toLowerCase());
        assert.notEqual(decodedClobIgnored.args[0].toLowerCase(), clobOnlyAddress.toLowerCase());
    } finally {
        globalThis.fetch = oldFetchClobIgnored;
    }

    const proxyWalletAddress = '0x5555555555555555555555555555555555555555';
    const proxyRelayTxHash = `0x${'3'.repeat(64)}`;
    const proxyOnchainTxHash = `0x${'4'.repeat(64)}`;
    const proxyTransactionId = 'relayer-proxy-tx-1';
    let proxySubmitBody;
    const oldFetchProxy = globalThis.fetch;
    try {
        globalThis.fetch = async (url, options = {}) => {
            const asText = String(url);
            if (asText.includes('/relay-payload?')) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({
                            address: proxyWalletAddress,
                            nonce: '3',
                        });
                    },
                };
            }

            if (asText.endsWith('/submit')) {
                proxySubmitBody = JSON.parse(options.body);
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({
                            transactionID: proxyTransactionId,
                            hash: proxyRelayTxHash,
                            state: 'STATE_PENDING',
                        });
                    },
                };
            }

            if (asText.includes('/transaction?') && asText.includes(proxyTransactionId)) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify([
                            {
                                transactionID: proxyTransactionId,
                                hash: proxyRelayTxHash,
                                state: 'STATE_CONFIRMED',
                                transactionHash: proxyOnchainTxHash,
                            },
                        ]);
                    },
                };
            }

            throw new Error(`Unexpected PROXY relayer fetch URL: ${asText}`);
        };

        let proxySignedMessage;
        const proxyWalletClient = {
            async signMessage({ message }) {
                proxySignedMessage = message;
                return `0x${'c'.repeat(128)}1b`;
            },
        };
        const proxyPublicClient = {
            async getChainId() {
                return 137;
            },
        };

        const proxyConfig = {
            commitmentSafe: config.commitmentSafe,
            polymarketRelayerEnabled: true,
            polymarketRelayerHost: 'https://relayer-v2.polymarket.com',
            polymarketRelayerTxType: 'PROXY',
            polymarketBuilderApiKey: 'builder-key',
            polymarketBuilderSecret: Buffer.from('builder-secret').toString('base64'),
            polymarketBuilderPassphrase: 'builder-passphrase',
            polymarketRelayerPollIntervalMs: 0,
            polymarketRelayerPollTimeoutMs: 1_000,
        };

        const proxyDepositHash = await makeErc1155Deposit({
            publicClient: proxyPublicClient,
            walletClient: proxyWalletClient,
            account,
            config: proxyConfig,
            token,
            tokenId: '8',
            amount: '4',
            data: null,
        });

        assert.equal(proxyDepositHash, proxyOnchainTxHash);
        assert.equal(proxySubmitBody.type, 'PROXY');
        assert.equal(proxySubmitBody.from.toLowerCase(), account.address.toLowerCase());
        assert.equal(proxySubmitBody.proxyWallet.toLowerCase(), proxyWalletAddress.toLowerCase());
        assert.equal(proxySubmitBody.signatureParams.chainId, '137');
        assert.equal(proxySubmitBody.nonce, '3');
        assert.ok(proxySignedMessage?.raw);

        const decodedProxy = decodeFunctionData({
            abi: parseAbi([
                'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
            ]),
            data: proxySubmitBody.data,
        });
        assert.equal(decodedProxy.args[0].toLowerCase(), proxyWalletAddress.toLowerCase());
        assert.equal(decodedProxy.args[1].toLowerCase(), config.commitmentSafe.toLowerCase());
        assert.equal(decodedProxy.args[2], 8n);
        assert.equal(decodedProxy.args[3], 4n);
    } finally {
        globalThis.fetch = oldFetchProxy;
    }

    const safeCreateRelayHash = `0x${'5'.repeat(64)}`;
    const safeCreateOnchainHash = `0x${'6'.repeat(64)}`;
    const safeActionRelayHash = `0x${'7'.repeat(64)}`;
    const safeActionOnchainHash = `0x${'8'.repeat(64)}`;
    const safeCreateTransactionId = 'safe-create-1';
    const safeActionTransactionId = 'safe-action-1';
    let safeCreateSubmitBody;
    let safeActionSubmitBody;
    let submitCount = 0;
    let signTypedDataCalled = false;
    const oldFetchSafeCreate = globalThis.fetch;
    try {
        globalThis.fetch = async (url, options = {}) => {
            const asText = String(url);
            const asLower = asText.toLowerCase();

            if (asText.includes('/relay-payload?')) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({
                            address: relayerFromAddress,
                            nonce: '9',
                        });
                    },
                };
            }

            if (asLower.includes('/deployed?') && asLower.includes(relayerFromAddress.toLowerCase())) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({ deployed: false });
                    },
                };
            }

            if (asText.endsWith('/submit')) {
                submitCount += 1;
                const body = JSON.parse(options.body);
                if (submitCount === 1) {
                    safeCreateSubmitBody = body;
                    return {
                        ok: true,
                        status: 200,
                        statusText: 'OK',
                        async text() {
                            return JSON.stringify({
                                transactionID: safeCreateTransactionId,
                                hash: safeCreateRelayHash,
                                state: 'STATE_PENDING',
                            });
                        },
                    };
                }
                safeActionSubmitBody = body;
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({
                            transactionID: safeActionTransactionId,
                            hash: safeActionRelayHash,
                            state: 'STATE_PENDING',
                        });
                    },
                };
            }

            if (asText.includes('/transaction?') && asText.includes(safeCreateTransactionId)) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify([
                            {
                                transactionID: safeCreateTransactionId,
                                hash: safeCreateRelayHash,
                                state: 'STATE_CONFIRMED',
                                transactionHash: safeCreateOnchainHash,
                            },
                        ]);
                    },
                };
            }

            if (asText.includes('/transaction?') && asText.includes(safeActionTransactionId)) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify([
                            {
                                transactionID: safeActionTransactionId,
                                hash: safeActionRelayHash,
                                state: 'STATE_CONFIRMED',
                                transactionHash: safeActionOnchainHash,
                            },
                        ]);
                    },
                };
            }

            throw new Error(`Unexpected SAFE-CREATE relayer fetch URL: ${asText}`);
        };

        const safeCreateWalletClient = {
            async signTypedData(args) {
                signTypedDataCalled = true;
                assert.equal(args.primaryType, 'CreateProxy');
                return `0x${'d'.repeat(130)}`;
            },
            async signMessage() {
                return `0x${'e'.repeat(128)}1b`;
            },
        };
        const safeCreatePublicClient = {
            async getChainId() {
                return 137;
            },
        };

        const safeCreateConfig = {
            commitmentSafe: config.commitmentSafe,
            polymarketRelayerEnabled: true,
            polymarketRelayerHost: 'https://relayer-v2.polymarket.com',
            polymarketRelayerTxType: 'SAFE',
            polymarketRelayerAutoDeployProxy: true,
            polymarketBuilderApiKey: 'builder-key',
            polymarketBuilderSecret: Buffer.from('builder-secret').toString('base64'),
            polymarketBuilderPassphrase: 'builder-passphrase',
            polymarketRelayerPollIntervalMs: 0,
            polymarketRelayerPollTimeoutMs: 1_000,
        };

        const safeCreateDepositHash = await makeErc1155Deposit({
            publicClient: safeCreatePublicClient,
            walletClient: safeCreateWalletClient,
            account,
            config: safeCreateConfig,
            token,
            tokenId: '9',
            amount: '5',
            data: null,
        });

        assert.equal(safeCreateDepositHash, safeActionOnchainHash);
        assert.equal(signTypedDataCalled, true);
        assert.equal(safeCreateSubmitBody.type, 'SAFE-CREATE');
        assert.equal(safeCreateSubmitBody.from.toLowerCase(), account.address.toLowerCase());
        assert.equal(safeCreateSubmitBody.proxyWallet.toLowerCase(), relayerFromAddress.toLowerCase());
        assert.equal(safeActionSubmitBody.type, 'SAFE');
        assert.equal(safeActionSubmitBody.proxyWallet.toLowerCase(), relayerFromAddress.toLowerCase());
    } finally {
        globalThis.fetch = oldFetchSafeCreate;
    }

    const oldFetchMissingTracking = globalThis.fetch;
    try {
        globalThis.fetch = async (url) => {
            const asText = String(url);
            const asLower = asText.toLowerCase();
            if (asText.includes('/relay-payload?')) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({
                            address: relayerFromAddress,
                            nonce: '12',
                        });
                    },
                };
            }
            if (asLower.includes('/deployed?') && asLower.includes(relayerFromAddress.toLowerCase())) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({ deployed: true });
                    },
                };
            }
            if (asText.endsWith('/submit')) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({});
                    },
                };
            }
            throw new Error(`Unexpected missing-tracking fetch URL: ${asText}`);
        };

        await assert.rejects(
            () =>
                makeErc1155Deposit({
                    publicClient: {
                        async getChainId() {
                            return 137;
                        },
                    },
                    walletClient: {
                        async signMessage() {
                            return `0x${'f'.repeat(128)}1b`;
                        },
                    },
                    account,
                    config: {
                        commitmentSafe: config.commitmentSafe,
                        polymarketRelayerEnabled: true,
                        polymarketRelayerHost: 'https://relayer-v2.polymarket.com',
                        polymarketRelayerTxType: 'SAFE',
                        polymarketRelayerFromAddress: relayerFromAddress,
                        polymarketBuilderApiKey: 'builder-key',
                        polymarketBuilderSecret: Buffer.from('builder-secret').toString('base64'),
                        polymarketBuilderPassphrase: 'builder-passphrase',
                        polymarketRelayerPollIntervalMs: 0,
                        polymarketRelayerPollTimeoutMs: 1_000,
                    },
                    token,
                    tokenId: '10',
                    amount: '1',
                    data: null,
                }),
            /did not return transactionID or txHash/
        );
    } finally {
        globalThis.fetch = oldFetchMissingTracking;
    }

    console.log('[test] makeErc1155Deposit OK');
}

run();
