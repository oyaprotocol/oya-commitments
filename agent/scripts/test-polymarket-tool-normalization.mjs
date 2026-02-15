import assert from 'node:assert/strict';
import { executeToolCalls, toolDefinitions } from '../src/lib/tools.js';

const TEST_ACCOUNT = { address: '0x1111111111111111111111111111111111111111' };
const TEST_SIGNATURE = `0x${'1'.repeat(130)}`;

function parseToolOutput(output) {
    return JSON.parse(output.output);
}

async function run() {
    const defs = toolDefinitions({
        proposeEnabled: false,
        disputeEnabled: false,
        clobEnabled: true,
    });
    const placeOrderDef = defs.find((tool) => tool.name === 'polymarket_clob_place_order');
    const buildSignAndPlaceOrderDef = defs.find(
        (tool) => tool.name === 'polymarket_clob_build_sign_and_place_order'
    );
    const cancelOrdersDef = defs.find((tool) => tool.name === 'polymarket_clob_cancel_orders');
    const makeDepositDef = defs.find((tool) => tool.name === 'make_deposit');
    const makeErc1155DepositDef = defs.find((tool) => tool.name === 'make_erc1155_deposit');

    assert.ok(placeOrderDef);
    assert.ok(buildSignAndPlaceOrderDef);
    assert.ok(cancelOrdersDef);
    assert.equal(makeDepositDef, undefined);
    assert.equal(makeErc1155DepositDef, undefined);
    assert.deepEqual(placeOrderDef.parameters.properties.orderType.enum, ['GTC', 'GTD', 'FOK', 'FAK']);
    assert.deepEqual(buildSignAndPlaceOrderDef.parameters.properties.orderType.enum, [
        'GTC',
        'GTD',
        'FOK',
        'FAK',
    ]);
    assert.deepEqual(cancelOrdersDef.parameters.properties.mode.enum, ['ids', 'market', 'all']);
    assert.deepEqual(cancelOrdersDef.parameters.required, ['mode']);

    const config = {
        polymarketClobEnabled: true,
        polymarketClobHost: 'https://clob.polymarket.com',
        polymarketClobApiKey: 'dummy-api-key',
        // Keep secret/passphrase absent so calls fail before any network request.
        polymarketClobApiSecret: undefined,
        polymarketClobApiPassphrase: undefined,
    };

    const invalidOrderType = await executeToolCalls({
        toolCalls: [
            {
                callId: 'invalid-order-type',
                name: 'polymarket_clob_place_order',
                arguments: {
                    side: 'BUY',
                    tokenId: '123',
                    orderType: 'LIMIT',
                    signedOrder: { side: 'BUY', tokenId: '123' },
                },
            },
        ],
        publicClient: {},
        walletClient: {},
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const invalidOrderTypeOut = parseToolOutput(invalidOrderType[0]);
    assert.equal(invalidOrderTypeOut.status, 'error');
    assert.match(invalidOrderTypeOut.message, /orderType must be one of/);

    const normalizedOrderType = await executeToolCalls({
        toolCalls: [
            {
                callId: 'normalized-order-type',
                name: 'polymarket_clob_place_order',
                arguments: {
                    side: ' buy ',
                    tokenId: '123',
                    orderType: ' gtc ',
                    signedOrder: {
                        side: 'BUY',
                        tokenId: '123',
                        maker: TEST_ACCOUNT.address,
                    },
                },
            },
        ],
        publicClient: {},
        walletClient: {},
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const normalizedOrderTypeOut = parseToolOutput(normalizedOrderType[0]);
    assert.equal(normalizedOrderTypeOut.status, 'error');
    assert.match(normalizedOrderTypeOut.message, /Missing CLOB credentials/);

    const missingIdentity = await executeToolCalls({
        toolCalls: [
            {
                callId: 'missing-identity',
                name: 'polymarket_clob_place_order',
                arguments: {
                    side: 'BUY',
                    tokenId: '123',
                    orderType: 'GTC',
                    signedOrder: {
                        side: 'BUY',
                        tokenId: '123',
                    },
                },
            },
        ],
        publicClient: {},
        walletClient: {},
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const missingIdentityOut = parseToolOutput(missingIdentity[0]);
    assert.equal(missingIdentityOut.status, 'error');
    assert.match(missingIdentityOut.message, /must include an identity field/);

    const mismatchedIdentity = await executeToolCalls({
        toolCalls: [
            {
                callId: 'mismatched-identity',
                name: 'polymarket_clob_place_order',
                arguments: {
                    side: 'BUY',
                    tokenId: '123',
                    orderType: 'GTC',
                    signedOrder: {
                        side: 'BUY',
                        tokenId: '123',
                        maker: '0x3333333333333333333333333333333333333333',
                    },
                },
            },
        ],
        publicClient: {},
        walletClient: {},
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const mismatchedIdentityOut = parseToolOutput(mismatchedIdentity[0]);
    assert.equal(mismatchedIdentityOut.status, 'error');
    assert.match(mismatchedIdentityOut.message, /signedOrder identity mismatch/);

    const mixedIdentityWrappedOrder = await executeToolCalls({
        toolCalls: [
            {
                callId: 'mixed-identity-wrapped-order',
                name: 'polymarket_clob_place_order',
                arguments: {
                    side: 'BUY',
                    tokenId: '123',
                    orderType: 'GTC',
                    signedOrder: {
                        // Wrapper identity should not override nested submitted order identity.
                        maker: TEST_ACCOUNT.address,
                        order: {
                            side: 'BUY',
                            tokenId: '123',
                            maker: '0x3333333333333333333333333333333333333333',
                        },
                    },
                },
            },
        ],
        publicClient: {},
        walletClient: {},
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const mixedIdentityWrappedOrderOut = parseToolOutput(mixedIdentityWrappedOrder[0]);
    assert.equal(mixedIdentityWrappedOrderOut.status, 'error');
    assert.match(mixedIdentityWrappedOrderOut.message, /signedOrder identity mismatch/);

    const missingNestedSideInWrappedOrder = await executeToolCalls({
        toolCalls: [
            {
                callId: 'missing-nested-side',
                name: 'polymarket_clob_place_order',
                arguments: {
                    side: 'BUY',
                    tokenId: '123',
                    orderType: 'GTC',
                    signedOrder: {
                        // Nested payload is what will be submitted and must carry side/token.
                        side: 'BUY',
                        maker: TEST_ACCOUNT.address,
                        order: {
                            tokenId: '123',
                            maker: TEST_ACCOUNT.address,
                        },
                    },
                },
            },
        ],
        publicClient: {},
        walletClient: {},
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const missingNestedSideInWrappedOrderOut = parseToolOutput(missingNestedSideInWrappedOrder[0]);
    assert.equal(missingNestedSideInWrappedOrderOut.status, 'error');
    assert.match(missingNestedSideInWrappedOrderOut.message, /must include embedded side and token id/);

    const configuredIdentityMatch = await executeToolCalls({
        toolCalls: [
            {
                callId: 'configured-identity-match',
                name: 'polymarket_clob_place_order',
                arguments: {
                    side: 'BUY',
                    tokenId: '123',
                    orderType: 'GTC',
                    signedOrder: {
                        side: 'BUY',
                        tokenId: '123',
                        maker: '0x3333333333333333333333333333333333333333',
                    },
                },
            },
        ],
        publicClient: {},
        walletClient: {},
        account: TEST_ACCOUNT,
        config: {
            ...config,
            polymarketClobAddress: '0x3333333333333333333333333333333333333333',
        },
        ogContext: null,
    });
    const configuredIdentityMatchOut = parseToolOutput(configuredIdentityMatch[0]);
    assert.equal(configuredIdentityMatchOut.status, 'error');
    assert.match(configuredIdentityMatchOut.message, /Missing CLOB credentials/);

    const missingTypedDataSupport = await executeToolCalls({
        toolCalls: [
            {
                callId: 'missing-typed-data-support',
                name: 'polymarket_clob_build_sign_and_place_order',
                arguments: {
                    side: 'BUY',
                    tokenId: '123',
                    orderType: 'GTC',
                    makerAmount: '1000000',
                    takerAmount: '400000',
                },
            },
        ],
        publicClient: {
            async getChainId() {
                return 137;
            },
        },
        walletClient: {},
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const missingTypedDataSupportOut = parseToolOutput(missingTypedDataSupport[0]);
    assert.equal(missingTypedDataSupportOut.status, 'error');
    assert.match(missingTypedDataSupportOut.message, /signTypedData/);

    const recordedSignInputs = [];
    const buildSignAndPlace = await executeToolCalls({
        toolCalls: [
            {
                callId: 'build-sign-place',
                name: 'polymarket_clob_build_sign_and_place_order',
                arguments: {
                    side: ' buy ',
                    tokenId: '123',
                    orderType: ' gtc ',
                    makerAmount: '1000000',
                    takerAmount: '450000',
                    signatureType: 'EOA',
                },
            },
        ],
        publicClient: {
            async getChainId() {
                return 137;
            },
        },
        walletClient: {
            async signTypedData(args) {
                recordedSignInputs.push(args);
                return TEST_SIGNATURE;
            },
        },
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const buildSignAndPlaceOut = parseToolOutput(buildSignAndPlace[0]);
    assert.equal(buildSignAndPlaceOut.status, 'error');
    assert.match(buildSignAndPlaceOut.message, /Missing CLOB credentials/);
    assert.equal(recordedSignInputs.length, 1);
    assert.equal(recordedSignInputs[0].domain.chainId, 137);
    assert.equal(
        recordedSignInputs[0].domain.verifyingContract.toLowerCase(),
        '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e'
    );
    assert.equal(recordedSignInputs[0].message.side, 0);
    assert.equal(recordedSignInputs[0].message.signatureType, 0);
    assert.equal(recordedSignInputs[0].message.tokenId, 123n);

    const proxySigWithoutClobAddress = await executeToolCalls({
        toolCalls: [
            {
                callId: 'proxy-sig-without-clob-address',
                name: 'polymarket_clob_build_sign_and_place_order',
                arguments: {
                    side: 'BUY',
                    tokenId: '123',
                    orderType: 'GTC',
                    makerAmount: '1000000',
                    takerAmount: '450000',
                },
            },
        ],
        publicClient: {
            async getChainId() {
                return 137;
            },
        },
        walletClient: {
            async signTypedData() {
                return TEST_SIGNATURE;
            },
        },
        account: TEST_ACCOUNT,
        config: {
            ...config,
            polymarketClobSignatureType: 'POLY_GNOSIS_SAFE',
        },
        ogContext: null,
    });
    const proxySigWithoutClobAddressOut = parseToolOutput(proxySigWithoutClobAddress[0]);
    assert.equal(proxySigWithoutClobAddressOut.status, 'error');
    assert.match(proxySigWithoutClobAddressOut.message, /POLYMARKET_CLOB_ADDRESS is required/);

    const recordedSafeSignInputs = [];
    const defaultSafeSignatureType = await executeToolCalls({
        toolCalls: [
            {
                callId: 'default-safe-signature-type',
                name: 'polymarket_clob_build_sign_and_place_order',
                arguments: {
                    side: 'BUY',
                    tokenId: '123',
                    orderType: 'GTC',
                    makerAmount: '1000000',
                    takerAmount: '450000',
                },
            },
        ],
        publicClient: {
            async getChainId() {
                return 137;
            },
        },
        walletClient: {
            async signTypedData(args) {
                recordedSafeSignInputs.push(args);
                return TEST_SIGNATURE;
            },
        },
        account: TEST_ACCOUNT,
        config: {
            ...config,
            polymarketClobAddress: '0x3333333333333333333333333333333333333333',
            polymarketClobSignatureType: 'POLY_GNOSIS_SAFE',
        },
        ogContext: null,
    });
    const defaultSafeSignatureTypeOut = parseToolOutput(defaultSafeSignatureType[0]);
    assert.equal(defaultSafeSignatureTypeOut.status, 'error');
    assert.match(defaultSafeSignatureTypeOut.message, /Missing CLOB credentials/);
    assert.equal(recordedSafeSignInputs.length, 1);
    assert.equal(recordedSafeSignInputs[0].message.signatureType, 2);

    const invalidBuildSignIdentity = await executeToolCalls({
        toolCalls: [
            {
                callId: 'invalid-build-sign-identity',
                name: 'polymarket_clob_build_sign_and_place_order',
                arguments: {
                    side: 'BUY',
                    tokenId: '123',
                    orderType: 'GTC',
                    makerAmount: '1000000',
                    takerAmount: '450000',
                    maker: '0x3333333333333333333333333333333333333333',
                },
            },
        ],
        publicClient: {
            async getChainId() {
                return 137;
            },
        },
        walletClient: {
            async signTypedData() {
                return TEST_SIGNATURE;
            },
        },
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const invalidBuildSignIdentityOut = parseToolOutput(invalidBuildSignIdentity[0]);
    assert.equal(invalidBuildSignIdentityOut.status, 'error');
    assert.match(invalidBuildSignIdentityOut.message, /maker identity mismatch/);

    const missingChainIdForBuildSign = await executeToolCalls({
        toolCalls: [
            {
                callId: 'missing-chain-id-build-sign',
                name: 'polymarket_clob_build_sign_and_place_order',
                arguments: {
                    side: 'BUY',
                    tokenId: '123',
                    orderType: 'GTC',
                    makerAmount: '1000000',
                    takerAmount: '450000',
                },
            },
        ],
        publicClient: {},
        walletClient: {
            async signTypedData() {
                return TEST_SIGNATURE;
            },
        },
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const missingChainIdForBuildSignOut = parseToolOutput(missingChainIdForBuildSign[0]);
    assert.equal(missingChainIdForBuildSignOut.status, 'error');
    assert.match(missingChainIdForBuildSignOut.message, /chainId is required/);

    const invalidCancelMode = await executeToolCalls({
        toolCalls: [
            {
                callId: 'invalid-cancel-mode',
                name: 'polymarket_clob_cancel_orders',
                arguments: {
                    mode: 'nope',
                    orderIds: ['order-1'],
                    market: null,
                    assetId: null,
                },
            },
        ],
        publicClient: {},
        walletClient: {},
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const invalidCancelModeOut = parseToolOutput(invalidCancelMode[0]);
    assert.equal(invalidCancelModeOut.status, 'error');
    assert.match(invalidCancelModeOut.message, /mode must be one of ids, market, all/);

    const normalizedCancelMode = await executeToolCalls({
        toolCalls: [
            {
                callId: 'normalized-cancel-mode',
                name: 'polymarket_clob_cancel_orders',
                arguments: {
                    mode: ' IDS ',
                    orderIds: ['order-1'],
                    market: null,
                    assetId: null,
                },
            },
        ],
        publicClient: {},
        walletClient: {},
        account: TEST_ACCOUNT,
        config,
        ogContext: null,
    });
    const normalizedCancelModeOut = parseToolOutput(normalizedCancelMode[0]);
    assert.equal(normalizedCancelModeOut.status, 'error');
    assert.match(normalizedCancelModeOut.message, /Missing CLOB credentials/);

    const blockedOnchainDeposit = await executeToolCalls({
        toolCalls: [
            {
                callId: 'blocked-onchain-deposit',
                name: 'make_deposit',
                arguments: {
                    asset: '0x0000000000000000000000000000000000000000',
                    amountWei: '1',
                },
            },
        ],
        publicClient: {
            async waitForTransactionReceipt() {
                throw new Error('should not be called');
            },
        },
        walletClient: {
            async sendTransaction() {
                throw new Error('should not be called');
            },
        },
        account: TEST_ACCOUNT,
        config: {
            ...config,
            proposeEnabled: false,
            disputeEnabled: false,
        },
        ogContext: null,
    });
    const blockedOnchainDepositOut = parseToolOutput(blockedOnchainDeposit[0]);
    assert.equal(blockedOnchainDepositOut.status, 'skipped');
    assert.equal(blockedOnchainDepositOut.reason, 'onchain tools disabled');

    console.log('[test] polymarket tool normalization OK');
}

run();
