import assert from 'node:assert/strict';
import { decodeFunctionData, parseAbi } from 'viem';
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

    const relayerFromAddress = '0x3333333333333333333333333333333333333333';
    const relayedTxHash = `0x${'1'.repeat(64)}`;
    const onchainTxHash = `0x${'2'.repeat(64)}`;
    let relayerSubmitBody;
    let relayerSubmitHeaders;
    let statusPollCount = 0;
    const oldFetch = globalThis.fetch;
    try {
        globalThis.fetch = async (url, options = {}) => {
            const asText = String(url);
            if (asText.endsWith('/relayer/transaction')) {
                relayerSubmitBody = JSON.parse(options.body);
                relayerSubmitHeaders = options.headers;
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        return JSON.stringify({ txHash: relayedTxHash });
                    },
                };
            }

            if (asText.endsWith(`/relayer/transaction-status/${relayedTxHash}`)) {
                statusPollCount += 1;
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    async text() {
                        if (statusPollCount === 1) {
                            return JSON.stringify({ status: 'PENDING', txHash: relayedTxHash });
                        }
                        return JSON.stringify({
                            status: 'MINED',
                            txHash: relayedTxHash,
                            transactionHash: onchainTxHash,
                        });
                    },
                };
            }

            throw new Error(`Unexpected relayer fetch URL: ${asText}`);
        };

        let relayerSignedMessage;
        const relayerWalletClient = {
            async signMessage({ message }) {
                relayerSignedMessage = message;
                return `0x${'a'.repeat(130)}`;
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
        assert.equal(relayerSubmitBody.type, 'SAFE');
        assert.equal(relayerSubmitBody.from.toLowerCase(), relayerFromAddress.toLowerCase());
        assert.equal(relayerSubmitBody.to.toLowerCase(), token.toLowerCase());
        assert.equal(relayerSubmitBody.value, '0');
        assert.equal(relayerSubmitBody.operation, 0);
        assert.equal(relayerSubmitBody.nonce, '12');
        assert.equal(typeof relayerSubmitBody.signature, 'string');
        assert.equal(relayerSubmitBody.metadata.tool, 'make_erc1155_deposit');
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

    console.log('[test] makeErc1155Deposit OK');
}

run();
