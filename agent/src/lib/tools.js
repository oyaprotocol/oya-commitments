import { getAddress } from 'viem';
import { buildOgTransactions, makeDeposit, postBondAndDispute, postBondAndPropose } from './tx.js';
import { cancelClobOrders, placeClobOrder } from './polymarket.js';
import { parseToolArguments } from './utils.js';

function safeStringify(value) {
    return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item));
}

function toolDefinitions({ proposeEnabled, disputeEnabled, clobEnabled }) {
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
                                        'Action type: erc20_transfer | native_transfer | contract_call | ctf_split | ctf_merge | ctf_redeem',
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
                                    items: {
                                        anyOf: [
                                            { type: 'string' },
                                            { type: 'number' },
                                            { type: 'boolean' },
                                            { type: 'null' },
                                            {
                                                type: 'array',
                                                items: {
                                                    anyOf: [
                                                        { type: 'string' },
                                                        { type: 'number' },
                                                        { type: 'boolean' },
                                                        { type: 'null' },
                                                    ],
                                                },
                                            },
                                        ],
                                    },
                                },
                                operation: {
                                    type: ['integer', 'null'],
                                    description:
                                        'Safe operation (0=CALL,1=DELEGATECALL). Defaults to 0.',
                                },
                                chainId: {
                                    type: ['integer', 'null'],
                                    description: 'Chain id for CTF actions (defaults to POLYMARKET_CHAIN_ID).',
                                },
                                ctfContract: {
                                    type: ['string', 'null'],
                                    description:
                                        'ConditionalTokens contract address override for CTF actions.',
                                },
                                collateralToken: {
                                    type: ['string', 'null'],
                                    description: 'Collateral token address for CTF actions.',
                                },
                                conditionId: {
                                    type: ['string', 'null'],
                                    description: 'Condition id bytes32 for CTF actions.',
                                },
                                parentCollectionId: {
                                    type: ['string', 'null'],
                                    description:
                                        'Parent collection id bytes32 for CTF actions (default zero bytes32).',
                                },
                                partition: {
                                    type: ['array', 'null'],
                                    description:
                                        'Index partition for ctf_split/ctf_merge. Defaults to [1,2].',
                                    items: { type: 'integer' },
                                },
                                amount: {
                                    type: ['string', 'null'],
                                    description:
                                        'Collateral/full-set amount in base units for ctf_split/ctf_merge.',
                                },
                                indexSets: {
                                    type: ['array', 'null'],
                                    description:
                                        'Index sets for ctf_redeem. Defaults to [1,2].',
                                    items: { type: 'integer' },
                                },
                            },
                            required: ['kind'],
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

    if (clobEnabled) {
        tools.push(
            {
                type: 'function',
                name: 'polymarket_clob_place_order',
                description:
                    'Submit a signed Polymarket CLOB order (BUY or SELL) to the CLOB API.',
                strict: true,
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        owner: {
                            type: 'string',
                            description: 'EOA owner address associated with the signed order.',
                        },
                        side: {
                            type: 'string',
                            description: 'BUY or SELL.',
                        },
                        tokenId: {
                            type: 'string',
                            description: 'Polymarket token id for the order.',
                        },
                        orderType: {
                            type: 'string',
                            description: 'Order type, e.g. GTC, GTD, FOK, or FAK.',
                        },
                        signedOrder: {
                            type: 'object',
                            description:
                                'Signed order payload expected by the CLOB API /order endpoint.',
                        },
                    },
                    required: ['owner', 'side', 'tokenId', 'orderType', 'signedOrder'],
                },
            },
            {
                type: 'function',
                name: 'polymarket_clob_cancel_orders',
                description:
                    'Cancel Polymarket CLOB orders by ids, by market, or cancel all open orders.',
                strict: true,
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        mode: {
                            type: 'string',
                            description: 'ids | market | all',
                        },
                        orderIds: {
                            type: ['array', 'null'],
                            items: { type: 'string' },
                            description: 'Order ids required when mode=ids.',
                        },
                        market: {
                            type: ['string', 'null'],
                            description: 'Market id used when mode=market.',
                        },
                        assetId: {
                            type: ['string', 'null'],
                            description: 'Optional asset id used when mode=market.',
                        },
                    },
                    required: ['mode', 'orderIds', 'market', 'assetId'],
                },
            }
        );
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
                const transactions = buildOgTransactions(args.actions ?? [], { config });
                builtTransactions = transactions;
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({ status: 'ok', transactions }),
                });
            } catch (error) {
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
                        status: 'error',
                        message: error?.message ?? String(error),
                    }),
                });
            }
            continue;
        }

        if (call.name === 'polymarket_clob_place_order') {
            if (!config.polymarketClobEnabled) {
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
                        status: 'skipped',
                        reason: 'polymarket CLOB disabled',
                    }),
                });
                continue;
            }

            try {
                if (args.side !== 'BUY' && args.side !== 'SELL') {
                    throw new Error('side must be BUY or SELL');
                }
                if (!args.tokenId) {
                    throw new Error('tokenId is required');
                }
                const result = await placeClobOrder({
                    config,
                    signedOrder: args.signedOrder,
                    owner: args.owner,
                    orderType: args.orderType,
                });
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
                        status: 'submitted',
                        result,
                    }),
                });
            } catch (error) {
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
                        status: 'error',
                        message: error?.message ?? String(error),
                    }),
                });
            }
            continue;
        }

        if (call.name === 'polymarket_clob_cancel_orders') {
            if (!config.polymarketClobEnabled) {
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
                        status: 'skipped',
                        reason: 'polymarket CLOB disabled',
                    }),
                });
                continue;
            }

            try {
                const result = await cancelClobOrders({
                    config,
                    mode: args.mode,
                    orderIds: args.orderIds,
                    market: args.market,
                    assetId: args.assetId,
                });
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
                        status: 'submitted',
                        result,
                    }),
                });
            } catch (error) {
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
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
            await publicClient.waitForTransactionReceipt({ hash: txHash });
            outputs.push({
                callId: call.callId,
                name: call.name,
                output: safeStringify({
                    status: 'confirmed',
                    transactionHash: String(txHash),
                }),
            });
            continue;
        }

        if (call.name === 'post_bond_and_propose') {
            if (!config.proposeEnabled) {
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
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
                name: call.name,
                output: safeStringify({
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
                    name: call.name,
                    output: safeStringify({
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
                    name: call.name,
                    output: safeStringify({
                        status: 'submitted',
                        ...result,
                    }),
                });
            } catch (error) {
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
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
            output: safeStringify({ status: 'skipped', reason: 'unknown tool' }),
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
