import 'dotenv/config';
import {
    createPublicClient,
    createWalletClient,
    encodeFunctionData,
    erc20Abi,
    getAddress,
    http,
    parseAbi,
    parseAbiItem,
    stringToHex,
    zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const optimisticGovernorAbiV1 = parseAbi([
    'function proposeTransactions((address to,uint256 value,bytes data,uint8 operation)[] transactions) returns (bytes32 proposalHash)',
    'function collateral() view returns (address)',
    'function bondAmount() view returns (uint256)',
    'function optimisticOracleV3() view returns (address)',
    'function rules() view returns (string)',
    'function identifier() view returns (bytes32)',
    'function liveness() view returns (uint64)',
]);

const optimisticGovernorAbiV2 = parseAbi([
    'function proposeTransactions((address to,uint256 value,bytes data,uint8 operation)[] transactions, bytes explanation) returns (bytes32 proposalHash)',
    'function collateral() view returns (address)',
    'function bondAmount() view returns (uint256)',
    'function optimisticOracleV3() view returns (address)',
    'function rules() view returns (string)',
    'function identifier() view returns (bytes32)',
    'function liveness() view returns (uint64)',
]);

const optimisticOracleAbi = parseAbi([
    'function getMinimumBond(address collateral) view returns (uint256)',
]);

const transferEvent = parseAbiItem(
    'event Transfer(address indexed from, address indexed to, uint256 value)'
);

function mustGetEnv(key) {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required env var ${key}`);
    }

    return value;
}

function parseAddressList(list) {
    if (!list) return [];
    return list
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map(getAddress);
}

const config = {
    rpcUrl: mustGetEnv('RPC_URL'),
    privateKey: mustGetEnv('PRIVATE_KEY'),
    commitmentSafe: getAddress(mustGetEnv('COMMITMENT_SAFE')),
    ogModule: getAddress(mustGetEnv('OG_MODULE')),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 10_000),
    startBlock: process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : undefined,
    watchAssets: parseAddressList(process.env.WATCH_ASSETS),
    watchNativeBalance:
        process.env.WATCH_NATIVE_BALANCE === undefined
            ? true
            : process.env.WATCH_NATIVE_BALANCE.toLowerCase() !== 'false',
    defaultDepositAsset: process.env.DEFAULT_DEPOSIT_ASSET
        ? getAddress(process.env.DEFAULT_DEPOSIT_ASSET)
        : undefined,
    defaultDepositAmountWei: process.env.DEFAULT_DEPOSIT_AMOUNT_WEI
        ? BigInt(process.env.DEFAULT_DEPOSIT_AMOUNT_WEI)
        : undefined,
    bondSpender: (process.env.BOND_SPENDER ?? 'og').toLowerCase(),
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiModel: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    openAiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
};

const account = privateKeyToAccount(config.privateKey);
const agentAddress = account.address;
const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
const walletClient = createWalletClient({ account, transport: http(config.rpcUrl) });

const trackedAssets = new Set(config.watchAssets);
let lastCheckedBlock = config.startBlock;
let lastNativeBalance;
let ogContext;

async function loadOptimisticGovernorDefaults() {
    const collateral = await publicClient.readContract({
        address: config.ogModule,
        abi: optimisticGovernorAbiV1,
        functionName: 'collateral',
    });

    trackedAssets.add(getAddress(collateral));
}

async function loadOgContext() {
    const [collateral, bondAmount, optimisticOracle, rules, identifier, liveness] = await Promise.all([
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbiV1,
            functionName: 'collateral',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbiV1,
            functionName: 'bondAmount',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbiV1,
            functionName: 'optimisticOracleV3',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbiV1,
            functionName: 'rules',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbiV1,
            functionName: 'identifier',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbiV1,
            functionName: 'liveness',
        }),
    ]);

    ogContext = {
        collateral,
        bondAmount,
        optimisticOracle,
        rules,
        identifier,
        liveness,
    };
}

async function logOgFundingStatus() {
    try {
        const chainId = await publicClient.getChainId();
        const expectedIdentifierStr =
            chainId === 11155111 ? 'ASSERT_TRUTH' : 'ASSERT_TRUTH2';
        const expectedIdentifier = stringToHex(expectedIdentifierStr, { size: 32 });

        const [collateral, bondAmount, optimisticOracle, identifier] = await Promise.all([
            publicClient.readContract({
                address: config.ogModule,
                abi: optimisticGovernorAbiV1,
                functionName: 'collateral',
            }),
            publicClient.readContract({
                address: config.ogModule,
                abi: optimisticGovernorAbiV1,
                functionName: 'bondAmount',
            }),
            publicClient.readContract({
                address: config.ogModule,
                abi: optimisticGovernorAbiV1,
                functionName: 'optimisticOracleV3',
            }),
            publicClient.readContract({
                address: config.ogModule,
                abi: optimisticGovernorAbiV1,
                functionName: 'identifier',
            }),
        ]);
        const minimumBond = await publicClient.readContract({
            address: optimisticOracle,
            abi: optimisticOracleAbi,
            functionName: 'getMinimumBond',
            args: [collateral],
        });

        const requiredBond = bondAmount > minimumBond ? bondAmount : minimumBond;
        const collateralBalance = await publicClient.readContract({
            address: collateral,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [account.address],
        });
        const nativeBalance = await publicClient.getBalance({ address: account.address });

        console.log('[agent] OG funding status:', {
            proposer: account.address,
            collateral,
            bondAmount: bondAmount.toString(),
            minimumBond: minimumBond.toString(),
            requiredBond: requiredBond.toString(),
            collateralBalance: collateralBalance.toString(),
            nativeBalance: nativeBalance.toString(),
            optimisticOracle,
            chainId,
            identifier,
            expectedIdentifier,
        });

        if (identifier !== expectedIdentifier) {
            console.warn(
                `[agent] OG identifier mismatch: expected ${expectedIdentifierStr}, onchain ${identifier}`
            );
        }
    } catch (error) {
        console.warn('[agent] Failed to log OG funding status:', error);
    }
}

async function primeBalances(blockNumber) {
    if (!config.watchNativeBalance) return;

    lastNativeBalance = await publicClient.getBalance({
        address: config.commitmentSafe,
        blockNumber,
    });
}

async function postBondAndPropose(transactions) {
    const proposerBalance = await publicClient.getBalance({ address: account.address });
    const [collateral, bondAmount, optimisticOracle] = await Promise.all([
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbiV1,
            functionName: 'collateral',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbiV1,
            functionName: 'bondAmount',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbiV1,
            functionName: 'optimisticOracleV3',
        }),
    ]);

    let minimumBond = 0n;
    try {
        minimumBond = await publicClient.readContract({
            address: optimisticOracle,
            abi: optimisticOracleAbi,
            functionName: 'getMinimumBond',
            args: [collateral],
        });
    } catch (error) {
        console.warn('[agent] Failed to fetch minimum bond from optimistic oracle:', error);
    }

    const requiredBond = bondAmount > minimumBond ? bondAmount : minimumBond;

    if (requiredBond > 0n) {
        const collateralBalance = await publicClient.readContract({
            address: collateral,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [account.address],
        });
        if (collateralBalance < requiredBond) {
            throw new Error(
                `Insufficient bond collateral balance: need ${requiredBond.toString()} wei, have ${collateralBalance.toString()}.`
            );
        }
        const spenders = [];
        if (config.bondSpender === 'og' || config.bondSpender === 'both') {
            spenders.push(config.ogModule);
        }
        if (config.bondSpender === 'oo' || config.bondSpender === 'both') {
            spenders.push(optimisticOracle);
        }

        for (const spender of spenders) {
            const approveHash = await walletClient.writeContract({
                address: collateral,
                abi: erc20Abi,
                functionName: 'approve',
                args: [spender, requiredBond],
            });
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            const allowance = await publicClient.readContract({
                address: collateral,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [account.address, spender],
            });
            if (allowance < requiredBond) {
                throw new Error(
                    `Insufficient bond allowance: need ${requiredBond.toString()} wei, have ${allowance.toString()} for spender ${spender}.`
                );
            }
        }
    }

    if (proposerBalance === 0n) {
        throw new Error(
            `Proposer ${account.address} has 0 native balance; cannot pay gas to propose.`
        );
    }

    const [allowanceOg, allowanceOo] = await Promise.all([
        publicClient.readContract({
            address: collateral,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [account.address, config.ogModule],
        }),
        publicClient.readContract({
            address: collateral,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [account.address, optimisticOracle],
        }),
    ]);

    console.log('[agent] Propose preflight:', {
        proposer: account.address,
        ogModule: config.ogModule,
        optimisticOracle,
        collateral,
        bondAmount: bondAmount.toString(),
        minimumBond: minimumBond.toString(),
        requiredBond: requiredBond.toString(),
        collateralBalance: (
            await publicClient.readContract({
                address: collateral,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [account.address],
            })
        ).toString(),
        allowanceOg: allowanceOg.toString(),
        allowanceOo: allowanceOo.toString(),
    });

    const proposalContext = {
        ogModule: config.ogModule,
        proposer: account.address,
        collateral,
        bondAmount: bondAmount.toString(),
        minimumBond: minimumBond.toString(),
        requiredBond: requiredBond.toString(),
        optimisticOracle,
    };

    let proposalHash;
    const explanation = 'Agent serving Oya commitment.';
    try {
        console.log('[agent] Propose signature: V2 (transactions, explanation)');
        await publicClient.simulateContract({
            address: config.ogModule,
            abi: optimisticGovernorAbiV2,
            functionName: 'proposeTransactions',
            args: [transactions, explanation],
            account: account.address,
        });
        proposalHash = await walletClient.writeContract({
            address: config.ogModule,
            abi: optimisticGovernorAbiV2,
            functionName: 'proposeTransactions',
            args: [transactions, explanation],
        });
    } catch (errorV2) {
        try {
            console.log('[agent] Propose signature: V1 (transactions)');
            await publicClient.simulateContract({
                address: config.ogModule,
                abi: optimisticGovernorAbiV1,
                functionName: 'proposeTransactions',
                args: [transactions],
                account: account.address,
            });
            proposalHash = await walletClient.writeContract({
                address: config.ogModule,
                abi: optimisticGovernorAbiV1,
                functionName: 'proposeTransactions',
                args: [transactions],
            });
        } catch (errorV1) {
            const message =
                errorV1?.shortMessage ??
                errorV1?.message ??
                errorV2?.shortMessage ??
                errorV2?.message ??
                String(errorV1 ?? errorV2);
            console.warn('[agent] Propose simulation context:', proposalContext);
            throw new Error(`Propose simulation failed: ${message}`);
        }
    }

    return { proposalHash, bondAmount, collateral, optimisticOracle };
}

async function makeDeposit({ asset, amountWei }) {
    const depositAsset = asset ? getAddress(asset) : config.defaultDepositAsset;
    const depositAmount =
        amountWei !== undefined ? amountWei : config.defaultDepositAmountWei;

    if (!depositAsset || depositAmount === undefined) {
        throw new Error('Deposit requires asset and amount (wei).');
    }

    if (depositAsset === zeroAddress) {
        return walletClient.sendTransaction({
            account,
            to: config.commitmentSafe,
            value: BigInt(depositAmount),
        });
    }

    return walletClient.writeContract({
        address: depositAsset,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [config.commitmentSafe, BigInt(depositAmount)],
    });
}

async function pollCommitmentChanges() {
    const latestBlock = await publicClient.getBlockNumber();
    if (lastCheckedBlock === undefined) {
        lastCheckedBlock = latestBlock;
        await primeBalances(latestBlock);
        return [];
    }

    if (latestBlock <= lastCheckedBlock) {
        return [];
    }

    const fromBlock = lastCheckedBlock + 1n;
    const toBlock = latestBlock;
    const deposits = [];

    for (const asset of trackedAssets) {
        const logs = await publicClient.getLogs({
            address: asset,
            event: transferEvent,
            args: { to: config.commitmentSafe },
            fromBlock,
            toBlock,
        });

        for (const log of logs) {
            deposits.push({
                kind: 'erc20Deposit',
                asset,
                from: log.args.from,
                amount: log.args.value,
                blockNumber: log.blockNumber,
                transactionHash: log.transactionHash,
            });
        }
    }

    if (config.watchNativeBalance) {
        const nativeBalance = await publicClient.getBalance({
            address: config.commitmentSafe,
            blockNumber: toBlock,
        });

        if (lastNativeBalance !== undefined && nativeBalance > lastNativeBalance) {
            deposits.push({
                kind: 'nativeDeposit',
                asset: zeroAddress,
                from: 'unknown',
                amount: nativeBalance - lastNativeBalance,
                blockNumber: toBlock,
                transactionHash: undefined,
            });
        }

        lastNativeBalance = nativeBalance;
    }

    lastCheckedBlock = toBlock;
    return deposits;
}

async function decideOnSignals(signals) {
    console.log(`[agent] ${signals.length} change(s) detected.`);

    if (!config.openAiApiKey) {
        console.log('[agent] OPENAI_API_KEY not set; logging signals only.');
        for (const signal of signals) {
            console.log(signal);
        }
        return;
    }

    if (!ogContext) {
        await loadOgContext();
    }

    try {
        const decision = await callAgent(signals, ogContext);
        if (decision.toolCalls.length > 0) {
            console.log('[agent] Agent tool calls:', decision.toolCalls);
            const toolOutputs = await executeToolCalls(decision.toolCalls);
            if (decision.responseId && toolOutputs.length > 0) {
                const explanation = await explainToolCalls(
                    decision.responseId,
                    toolOutputs
                );
                if (explanation) {
                    console.log('[agent] Agent explanation:', explanation);
                }
            }
            return;
        }
        console.log('[agent] Agent decision:', decision.textDecision);
    } catch (error) {
        console.error('[agent] Agent call failed; logging signals', error);
        for (const signal of signals) {
            console.log(signal);
        }
    }
}

async function agentLoop() {
    try {
        console.log(`[agent] loop tick @ ${new Date().toISOString()}`);
        const signals = await pollCommitmentChanges();

        if (signals.length > 0) {
            await decideOnSignals(signals);
        }
    } catch (error) {
        console.error('[agent] loop error', error);
    }

    setTimeout(agentLoop, config.pollIntervalMs);
}

async function startAgent() {
    console.log('[agent] initializing...');
    await loadOptimisticGovernorDefaults();
    await loadOgContext();
    await logOgFundingStatus();

    if (lastCheckedBlock === undefined) {
        lastCheckedBlock = await publicClient.getBlockNumber();
    }

    await primeBalances(lastCheckedBlock);

    console.log('[agent] watching assets:', [...trackedAssets].join(', '));
    console.log('[agent] starting loop with interval', config.pollIntervalMs, 'ms');

    agentLoop();
}

async function callAgent(signals, context) {
    const systemPrompt =
        'You are an agent monitoring an onchain commitment (Safe + Optimistic Governor). Your own address is provided in the input as agentAddress; use it when rules refer to “the agent/themselves”. Given signals and rules, recommend a course of action. Prefer no-op when unsure. If an onchain action is needed, call a tool. Use build_og_transactions to construct proposal payloads, then post_bond_and_propose. If no action is needed, output strict JSON with keys: action (propose|deposit|ignore|other) and rationale (string).';

    const safeSignals = signals.map((signal) => ({
        ...signal,
        amount: signal.amount !== undefined ? signal.amount.toString() : undefined,
        blockNumber: signal.blockNumber !== undefined ? signal.blockNumber.toString() : undefined,
        transactionHash: signal.transactionHash ? String(signal.transactionHash) : undefined,
    }));

    const safeContext = {
        rules: context?.rules,
        identifier: context?.identifier ? String(context.identifier) : undefined,
        liveness: context?.liveness !== undefined ? context.liveness.toString() : undefined,
        collateral: context?.collateral,
        bondAmount: context?.bondAmount !== undefined ? context.bondAmount.toString() : undefined,
        optimisticOracle: context?.optimisticOracle,
    };

    const payload = {
        model: config.openAiModel,
        input: [
            {
                role: 'system',
                content: systemPrompt,
            },
            {
                role: 'user',
                content: JSON.stringify({
                    commitmentSafe: config.commitmentSafe,
                    ogModule: config.ogModule,
                    agentAddress,
                    ogContext: safeContext,
                    signals: safeSignals,
                }),
            },
        ],
        tools: toolDefinitions(),
        tool_choice: 'auto',
        parallel_tool_calls: false,
        text: { format: { type: 'json_object' } },
    };

    const res = await fetch(`${config.openAiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.openAiApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI API error: ${res.status} ${text}`);
    }

    const json = await res.json();
    const toolCalls = extractToolCalls(json);
    const raw = extractFirstText(json);
    let textDecision;
    if (raw) {
        try {
            textDecision = JSON.parse(raw);
        } catch (error) {
            throw new Error(`Failed to parse OpenAI JSON: ${raw}`);
        }
    }

    return { toolCalls, textDecision, responseId: json?.id };
}

function extractFirstText(responseJson) {
    // Responses API structure: output -> [{ content: [{ type: 'output_text', text: '...' }, ...] }, ...]
    const outputs = responseJson?.output;
    if (!Array.isArray(outputs)) return '';

    for (const item of outputs) {
        if (!item?.content) continue;
        for (const chunk of item.content) {
            if (chunk?.text) return chunk.text;
            if (chunk?.output_text) return chunk.output_text?.text ?? '';
            if (chunk?.text?.value) return chunk.text.value; // older shape
        }
    }

    return '';
}

function extractToolCalls(responseJson) {
    const outputs = responseJson?.output;
    if (!Array.isArray(outputs)) return [];

    const toolCalls = [];
    for (const item of outputs) {
        if (item?.type === 'tool_call' || item?.type === 'function_call') {
            toolCalls.push({
                name: item?.name ?? item?.function?.name,
                arguments: item?.arguments ?? item?.function?.arguments,
                callId: item?.call_id ?? item?.id,
            });
            continue;
        }

        if (Array.isArray(item?.tool_calls)) {
            for (const call of item.tool_calls) {
                toolCalls.push({
                    name: call?.name ?? call?.function?.name,
                    arguments: call?.arguments ?? call?.function?.arguments,
                    callId: call?.call_id ?? call?.id,
                });
            }
        }
    }

    return toolCalls.filter((call) => call.name);
}

function toolDefinitions() {
    return [
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
                                    items: { type: 'string' },
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
        {
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
                        description:
                            'Safe transaction batch to propose. Use value as string wei.',
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
        },
    ];
}

async function executeToolCalls(toolCalls) {
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
            const transactions = args.transactions.map((tx) => ({
                to: getAddress(tx.to),
                value: BigInt(tx.value),
                data: tx.data,
                operation: Number(tx.operation),
            }));
            const result = await postBondAndPropose(transactions);
            outputs.push({
                callId: call.callId,
                output: JSON.stringify({
                    status: 'submitted',
                    ...result,
                }),
            });
            continue;
        }

        console.warn('[agent] Unknown tool call:', call.name);
        outputs.push({
            callId: call.callId,
            output: JSON.stringify({ status: 'skipped', reason: 'unknown tool' }),
        });
    }
    if (builtTransactions && !hasPostProposal) {
        const result = await postBondAndPropose(builtTransactions);
        console.log('[agent] Auto-proposed via OG:', result);
    }
    return outputs.filter((item) => item.callId);
}

function buildOgTransactions(actions) {
    if (!Array.isArray(actions) || actions.length === 0) {
        throw new Error('actions must be a non-empty array');
    }

    return actions.map((action) => {
        const operation = action.operation !== undefined ? Number(action.operation) : 0;

        if (action.kind === 'erc20_transfer') {
            if (!action.token || !action.to || action.amountWei === undefined) {
                throw new Error('erc20_transfer requires token, to, amountWei');
            }

            const data = encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [getAddress(action.to), BigInt(action.amountWei)],
            });

            return {
                to: getAddress(action.token),
                value: '0',
                data,
                operation,
            };
        }

        if (action.kind === 'native_transfer') {
            if (!action.to || action.amountWei === undefined) {
                throw new Error('native_transfer requires to, amountWei');
            }

            return {
                to: getAddress(action.to),
                value: BigInt(action.amountWei).toString(),
                data: '0x',
                operation,
            };
        }

        if (action.kind === 'contract_call') {
            if (!action.to || !action.abi) {
                throw new Error('contract_call requires to, abi');
            }

            const abi = parseAbi([`function ${action.abi}`]);
            const args = Array.isArray(action.args) ? action.args : [];
            const data = encodeFunctionData({
                abi,
                functionName: action.abi.split('(')[0],
                args,
            });
            const value = action.valueWei !== undefined ? BigInt(action.valueWei).toString() : '0';

            return {
                to: getAddress(action.to),
                value,
                data,
                operation,
            };
        }

        throw new Error(`Unknown action kind: ${action.kind}`);
    });
}

function parseToolArguments(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch (error) {
            return null;
        }
    }
    return null;
}

async function explainToolCalls(previousResponseId, toolOutputs) {
    const input = [
        ...toolOutputs.map((item) => ({
            type: 'function_call_output',
            call_id: item.callId,
            output: item.output,
        })),
        {
            type: 'message',
            role: 'user',
            content: [
                {
                    type: 'input_text',
                    text: 'Summarize the actions you took and why.',
                },
            ],
        },
    ];

    const res = await fetch(`${config.openAiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.openAiApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: config.openAiModel,
            previous_response_id: previousResponseId,
            input,
        }),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI API error: ${res.status} ${text}`);
    }

    const json = await res.json();
    return extractFirstText(json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    startAgent().catch((error) => {
        console.error('[agent] failed to start', error);
        process.exit(1);
    });
}

export { makeDeposit, postBondAndPropose, startAgent };
