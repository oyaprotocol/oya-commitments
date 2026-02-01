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
        console.log('[agent] Agent decision:', decision);
        // Map decision to actions here (e.g., postBondAndPropose/makeDeposit) after validation.
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
        'You are an agent monitoring an onchain commitment (Safe + Optimistic Governor). Given signals and rules, recommend a course of action. Prefer no-op when unsure. Output strict JSON with keys: action (propose|deposit|ignore|other), rationale (string), transactions (optional array of {to,value,data,operation}), deposit (optional {asset,amountWei}).';

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
    const raw = extractFirstText(json);
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`Failed to parse OpenAI JSON: ${raw}`);
    }
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

if (import.meta.url === `file://${process.argv[1]}`) {
    startAgent().catch((error) => {
        console.error('[agent] failed to start', error);
        process.exit(1);
    });
}

export { makeDeposit, postBondAndPropose, startAgent };
