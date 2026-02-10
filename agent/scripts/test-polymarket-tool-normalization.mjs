import assert from 'node:assert/strict';
import { executeToolCalls, toolDefinitions } from '../src/lib/tools.js';

const TEST_ACCOUNT = { address: '0x1111111111111111111111111111111111111111' };

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
    const cancelOrdersDef = defs.find((tool) => tool.name === 'polymarket_clob_cancel_orders');
    const makeDepositDef = defs.find((tool) => tool.name === 'make_deposit');
    const makeErc1155DepositDef = defs.find((tool) => tool.name === 'make_erc1155_deposit');

    assert.ok(placeOrderDef);
    assert.ok(cancelOrdersDef);
    assert.equal(makeDepositDef, undefined);
    assert.equal(makeErc1155DepositDef, undefined);
    assert.deepEqual(placeOrderDef.parameters.properties.orderType.enum, ['GTC', 'GTD', 'FOK', 'FAK']);
    assert.deepEqual(cancelOrdersDef.parameters.properties.mode.enum, ['ids', 'market', 'all']);

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
    const normalizedOrderTypeOut = parseToolOutput(normalizedOrderType[0]);
    assert.equal(normalizedOrderTypeOut.status, 'error');
    assert.match(normalizedOrderTypeOut.message, /Missing CLOB credentials/);

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
