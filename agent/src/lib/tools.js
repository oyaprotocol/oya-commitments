import { getAddress } from 'viem';
import { buildOgTransactions, makeDeposit, postBondAndDispute, postBondAndPropose } from './tx.js';
import { parseToolArguments } from './utils.js';

function toolDefinitions({ proposeEnabled, disputeEnabled }) {
    const tools = [
        {
            type: 'function',
            name: 'build_og_transactions',
            description:
                'Build Optimistic Governor transaction payloads from high-level intents. Returns array of {to,value,data,operation} with value as string wei.',
            strict: true,
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    actions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                kind: {
                                    type: 'string',
                                    description:
                                        'Action type: erc20_transfer | native_transfer | contract_call',
                                },
                                token: {
                                    type: ['string', 'null'],
                                    description:
                                        'ERC20 token address for erc20_transfer.',
                                },
                                to: {
                                    type: ['string', 'null'],
                                    description: 'Recipient or target contract address.',
                                },
                                amountWei: {
                                    type: ['string', 'null'],
                                    description:
                                        'Amount in wei as a string. For erc20_transfer and native_transfer.',
                                },
                                valueWei: {
                                    type: ['string', 'null'],
                                    description:
                                        'ETH value to send in contract_call (default 0).',
                                },
                                abi: {
                                    type: ['string', 'null'],
                                    description:
                                        'Function signature for contract_call, e.g. "setOwner(address)".',
                                },
                                args: {
                                    type: ['array', 'null'],
                                    description:
                                        'Arguments for contract_call in order, JSON-serializable.',
                                    items: {},
                                },
                                operation: {
                                    type: ['integer', 'null'],
                                    description:
                                        'Safe operation (0=CALL,1=DELEGATECALL). Defaults to 0.',
                                },
                            },
                            required: [
                                'kind',
                                'token',
                                'to',
                                'amountWei',
                                'valueWei',
                                'abi',
                                'args',
                                'operation',
                            ],
                        },
                    },
                },
                required: ['actions'],
            },
        },
        {
            type: 'function',
            name: 'make_deposit',
            description:
                'Deposit funds into the commitment Safe. Use asset=0x000...000 for native ETH. amountWei must be a string of the integer wei amount.',
            strict: true,
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    asset: {
                        type: 'string',
                        description:
                            'Asset address (ERC20) or 0x0000000000000000000000000000000000000000 for native.',
                    },
                    amountWei: {
                        type: 'string',
                        description: 'Amount in wei as a string.',
                    },
                },
                required: ['asset', 'amountWei'],
            },
        },
    ];

    if (proposeEnabled) {
        tools.push({
            type: 'function',
            name: 'post_bond_and_propose',
            description:
                'Post bond (if required) and propose transactions to the Optimistic Governor.',
            strict: true,
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    transactions: {
                        type: 'array',
                        description: 'Safe transaction batch to propose. Use value as string wei.',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                to: { type: 'string' },
                                value: { type: 'string' },
                                data: { type: 'string' },
                                operation: { type: 'integer' },
                            },
                            required: ['to', 'value', 'data', 'operation'],
                        },
                    },
                },
                required: ['transactions'],
            },
        });
    }

    if (disputeEnabled) {
        tools.push({
            type: 'function',
            name: 'dispute_assertion',
            description:
                'Post bond (if required) and dispute an assertion on the Optimistic Oracle. Provide a short human-readable explanation.',
            strict: true,
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    assertionId: {
                        type: 'string',
                        description: 'Assertion ID to dispute.',
                    },
                    explanation: {
                        type: 'string',
                        description: 'Short human-readable dispute rationale.',
                    },
                },
                required: ['assertionId', 'explanation'],
            },
        });
    }

    return tools;
}

async function executeToolCalls({
    toolCalls,
    publicClient,
    walletClient,
    account,
    config,
    ogContext,
}) {
    const outputs = [];
    const hasPostProposal = toolCalls.some((call) => call.name === 'post_bond_and_propose');
    let builtTransactions;

    for (const call of toolCalls) {
        const args = parseToolArguments(call.arguments);
        if (!args) {
            console.warn('[agent] Skipping tool call with invalid args:', call);
            continue;
        }

        if (call.name === 'build_og_transactions') {
            try {
                const transactions = buildOgTransactions(args.actions ?? []);
                builtTransactions = transactions;
                outputs.push({
                    callId: call.callId,
                    output: JSON.stringify({ status: 'ok', transactions }),
                });
            } catch (error) {
                outputs.push({
                    callId: call.callId,
                    output: JSON.stringify({
                        status: 'error',
                        message: error?.message ?? String(error),
                    }),
                });
            }
            continue;
        }

        if (call.name === 'make_deposit') {
            const txHash = await makeDeposit({
                walletClient,
                account,
                config,
                asset: args.asset,
                amountWei: BigInt(args.amountWei),
            });
            outputs.push({
                callId: call.callId,
                output: JSON.stringify({
                    status: 'submitted',
                    transactionHash: String(txHash),
                }),
            });
            continue;
        }

        if (call.name === 'post_bond_and_propose') {
            if (!config.proposeEnabled) {
                outputs.push({
                    callId: call.callId,
                    output: JSON.stringify({
                        status: 'skipped',
                        reason: 'proposals disabled',
                    }),
                });
                continue;
            }

            const transactions = args.transactions.map((tx) => ({
                to: getAddress(tx.to),
                value: BigInt(tx.value),
                data: tx.data,
                operation: Number(tx.operation),
            }));
            const result = await postBondAndPropose({
                publicClient,
                walletClient,
                account,
                config,
                ogModule: config.ogModule,
                transactions,
            });
            outputs.push({
                callId: call.callId,
                output: JSON.stringify({
                    status: 'submitted',
                    ...result,
                }),
            });
            continue;
        }

        if (call.name === 'dispute_assertion') {
            if (!config.disputeEnabled) {
                outputs.push({
                    callId: call.callId,
                    output: JSON.stringify({
                        status: 'skipped',
                        reason: 'disputes disabled',
                    }),
                });
                continue;
            }

            try {
                const result = await postBondAndDispute({
                    publicClient,
                    walletClient,
                    account,
                    config,
                    ogContext,
                    assertionId: args.assertionId,
                    explanation: args.explanation,
                });
                outputs.push({
                    callId: call.callId,
                    output: JSON.stringify({
                        status: 'submitted',
                        ...result,
                    }),
                });
            } catch (error) {
                outputs.push({
                    callId: call.callId,
                    output: JSON.stringify({
                        status: 'error',
                        message: error?.message ?? String(error),
                    }),
                });
            }
            continue;
        }

        console.warn('[agent] Unknown tool call:', call.name);
        outputs.push({
            callId: call.callId,
            output: JSON.stringify({ status: 'skipped', reason: 'unknown tool' }),
        });
    }

    if (builtTransactions && !hasPostProposal) {
        if (!config.proposeEnabled) {
            console.log('[agent] Built transactions but proposals are disabled; skipping propose.');
        } else {
            await postBondAndPropose({
                publicClient,
                walletClient,
                account,
                config,
                ogModule: config.ogModule,
                transactions: builtTransactions,
            });
        }
    }

    return outputs.filter((item) => item.callId);
}

export { executeToolCalls, toolDefinitions };
