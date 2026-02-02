import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';
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
import { privateKeyToAccount, toAccount } from 'viem/accounts';

const optimisticGovernorAbi = parseAbi([
    'function proposeTransactions((address to,uint8 operation,uint256 value,bytes data)[] transactions, bytes explanation)',
    'function executeProposal((address to,uint8 operation,uint256 value,bytes data)[] transactions)',
    'function collateral() view returns (address)',
    'function bondAmount() view returns (uint256)',
    'function optimisticOracleV3() view returns (address)',
    'function rules() view returns (string)',
    'function identifier() view returns (bytes32)',
    'function liveness() view returns (uint64)',
    'function assertionIds(bytes32) view returns (bytes32)',
]);

const optimisticOracleAbi = parseAbi([
    'function getMinimumBond(address collateral) view returns (uint256)',
]);

const transferEvent = parseAbiItem(
    'event Transfer(address indexed from, address indexed to, uint256 value)'
);
const transactionsProposedEvent = parseAbiItem(
    'event TransactionsProposed(address indexed proposer,uint256 indexed proposalTime,bytes32 indexed assertionId,((address to,uint8 operation,uint256 value,bytes data)[] transactions,uint256 requestTime) proposal,bytes32 proposalHash,bytes explanation,string rules,uint256 challengeWindowEnds)'
);
const proposalExecutedEvent = parseAbiItem(
    'event ProposalExecuted(bytes32 indexed proposalHash, bytes32 indexed assertionId)'
);
const proposalDeletedEvent = parseAbiItem(
    'event ProposalDeleted(bytes32 indexed proposalHash, bytes32 indexed assertionId)'
);

function mustGetEnv(key) {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required env var ${key}`);
    }

    return value;
}

function normalizePrivateKey(value) {
    if (!value) return value;
    return value.startsWith('0x') ? value : `0x${value}`;
}

const execFileAsync = promisify(execFile);

async function loadPrivateKeyFromKeystore() {
    const keystorePath = mustGetEnv('KEYSTORE_PATH');
    const keystorePassword = mustGetEnv('KEYSTORE_PASSWORD');
    const keystoreJson = await readFile(keystorePath, 'utf8');
    const wallet = await Wallet.fromEncryptedJson(keystoreJson, keystorePassword);
    return wallet.privateKey;
}

async function loadPrivateKeyFromKeychain() {
    const service = mustGetEnv('KEYCHAIN_SERVICE');
    const account = mustGetEnv('KEYCHAIN_ACCOUNT');

    if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('security', [
            'find-generic-password',
            '-s',
            service,
            '-a',
            account,
            '-w',
        ]);
        return stdout.trim();
    }

    if (process.platform === 'linux') {
        const { stdout } = await execFileAsync('secret-tool', [
            'lookup',
            'service',
            service,
            'account',
            account,
        ]);
        return stdout.trim();
    }

    throw new Error('Keychain lookup not supported on this platform.');
}

async function loadPrivateKeyFromVault() {
    const vaultAddr = mustGetEnv('VAULT_ADDR').replace(/\/+$/, '');
    const vaultToken = mustGetEnv('VAULT_TOKEN');
    const vaultPath = mustGetEnv('VAULT_SECRET_PATH').replace(/^\/+/, '');
    const vaultNamespace = process.env.VAULT_NAMESPACE;
    const vaultKeyField = process.env.VAULT_SECRET_KEY ?? 'private_key';

    const response = await fetch(`${vaultAddr}/v1/${vaultPath}`, {
        headers: {
            'X-Vault-Token': vaultToken,
            ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
        },
    });

    if (!response.ok) {
        throw new Error(`Vault request failed (${response.status}).`);
    }

    const payload = await response.json();
    const data = payload?.data?.data ?? payload?.data ?? {};
    const value = data[vaultKeyField];
    if (!value) {
        throw new Error(`Vault secret missing key '${vaultKeyField}'.`);
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
    allowProposeOnSimulationFail: true,
    proposeGasLimit: process.env.PROPOSE_GAS_LIMIT
        ? BigInt(process.env.PROPOSE_GAS_LIMIT)
        : 2_000_000n,
    executeRetryMs: Number(process.env.EXECUTE_RETRY_MS ?? 60_000),
};

const publicClient = createPublicClient({ transport: http(config.rpcUrl) });

async function createSignerClient() {
    const signerType = (process.env.SIGNER_TYPE ?? 'env').toLowerCase();

    if (signerType === 'env') {
        const privateKey = normalizePrivateKey(mustGetEnv('PRIVATE_KEY'));
        const account = privateKeyToAccount(privateKey);
        return {
            account,
            walletClient: createWalletClient({ account, transport: http(config.rpcUrl) }),
        };
    }

    if (signerType === 'keystore') {
        const privateKey = normalizePrivateKey(await loadPrivateKeyFromKeystore());
        const account = privateKeyToAccount(privateKey);
        return {
            account,
            walletClient: createWalletClient({ account, transport: http(config.rpcUrl) }),
        };
    }

    if (signerType === 'keychain') {
        const privateKey = normalizePrivateKey(await loadPrivateKeyFromKeychain());
        const account = privateKeyToAccount(privateKey);
        return {
            account,
            walletClient: createWalletClient({ account, transport: http(config.rpcUrl) }),
        };
    }

    if (signerType === 'vault') {
        const privateKey = normalizePrivateKey(await loadPrivateKeyFromVault());
        const account = privateKeyToAccount(privateKey);
        return {
            account,
            walletClient: createWalletClient({ account, transport: http(config.rpcUrl) }),
        };
    }

    if (['kms', 'vault-signer', 'signer-rpc', 'rpc', 'json-rpc'].includes(signerType)) {
        const signerRpcUrl = mustGetEnv('SIGNER_RPC_URL');
        const signerAddress = getAddress(mustGetEnv('SIGNER_ADDRESS'));
        const account = toAccount(signerAddress);
        return {
            account,
            walletClient: createWalletClient({ account, transport: http(signerRpcUrl) }),
        };
    }

    throw new Error(`Unsupported SIGNER_TYPE '${signerType}'.`);
}

const { account, walletClient } = await createSignerClient();
const agentAddress = account.address;

const trackedAssets = new Set(config.watchAssets);
let lastCheckedBlock = config.startBlock;
let lastProposalCheckedBlock = config.startBlock;
let lastNativeBalance;
let ogContext;
const proposalsByHash = new Map();
const zeroBytes32 = `0x${'0'.repeat(64)}`;

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

async function logOgFundingStatus() {
    try {
        const chainId = await publicClient.getChainId();
        const expectedIdentifierStr =
            chainId === 11155111 ? 'ASSERT_TRUTH' : 'ASSERT_TRUTH2';
        const expectedIdentifier = stringToHex(expectedIdentifierStr, { size: 32 });

        const [collateral, bondAmount, optimisticOracle, identifier] = await Promise.all([
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
    const normalizedTransactions = normalizeOgTransactions(transactions);
    const proposerBalance = await publicClient.getBalance({ address: account.address });
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

    let proposalHash;
    const explanation = 'Agent serving Oya commitment.';
    const explanationBytes = stringToHex(explanation);
    const proposalData = encodeFunctionData({
        abi: optimisticGovernorAbi,
        functionName: 'proposeTransactions',
        args: [normalizedTransactions, explanationBytes],
    });
    let simulationError;
    let submissionError;
    try {
        await publicClient.simulateContract({
            address: config.ogModule,
            abi: optimisticGovernorAbi,
            functionName: 'proposeTransactions',
            args: [normalizedTransactions, explanationBytes],
            account: account.address,
        });
    } catch (error) {
        simulationError = error;
        if (!config.allowProposeOnSimulationFail) {
            throw error;
        }
        console.warn('[agent] Simulation failed; attempting to propose anyway.');
    }

    try {
        if (simulationError) {
            proposalHash = await walletClient.sendTransaction({
                account,
                to: config.ogModule,
                data: proposalData,
                value: 0n,
                gas: config.proposeGasLimit,
            });
        } else {
            proposalHash = await walletClient.writeContract({
                address: config.ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'proposeTransactions',
                args: [normalizedTransactions, explanationBytes],
            });
        }
    } catch (error) {
        submissionError = error;
        const message =
            error?.shortMessage ??
            error?.message ??
            simulationError?.shortMessage ??
            simulationError?.message ??
            String(error ?? simulationError);
        console.warn('[agent] Propose submission failed:', message);
    }

    if (proposalHash) {
        console.log('[agent] Proposal submitted:', proposalHash);
    }

    return {
        proposalHash,
        bondAmount,
        collateral,
        optimisticOracle,
        submissionError: submissionError ? summarizeViemError(submissionError) : null,
    };
}

function normalizeOgTransactions(transactions) {
    if (!Array.isArray(transactions)) {
        throw new Error('transactions must be an array');
    }

    return transactions.map((tx, index) => {
        if (!tx || !tx.to) {
            throw new Error(`transactions[${index}] missing to`);
        }

        return {
            to: getAddress(tx.to),
            value: BigInt(tx.value ?? 0),
            data: tx.data ?? '0x',
            operation: Number(tx.operation ?? 0),
        };
    });
}

function summarizeViemError(error) {
    if (!error) return null;

    return {
        name: error.name,
        shortMessage: error.shortMessage,
        message: error.message,
        details: error.details,
        metaMessages: error.metaMessages,
        data: error.data ?? error.cause?.data,
        cause: error.cause?.shortMessage ?? error.cause?.message ?? error.cause,
    };
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

async function pollProposalChanges() {
    const latestBlock = await publicClient.getBlockNumber();
    if (lastProposalCheckedBlock === undefined) {
        lastProposalCheckedBlock = latestBlock;
        return;
    }

    if (latestBlock <= lastProposalCheckedBlock) {
        return;
    }

    const fromBlock = lastProposalCheckedBlock + 1n;
    const toBlock = latestBlock;

    const [proposedLogs, executedLogs, deletedLogs] = await Promise.all([
        publicClient.getLogs({
            address: config.ogModule,
            event: transactionsProposedEvent,
            fromBlock,
            toBlock,
        }),
        publicClient.getLogs({
            address: config.ogModule,
            event: proposalExecutedEvent,
            fromBlock,
            toBlock,
        }),
        publicClient.getLogs({
            address: config.ogModule,
            event: proposalDeletedEvent,
            fromBlock,
            toBlock,
        }),
    ]);

    for (const log of proposedLogs) {
        const proposalHash = log.args?.proposalHash;
        const assertionId = log.args?.assertionId;
        const proposal = log.args?.proposal;
        const challengeWindowEnds = log.args?.challengeWindowEnds;
        if (!proposalHash || !proposal?.transactions) continue;

        const transactions = proposal.transactions.map((tx) => ({
            to: getAddress(tx.to),
            operation: Number(tx.operation ?? 0),
            value: BigInt(tx.value ?? 0),
            data: tx.data ?? '0x',
        }));

        proposalsByHash.set(proposalHash, {
            proposalHash,
            assertionId,
            challengeWindowEnds: BigInt(challengeWindowEnds ?? 0),
            transactions,
            lastAttemptMs: 0,
        });
    }

    for (const log of executedLogs) {
        const proposalHash = log.args?.proposalHash;
        if (proposalHash) {
            proposalsByHash.delete(proposalHash);
        }
    }

    for (const log of deletedLogs) {
        const proposalHash = log.args?.proposalHash;
        if (proposalHash) {
            proposalsByHash.delete(proposalHash);
        }
    }

    lastProposalCheckedBlock = toBlock;
}

async function executeReadyProposals() {
    if (proposalsByHash.size === 0) return;

    const latestBlock = await publicClient.getBlockNumber();
    const block = await publicClient.getBlock({ blockNumber: latestBlock });
    const now = BigInt(block.timestamp);
    const nowMs = Date.now();

    for (const proposal of proposalsByHash.values()) {
        if (!proposal?.transactions?.length) continue;
        if (proposal.challengeWindowEnds === undefined) continue;
        if (now < proposal.challengeWindowEnds) continue;
        if (proposal.lastAttemptMs && nowMs - proposal.lastAttemptMs < config.executeRetryMs) {
            continue;
        }

        proposal.lastAttemptMs = nowMs;

        let assertionId;
        try {
            assertionId = await publicClient.readContract({
                address: config.ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'assertionIds',
                args: [proposal.proposalHash],
            });
        } catch (error) {
            console.warn('[agent] Failed to read assertionId:', error);
            continue;
        }

        if (!assertionId || assertionId === zeroBytes32) {
            proposalsByHash.delete(proposal.proposalHash);
            continue;
        }

        try {
            await publicClient.simulateContract({
                address: config.ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'executeProposal',
                args: [proposal.transactions],
                account: account.address,
            });
        } catch (error) {
            console.warn('[agent] Proposal not executable yet:', proposal.proposalHash);
            continue;
        }

        try {
            const txHash = await walletClient.writeContract({
                address: config.ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'executeProposal',
                args: [proposal.transactions],
            });
            console.log('[agent] Proposal execution submitted:', txHash);
        } catch (error) {
            console.warn('[agent] Proposal execution failed:', error?.shortMessage ?? error?.message ?? error);
        }
    }
}

async function decideOnSignals(signals) {
    if (!config.openAiApiKey) {
        return;
    }

    if (!ogContext) {
        await loadOgContext();
    }

    try {
        const decision = await callAgent(signals, ogContext);
        if (decision.toolCalls.length > 0) {
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
    } catch (error) {
        console.error('[agent] Agent call failed', error);
    }
}

async function agentLoop() {
    try {
        const signals = await pollCommitmentChanges();
        await pollProposalChanges();

        if (signals.length > 0) {
            await decideOnSignals(signals);
        }

        await executeReadyProposals();
    } catch (error) {
        console.error('[agent] loop error', error);
    }

    setTimeout(agentLoop, config.pollIntervalMs);
}

async function startAgent() {
    await loadOptimisticGovernorDefaults();
    await loadOgContext();
    await logOgFundingStatus();

    if (lastCheckedBlock === undefined) {
        lastCheckedBlock = await publicClient.getBlockNumber();
    }
    if (lastProposalCheckedBlock === undefined) {
        lastProposalCheckedBlock = lastCheckedBlock;
    }

    await primeBalances(lastCheckedBlock);

    console.log('[agent] running...');

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
