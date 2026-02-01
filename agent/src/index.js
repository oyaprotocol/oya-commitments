import 'dotenv/config';
import {
    createPublicClient,
    createWalletClient,
    erc20Abi,
    getAddress,
    http,
    parseAbi,
    parseAbiItem,
    zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const optimisticGovernorAbi = parseAbi([
    'function proposeTransactions((address to,uint256 value,bytes data,uint8 operation)[] transactions) returns (bytes32 proposalHash)',
    'function collateral() view returns (address)',
    'function bondAmount() view returns (uint256)',
    'function optimisticOracleV3() view returns (address)',
    'function rules() view returns (string)',
    'function identifier() view returns (bytes32)',
    'function liveness() view returns (uint64)',
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
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60_000),
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
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiModel: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    openAiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
};

const account = privateKeyToAccount(config.privateKey);
const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
const walletClient = createWalletClient({ account, transport: http(config.rpcUrl) });

const trackedAssets = new Set(config.watchAssets);
let lastCheckedBlock = config.startBlock;
let lastNativeBalance;
let ogContext;

async function loadOptimisticGovernorDefaults() {
    const collateral = await publicClient.readContract({
        address: config.ogModule,
        abi: optimisticGovernorAbi,
        functionName: 'collateral',
    });

    trackedAssets.add(getAddress(collateral));
}

async function loadOgContext() {
    const [collateral, bondAmount, optimisticOracle, rules, identifier, liveness] = await Promise.all([
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'collateral',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'bondAmount',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'optimisticOracleV3',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'rules',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'identifier',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbi,
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

async function primeBalances(blockNumber) {
    if (!config.watchNativeBalance) return;

    lastNativeBalance = await publicClient.getBalance({
        address: config.commitmentSafe,
        blockNumber,
    });
}

async function postBondAndPropose(transactions) {
    const [collateral, bondAmount, optimisticOracle] = await Promise.all([
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'collateral',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'bondAmount',
        }),
        publicClient.readContract({
            address: config.ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'optimisticOracleV3',
        }),
    ]);

    if (bondAmount > 0n) {
        await walletClient.writeContract({
            address: collateral,
            abi: erc20Abi,
            functionName: 'approve',
            args: [optimisticOracle, bondAmount],
        });
    }

    const proposalHash = await walletClient.writeContract({
        address: config.ogModule,
        abi: optimisticGovernorAbi,
        functionName: 'proposeTransactions',
        args: [transactions],
    });

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
        'You are an agent monitoring an onchain commitment (Safe + Optimistic Governor). Given signals and rules, recommend a course of action. Prefer no-op when unsure. If an onchain action is needed, call a tool. If no action is needed, output strict JSON with keys: action (propose|deposit|ignore|other) and rationale (string).';

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
    for (const call of toolCalls) {
        const args = parseToolArguments(call.arguments);
        if (!args) {
            console.warn('[agent] Skipping tool call with invalid args:', call);
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
    return outputs.filter((item) => item.callId);
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
            type: 'input_text',
            text: 'Summarize the actions you took and why.',
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
