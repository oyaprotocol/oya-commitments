import assert from 'node:assert/strict';
import { stringToHex, zeroAddress } from 'viem';
import { executeToolCalls, toolDefinitions } from '../src/lib/tools.js';

const TEST_ACCOUNT = { address: '0x1111111111111111111111111111111111111111' };
const TEST_SAFE = '0x2222222222222222222222222222222222222222';
const TEST_OG = '0x3333333333333333333333333333333333333333';
const TEST_TOKEN = '0x4444444444444444444444444444444444444444';
const TEST_RECIPIENT = '0x5555555555555555555555555555555555555555';
const TEST_TX_TARGET = '0x6666666666666666666666666666666666666666';
const DEFAULT_PROPOSAL_EXPLANATION = 'Agent serving Oya commitment.';

function parseOutput(result) {
    return JSON.parse(result.output);
}

function buildConfig() {
    return {
        proposeEnabled: true,
        disputeEnabled: false,
        polymarketClobEnabled: false,
        allowProposeOnSimulationFail: false,
        proposeGasLimit: 2_000_000n,
        bondSpender: 'og',
        commitmentSafe: TEST_SAFE,
        ogModule: TEST_OG,
        proposalHashResolveTimeoutMs: 5,
        proposalHashResolvePollIntervalMs: 1,
    };
}

function buildProposalPublicClient() {
    return {
        async getBalance() {
            return 1n;
        },
        async readContract({ functionName }) {
            if (functionName === 'collateral') {
                return TEST_TOKEN;
            }
            if (functionName === 'bondAmount') {
                return 0n;
            }
            if (functionName === 'optimisticOracleV3') {
                return '0x7777777777777777777777777777777777777777';
            }
            if (functionName === 'getMinimumBond') {
                return 0n;
            }
            throw new Error(`Unexpected readContract function: ${functionName}`);
        },
        async simulateContract() {
            return {};
        },
        async getTransactionReceipt() {
            return { logs: [] };
        },
    };
}

async function run() {
    const defs = toolDefinitions({
        proposeEnabled: true,
        disputeEnabled: false,
        clobEnabled: false,
    });
    const makeTransferDef = defs.find((tool) => tool.name === 'make_transfer');
    const makeErc1155TransferDef = defs.find((tool) => tool.name === 'make_erc1155_transfer');
    const proposeDef = defs.find((tool) => tool.name === 'post_bond_and_propose');

    assert.ok(makeTransferDef);
    assert.ok(makeErc1155TransferDef);
    assert.deepEqual(makeTransferDef.parameters.required, ['asset', 'recipient', 'amountWei']);
    assert.deepEqual(makeErc1155TransferDef.parameters.required, [
        'token',
        'recipient',
        'tokenId',
        'amount',
        'data',
    ]);
    assert.deepEqual(proposeDef.parameters.required, ['transactions', 'explanation']);
    assert.equal(proposeDef.parameters.properties.explanation.type[0], 'string');

    let recordedErc20Transfer;
    const erc20TransferOutputs = await executeToolCalls({
        toolCalls: [
            {
                callId: 'erc20-transfer',
                name: 'make_transfer',
                arguments: {
                    asset: TEST_TOKEN,
                    recipient: TEST_RECIPIENT,
                    amountWei: '7',
                },
            },
        ],
        publicClient: {
            async waitForTransactionReceipt() {
                return {};
            },
        },
        walletClient: {
            async writeContract(args) {
                recordedErc20Transfer = args;
                return `0x${'a'.repeat(64)}`;
            },
        },
        account: TEST_ACCOUNT,
        config: buildConfig(),
        ogContext: null,
    });
    assert.equal(erc20TransferOutputs.length, 1);
    assert.equal(parseOutput(erc20TransferOutputs[0]).status, 'confirmed');
    assert.equal(recordedErc20Transfer.address, TEST_TOKEN);
    assert.equal(recordedErc20Transfer.functionName, 'transfer');
    assert.equal(recordedErc20Transfer.args[0].toLowerCase(), TEST_RECIPIENT.toLowerCase());
    assert.equal(recordedErc20Transfer.args[1], 7n);

    let recordedNativeTransfer;
    const nativeTransferOutputs = await executeToolCalls({
        toolCalls: [
            {
                callId: 'native-transfer',
                name: 'make_transfer',
                arguments: {
                    asset: zeroAddress,
                    recipient: TEST_RECIPIENT,
                    amountWei: '9',
                },
            },
        ],
        publicClient: {
            async waitForTransactionReceipt() {
                return {};
            },
        },
        walletClient: {
            async sendTransaction(args) {
                recordedNativeTransfer = args;
                return `0x${'b'.repeat(64)}`;
            },
        },
        account: TEST_ACCOUNT,
        config: buildConfig(),
        ogContext: null,
    });
    assert.equal(nativeTransferOutputs.length, 1);
    assert.equal(parseOutput(nativeTransferOutputs[0]).status, 'confirmed');
    assert.equal(recordedNativeTransfer.to.toLowerCase(), TEST_RECIPIENT.toLowerCase());
    assert.equal(recordedNativeTransfer.value, 9n);

    let recordedErc1155Transfer;
    const erc1155TransferOutputs = await executeToolCalls({
        toolCalls: [
            {
                callId: 'erc1155-transfer',
                name: 'make_erc1155_transfer',
                arguments: {
                    token: TEST_TOKEN,
                    recipient: TEST_RECIPIENT,
                    tokenId: '11',
                    amount: '5',
                },
            },
        ],
        publicClient: {
            async waitForTransactionReceipt() {
                return {};
            },
        },
        walletClient: {
            async writeContract(args) {
                recordedErc1155Transfer = args;
                return `0x${'e'.repeat(64)}`;
            },
        },
        account: TEST_ACCOUNT,
        config: buildConfig(),
        ogContext: null,
    });
    assert.equal(erc1155TransferOutputs.length, 1);
    assert.equal(parseOutput(erc1155TransferOutputs[0]).status, 'confirmed');
    assert.equal(recordedErc1155Transfer.address, TEST_TOKEN);
    assert.equal(recordedErc1155Transfer.functionName, 'safeTransferFrom');
    assert.equal(recordedErc1155Transfer.args[0].toLowerCase(), TEST_ACCOUNT.address.toLowerCase());
    assert.equal(recordedErc1155Transfer.args[1].toLowerCase(), TEST_RECIPIENT.toLowerCase());
    assert.equal(recordedErc1155Transfer.args[2], 11n);
    assert.equal(recordedErc1155Transfer.args[3], 5n);
    assert.equal(recordedErc1155Transfer.args[4], '0x');

    let recordedProposalArgs;
    const customExplanation = 'signed withdrawal request\nfill tx hash: 0xabc';
    const customExplanationOutputs = await executeToolCalls({
        toolCalls: [
            {
                callId: 'proposal-custom-explanation',
                name: 'post_bond_and_propose',
                arguments: {
                    transactions: [
                        {
                            to: TEST_TX_TARGET,
                            value: '0',
                            data: '0x',
                            operation: 0,
                        },
                    ],
                    explanation: customExplanation,
                },
            },
        ],
        publicClient: buildProposalPublicClient(),
        walletClient: {
            async writeContract(args) {
                recordedProposalArgs = args;
                return `0x${'c'.repeat(64)}`;
            },
        },
        account: TEST_ACCOUNT,
        config: buildConfig(),
        ogContext: null,
    });
    assert.equal(customExplanationOutputs.length, 1);
    assert.equal(parseOutput(customExplanationOutputs[0]).status, 'submitted');
    assert.equal(recordedProposalArgs.functionName, 'proposeTransactions');
    assert.equal(recordedProposalArgs.args[1], stringToHex(customExplanation));

    let recordedDefaultProposalArgs;
    const defaultExplanationOutputs = await executeToolCalls({
        toolCalls: [
            {
                callId: 'proposal-default-explanation',
                name: 'post_bond_and_propose',
                arguments: {
                    transactions: [
                        {
                            to: TEST_TX_TARGET,
                            value: '0',
                            data: '0x',
                            operation: 0,
                        },
                    ],
                },
            },
        ],
        publicClient: buildProposalPublicClient(),
        walletClient: {
            async writeContract(args) {
                recordedDefaultProposalArgs = args;
                return `0x${'d'.repeat(64)}`;
            },
        },
        account: TEST_ACCOUNT,
        config: buildConfig(),
        ogContext: null,
    });
    assert.equal(defaultExplanationOutputs.length, 1);
    assert.equal(parseOutput(defaultExplanationOutputs[0]).status, 'submitted');
    assert.equal(
        recordedDefaultProposalArgs.args[1],
        stringToHex(DEFAULT_PROPOSAL_EXPLANATION)
    );

    console.log('[test] transfer tool and proposal explanation OK');
}

run().catch((error) => {
    console.error('[test] transfer tool and proposal explanation failed:', error?.message ?? error);
    process.exit(1);
});
