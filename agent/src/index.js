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
};

const account = privateKeyToAccount(config.privateKey);
const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
const walletClient = createWalletClient({ account, transport: http(config.rpcUrl) });

const trackedAssets = new Set(config.watchAssets);
let lastCheckedBlock = config.startBlock;
let lastNativeBalance;

async function loadOptimisticGovernorDefaults() {
    const collateral = await publicClient.readContract({
        address: config.ogModule,
        abi: optimisticGovernorAbi,
        functionName: 'collateral',
    });

    trackedAssets.add(getAddress(collateral));
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
    // Hook for LLM/decision making; left generic on purpose.
    console.log(`[agent] ${signals.length} change(s) detected; plug in decision logic here.`);
    for (const signal of signals) {
        console.log(signal);
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

    if (lastCheckedBlock === undefined) {
        lastCheckedBlock = await publicClient.getBlockNumber();
    }

    await primeBalances(lastCheckedBlock);

    console.log('[agent] watching assets:', [...trackedAssets].join(', '));
    console.log('[agent] starting loop with interval', config.pollIntervalMs, 'ms');

    agentLoop();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    startAgent().catch((error) => {
        console.error('[agent] failed to start', error);
        process.exit(1);
    });
}

export { makeDeposit, postBondAndPropose, startAgent };
