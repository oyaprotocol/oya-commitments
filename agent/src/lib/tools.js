import { getAddress } from 'viem';
import {
    buildOgTransactions,
    makeDeposit,
    makeErc1155Deposit,
    postBondAndDispute,
    postBondAndPropose,
} from './tx.js';
import {
    buildClobOrderFromRaw,
    cancelClobOrders,
    placeClobOrder,
    resolveClobExchangeAddress,
    signClobOrder,
} from './polymarket.js';
import { parseToolArguments } from './utils.js';

function safeStringify(value) {
    return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item));
}

function normalizeOrderSide(value) {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toUpperCase();
    return normalized === 'BUY' || normalized === 'SELL' ? normalized : undefined;
}

function normalizeOrderSideEnumIndex(value) {
    const normalized = normalizeOrderSide(value);
    if (!normalized) return undefined;
    return normalized === 'BUY' ? 0 : 1;
}

function normalizeOrderType(value) {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toUpperCase();
    return normalized === 'GTC' ||
        normalized === 'GTD' ||
        normalized === 'FOK' ||
        normalized === 'FAK'
        ? normalized
        : undefined;
}

function normalizeCancelMode(value) {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    return normalized === 'ids' || normalized === 'market' || normalized === 'all'
        ? normalized
        : undefined;
}

function getFirstString(values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

function maybeAddress(value) {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return undefined;
    try {
        return getAddress(trimmed);
    } catch (error) {
        return undefined;
    }
}

function normalizeOptionalUintString(value, fieldName) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    try {
        const normalized = BigInt(value);
        if (normalized < 0n) {
            throw new Error(`${fieldName} must be >= 0.`);
        }
        return normalized.toString();
    } catch (error) {
        throw new Error(`${fieldName} must be an integer value.`);
    }
}

function normalizeSignedOrderPayload(signedOrder) {
    if (!signedOrder || typeof signedOrder !== 'object') {
        return undefined;
    }
    return signedOrder.order && typeof signedOrder.order === 'object'
        ? signedOrder.order
        : signedOrder;
}

function extractSignedOrderSideAndTokenId(orderPayload) {
    if (!orderPayload || typeof orderPayload !== 'object') {
        return { side: undefined, tokenId: undefined };
    }

    const side = normalizeOrderSide(orderPayload.side);
    const tokenId = getFirstString([
        orderPayload.tokenId,
        orderPayload.tokenID,
        orderPayload.token_id,
        orderPayload.assetId,
        orderPayload.assetID,
        orderPayload.asset_id,
    ]);

    return { side, tokenId };
}

function extractSignedOrderIdentityAddresses(orderPayload) {
    if (!orderPayload || typeof orderPayload !== 'object') {
        return [];
    }

    const candidates = [
        orderPayload.signer,
        orderPayload.signerAddress,
        orderPayload.maker,
        orderPayload.makerAddress,
        orderPayload.funder,
        orderPayload.funderAddress,
        orderPayload.user,
        orderPayload.userAddress,
    ];

    const normalized = candidates.map(maybeAddress).filter(Boolean);
    return Array.from(new Set(normalized));
}

function toolDefinitions({
    proposeEnabled,
    disputeEnabled,
    clobEnabled,
    onchainToolsEnabled = proposeEnabled || disputeEnabled,
}) {
    const tools = [
        {
            type: 'function',
            name: 'build_og_transactions',
            description:
                'Build Optimistic Governor transaction payloads from high-level intents. Returns array of {to,value,data,operation} with value as string wei.',
            strict: false,
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
                                        'Action type: erc20_transfer | native_transfer | contract_call | uniswap_v3_exact_input_single | ctf_split | ctf_merge | ctf_redeem',
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
                                router: {
                                    type: ['string', 'null'],
                                    description:
                                        'Uniswap V3 router address for uniswap_v3_exact_input_single.',
                                },
                                tokenIn: {
                                    type: ['string', 'null'],
                                    description: 'Input ERC20 token for Uniswap swap action.',
                                },
                                tokenOut: {
                                    type: ['string', 'null'],
                                    description: 'Output ERC20 token for Uniswap swap action.',
                                },
                                fee: {
                                    type: ['integer', 'null'],
                                    description: 'Uniswap V3 pool fee tier (e.g. 500, 3000, 10000).',
                                },
                                recipient: {
                                    type: ['string', 'null'],
                                    description: 'Recipient of Uniswap swap output tokens.',
                                },
                                amountInWei: {
                                    type: ['string', 'null'],
                                    description: 'Input token amount for Uniswap swap in token wei.',
                                },
                                amountOutMinWei: {
                                    type: ['string', 'null'],
                                    description: 'Minimum output amount for Uniswap swap in token wei.',
                                },
                                sqrtPriceLimitX96: {
                                    type: ['string', 'null'],
                                    description:
                                        'Optional Uniswap sqrtPriceLimitX96 guard (default 0 for no limit).',
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
        {
            type: 'function',
            name: 'make_erc1155_deposit',
            description:
                'Deposit ERC1155 tokens into the commitment Safe using safeTransferFrom from the agent wallet.',
            strict: true,
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    token: {
                        type: 'string',
                        description: 'ERC1155 token contract address.',
                    },
                    tokenId: {
                        type: 'string',
                        description: 'ERC1155 token id as a base-10 string.',
                    },
                    amount: {
                        type: 'string',
                        description: 'ERC1155 amount as a base-10 string.',
                    },
                    data: {
                        type: ['string', 'null'],
                        description: 'Optional calldata bytes for safeTransferFrom, defaults to 0x.',
                    },
                },
                required: ['token', 'tokenId', 'amount'],
            },
        },
    ];

    if (!onchainToolsEnabled) {
        tools.length = 0;
    }

    if (onchainToolsEnabled && proposeEnabled) {
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

    if (onchainToolsEnabled && disputeEnabled) {
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
                            type: ['string', 'null'],
                            description:
                                'Optional CLOB API key owner override; defaults to POLYMARKET_CLOB_API_KEY.',
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
                            enum: ['GTC', 'GTD', 'FOK', 'FAK'],
                            description: 'Order type, e.g. GTC, GTD, FOK, or FAK.',
                        },
                        signedOrder: {
                            type: 'object',
                            description:
                                'Signed order payload expected by the CLOB API /order endpoint.',
                        },
                    },
                    required: ['side', 'tokenId', 'orderType', 'signedOrder'],
                },
            },
            {
                type: 'function',
                name: 'polymarket_clob_build_sign_and_place_order',
                description:
                    'Build an unsigned CLOB order, sign it with the runtime signer (EIP-712), and submit it.',
                strict: true,
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        owner: {
                            type: ['string', 'null'],
                            description:
                                'Optional CLOB API key owner override; defaults to POLYMARKET_CLOB_API_KEY.',
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
                            enum: ['GTC', 'GTD', 'FOK', 'FAK'],
                            description: 'Order type, e.g. GTC, GTD, FOK, or FAK.',
                        },
                        makerAmount: {
                            type: 'string',
                            description: 'Order makerAmount in base units as an integer string.',
                        },
                        takerAmount: {
                            type: 'string',
                            description: 'Order takerAmount in base units as an integer string.',
                        },
                        maker: {
                            type: ['string', 'null'],
                            description:
                                'Optional maker override. Must match runtime signer or POLYMARKET_CLOB_ADDRESS.',
                        },
                        signer: {
                            type: ['string', 'null'],
                            description:
                                'Optional signer override. Must match runtime signer or POLYMARKET_CLOB_ADDRESS.',
                        },
                        taker: {
                            type: ['string', 'null'],
                            description: 'Optional taker address override (defaults to zero address).',
                        },
                        expiration: {
                            type: ['string', 'null'],
                            description: 'Optional expiration timestamp as integer string. Default 0.',
                        },
                        nonce: {
                            type: ['string', 'null'],
                            description: 'Optional nonce as integer string. Default 0.',
                        },
                        feeRateBps: {
                            type: ['string', 'null'],
                            description: 'Optional fee rate in bps as integer string. Default 0.',
                        },
                        signatureType: {
                            type: ['string', 'integer', 'null'],
                            description:
                                'Optional signature type (EOA|POLY_GNOSIS_SAFE|POLY_PROXY or enum 0/1/2). Default EOA.',
                        },
                        salt: {
                            type: ['string', 'null'],
                            description: 'Optional uint256 salt as integer string. Random if omitted.',
                        },
                        exchange: {
                            type: ['string', 'null'],
                            description:
                                'Optional CTF exchange address override for EIP-712 domain verifyingContract.',
                        },
                        chainId: {
                            type: ['integer', 'null'],
                            description:
                                'Optional chainId override for EIP-712 domain. Defaults to current RPC chain.',
                        },
                    },
                    required: ['side', 'tokenId', 'orderType', 'makerAmount', 'takerAmount'],
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
                            enum: ['ids', 'market', 'all'],
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
                    required: ['mode'],
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
    const onchainToolsEnabled = config.proposeEnabled || config.disputeEnabled;
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
                const runtimeSignerAddress = getAddress(account.address);
                const clobAuthAddress = config.polymarketClobAddress
                    ? getAddress(config.polymarketClobAddress)
                    : runtimeSignerAddress;
                const normalizedSignedOrder = normalizeSignedOrderPayload(args.signedOrder);
                if (!normalizedSignedOrder) {
                    throw new Error('signedOrder is required and must be an object.');
                }
                const declaredSide = normalizeOrderSide(args.side);
                if (!declaredSide) {
                    throw new Error('side must be BUY or SELL');
                }
                if (!args.tokenId) {
                    throw new Error('tokenId is required');
                }
                const declaredTokenId = String(args.tokenId).trim();
                const orderType = normalizeOrderType(args.orderType);
                if (!orderType) {
                    throw new Error('orderType must be one of GTC, GTD, FOK, FAK');
                }
                const { side: signedOrderSide, tokenId: signedOrderTokenId } =
                    extractSignedOrderSideAndTokenId(normalizedSignedOrder);
                if (!signedOrderSide || !signedOrderTokenId) {
                    throw new Error(
                        'signedOrder must include embedded side and token id (side + tokenId/asset_id).'
                    );
                }
                if (signedOrderSide !== declaredSide) {
                    throw new Error(
                        `signedOrder side mismatch: declared ${declaredSide}, signed order has ${signedOrderSide}.`
                    );
                }
                if (signedOrderTokenId !== declaredTokenId) {
                    throw new Error(
                        `signedOrder token mismatch: declared ${declaredTokenId}, signed order has ${signedOrderTokenId}.`
                    );
                }
                const identityAddresses =
                    extractSignedOrderIdentityAddresses(normalizedSignedOrder);
                if (identityAddresses.length === 0) {
                    throw new Error(
                        'signedOrder must include an identity field (maker/signer/funder/user).'
                    );
                }
                const allowedIdentityAddresses = new Set([
                    clobAuthAddress,
                    runtimeSignerAddress,
                ]);
                const unauthorizedIdentities = identityAddresses.filter(
                    (address) => !allowedIdentityAddresses.has(address)
                );
                if (unauthorizedIdentities.length > 0) {
                    throw new Error(
                        `signedOrder identity mismatch: expected only ${Array.from(allowedIdentityAddresses).join(', ')}, signed order contains unauthorized ${unauthorizedIdentities.join(', ')}.`
                    );
                }
                const configuredOwnerApiKey = config.polymarketClobApiKey;
                if (!configuredOwnerApiKey) {
                    throw new Error('Missing POLYMARKET_CLOB_API_KEY in runtime config.');
                }
                const requestedOwner =
                    typeof args.owner === 'string' && args.owner.trim()
                        ? args.owner.trim()
                        : undefined;
                if (requestedOwner && requestedOwner !== configuredOwnerApiKey) {
                    throw new Error(
                        'owner mismatch: provided owner does not match configured POLYMARKET_CLOB_API_KEY.'
                    );
                }
                const result = await placeClobOrder({
                    config,
                    signingAddress: clobAuthAddress,
                    signedOrder: normalizedSignedOrder,
                    ownerApiKey: configuredOwnerApiKey,
                    orderType,
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
                const runtimeSignerAddress = getAddress(account.address);
                const clobAuthAddress = config.polymarketClobAddress
                    ? getAddress(config.polymarketClobAddress)
                    : runtimeSignerAddress;
                const mode = normalizeCancelMode(args.mode);
                if (!mode) {
                    throw new Error('mode must be one of ids, market, all');
                }
                const result = await cancelClobOrders({
                    config,
                    signingAddress: clobAuthAddress,
                    mode,
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

        if (call.name === 'polymarket_clob_build_sign_and_place_order') {
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
                const runtimeSignerAddress = getAddress(account.address);
                const clobAuthAddress = config.polymarketClobAddress
                    ? getAddress(config.polymarketClobAddress)
                    : runtimeSignerAddress;
                const declaredSide = normalizeOrderSide(args.side);
                if (!declaredSide) {
                    throw new Error('side must be BUY or SELL');
                }
                const declaredSideEnum = normalizeOrderSideEnumIndex(declaredSide);
                if (declaredSideEnum === undefined) {
                    throw new Error('side must be BUY or SELL');
                }
                if (!args.tokenId) {
                    throw new Error('tokenId is required');
                }
                const declaredTokenId = String(args.tokenId).trim();
                const orderType = normalizeOrderType(args.orderType);
                if (!orderType) {
                    throw new Error('orderType must be one of GTC, GTD, FOK, FAK');
                }
                if (!args.makerAmount) {
                    throw new Error('makerAmount is required');
                }
                if (!args.takerAmount) {
                    throw new Error('takerAmount is required');
                }

                const allowedIdentityAddresses = new Set([
                    runtimeSignerAddress,
                    clobAuthAddress,
                ]);
                const maker = args.maker ? getAddress(String(args.maker)) : clobAuthAddress;
                const signer = args.signer ? getAddress(String(args.signer)) : runtimeSignerAddress;
                if (!allowedIdentityAddresses.has(maker)) {
                    throw new Error(
                        `maker identity mismatch: maker must be one of ${Array.from(
                            allowedIdentityAddresses
                        ).join(', ')}.`
                    );
                }
                if (!allowedIdentityAddresses.has(signer)) {
                    throw new Error(
                        `signer identity mismatch: signer must be one of ${Array.from(
                            allowedIdentityAddresses
                        ).join(', ')}.`
                    );
                }

                const runtimeChainId =
                    typeof publicClient?.getChainId === 'function'
                        ? await publicClient.getChainId()
                        : undefined;
                const chainId = Number(args.chainId ?? runtimeChainId);
                if (!Number.isInteger(chainId) || chainId <= 0) {
                    throw new Error(
                        'chainId is required to sign CLOB orders (provide chainId or use a client with getChainId).'
                    );
                }
                const exchange = resolveClobExchangeAddress({
                    chainId,
                    exchangeOverride: args.exchange ?? config.polymarketExchange,
                });
                const normalizedSalt = normalizeOptionalUintString(args.salt, 'salt');
                const normalizedExpiration = normalizeOptionalUintString(
                    args.expiration,
                    'expiration'
                );
                const normalizedNonce = normalizeOptionalUintString(args.nonce, 'nonce');
                const normalizedFeeRateBps = normalizeOptionalUintString(
                    args.feeRateBps,
                    'feeRateBps'
                );
                const configuredSignatureType =
                    config.polymarketClobSignatureType !== undefined &&
                    config.polymarketClobSignatureType !== null &&
                    String(config.polymarketClobSignatureType).trim() !== ''
                        ? config.polymarketClobSignatureType
                        : undefined;
                const requestedSignatureType =
                    args.signatureType !== undefined &&
                    args.signatureType !== null &&
                    String(args.signatureType).trim() !== ''
                        ? args.signatureType
                        : configuredSignatureType;
                const unsignedOrder = buildClobOrderFromRaw({
                    maker,
                    signer,
                    taker: args.taker,
                    tokenId: declaredTokenId,
                    makerAmount: args.makerAmount,
                    takerAmount: args.takerAmount,
                    side: declaredSideEnum,
                    signatureType: requestedSignatureType,
                    salt: normalizedSalt,
                    expiration: normalizedExpiration,
                    nonce: normalizedNonce,
                    feeRateBps: normalizedFeeRateBps,
                });
                const signatureTypeIndex = Number(unsignedOrder.signatureType);
                if (signatureTypeIndex !== 0) {
                    if (!config.polymarketClobAddress) {
                        throw new Error(
                            'POLYMARKET_CLOB_ADDRESS is required for POLY_PROXY/POLY_GNOSIS_SAFE signature types.'
                        );
                    }
                    if (maker !== clobAuthAddress) {
                        throw new Error(
                            'maker must match POLYMARKET_CLOB_ADDRESS for POLY_PROXY/POLY_GNOSIS_SAFE signature types.'
                        );
                    }
                }
                const signedOrder = await signClobOrder({
                    walletClient,
                    account,
                    chainId,
                    exchange,
                    order: unsignedOrder,
                });

                const configuredOwnerApiKey = config.polymarketClobApiKey;
                if (!configuredOwnerApiKey) {
                    throw new Error('Missing POLYMARKET_CLOB_API_KEY in runtime config.');
                }
                const requestedOwner =
                    typeof args.owner === 'string' && args.owner.trim()
                        ? args.owner.trim()
                        : undefined;
                if (requestedOwner && requestedOwner !== configuredOwnerApiKey) {
                    throw new Error(
                        'owner mismatch: provided owner does not match configured POLYMARKET_CLOB_API_KEY.'
                    );
                }
                const result = await placeClobOrder({
                    config,
                    signingAddress: clobAuthAddress,
                    signedOrder,
                    ownerApiKey: configuredOwnerApiKey,
                    orderType,
                });
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
                        status: 'submitted',
                        signedOrder,
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
            if (!onchainToolsEnabled) {
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
                        status: 'skipped',
                        reason: 'onchain tools disabled',
                    }),
                });
                continue;
            }
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

        if (call.name === 'make_erc1155_deposit') {
            if (!onchainToolsEnabled) {
                outputs.push({
                    callId: call.callId,
                    name: call.name,
                    output: safeStringify({
                        status: 'skipped',
                        reason: 'onchain tools disabled',
                    }),
                });
                continue;
            }
            const txHash = await makeErc1155Deposit({
                publicClient,
                walletClient,
                account,
                config,
                token: args.token,
                tokenId: args.tokenId,
                amount: args.amount,
                data: args.data,
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
            name: call.name,
            output: safeStringify({ status: 'skipped', reason: 'unknown tool' }),
        });
    }

    if (builtTransactions && !hasPostProposal) {
        if (!config.proposeEnabled) {
            console.log('[agent] Built transactions but proposals are disabled; skipping propose.');
        } else {
            const result = await postBondAndPropose({
                publicClient,
                walletClient,
                account,
                config,
                ogModule: config.ogModule,
                transactions: builtTransactions,
            });
            outputs.push({
                callId: 'auto_post_bond_and_propose',
                name: 'post_bond_and_propose',
                output: safeStringify({
                    status: 'submitted',
                    ...result,
                }),
            });
        }
    }

    return outputs.filter((item) => item.callId);
}

export { executeToolCalls, toolDefinitions };
