import { erc20Abi, parseAbi } from 'viem';
import {
    normalizeAddressOrNull,
    normalizeAddressOrThrow,
    normalizeHashOrNull,
    decodeErc20TransferCallData,
} from '../../../agent/src/lib/utils.js';
import {
    transferEvent,
    proposalDeletedEvent,
    proposalExecutedEvent,
    transactionsProposedEvent,
} from '../../../agent/src/lib/og.js';

const CHAINLINK_ETH_USD_FEED_SEPOLIA = '0x694AA1769357215DE4FAC081bf1f309aDC325306';
const POLICY = Object.freeze({
    usdcAddress: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
    wethAddress: '0x7b79995e5f793a07bc00c21412e50ecae098e7f9',
    chainlinkEthUsdFeed: CHAINLINK_ETH_USD_FEED_SEPOLIA,
    tranchesPerCampaign: 4,
    trancheIntervalMs: 6 * 60 * 60 * 1000,
    feeBps: 50n,
    bpsDenominator: 10_000n,
    logChunkSize: 5_000n,
});
let cachedAutoStartBlock = null;
let autoDiscoveryFailed = false;

const chainlinkAbi = parseAbi([
    'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

function getSystemPrompt({ proposeEnabled, disputeEnabled, commitmentText }) {
    const mode = proposeEnabled && disputeEnabled
        ? 'You may propose and dispute.'
        : proposeEnabled
          ? 'You may propose but you may not dispute.'
          : disputeEnabled
            ? 'You may dispute but you may not propose.'
            : 'You may not propose or dispute; provide opinions only.';

    return [
        'You are a deterministic DCA reimbursement agent. This module computes actions directly from onchain history and does not rely on LLM reasoning.',
        mode,
        commitmentText ? `\nCommitment:\n${commitmentText}` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

function augmentSignals(signals, { nowMs } = {}) {
    return [
        ...signals,
        {
            kind: 'deterministicTick',
            nowMs: nowMs ?? Date.now(),
        },
    ];
}

function toChronologicalSortKey(entry) {
    const block = BigInt(entry.blockNumber ?? 0n);
    const logIndex = BigInt(entry.logIndex ?? 0n);
    return block * 1_000_000n + logIndex;
}

function sortByChainOrder(entries) {
    return [...entries].sort((a, b) => {
        const left = toChronologicalSortKey(a);
        const right = toChronologicalSortKey(b);
        if (left === right) return 0;
        return left < right ? -1 : 1;
    });
}

async function getLogsChunked({ publicClient, address, event, args, fromBlock, toBlock }) {
    if (fromBlock > toBlock) return [];

    const logs = [];
    let currentFrom = fromBlock;
    while (currentFrom <= toBlock) {
        const currentTo = currentFrom + POLICY.logChunkSize - 1n > toBlock
            ? toBlock
            : currentFrom + POLICY.logChunkSize - 1n;

        const chunk = await publicClient.getLogs({
            address,
            event,
            args,
            fromBlock: currentFrom,
            toBlock: currentTo,
        });
        logs.push(...chunk);
        currentFrom = currentTo + 1n;
    }

    return logs;
}

function hasContractCode(code) {
    return typeof code === 'string' && code !== '0x';
}

async function findContractDeploymentBlock({ publicClient, address, latestBlock }) {
    const latestCode = await publicClient.getCode({
        address,
        blockNumber: latestBlock,
    });
    if (!hasContractCode(latestCode)) {
        return null;
    }

    let left = 0n;
    let right = latestBlock;
    while (left < right) {
        const middle = (left + right) / 2n;
        const codeAtMiddle = await publicClient.getCode({
            address,
            blockNumber: middle,
        });
        if (hasContractCode(codeAtMiddle)) {
            right = middle;
        } else {
            left = middle + 1n;
        }
    }

    return left;
}

async function resolveScanStartBlock({ publicClient, config, latestBlock }) {
    if (config?.startBlock !== undefined) {
        return BigInt(config.startBlock);
    }
    if (cachedAutoStartBlock !== null) {
        return cachedAutoStartBlock;
    }
    if (autoDiscoveryFailed) {
        return null;
    }

    try {
        const discovered = await findContractDeploymentBlock({
            publicClient,
            address: config.ogModule,
            latestBlock,
        });
        if (discovered === null) {
            autoDiscoveryFailed = true;
            console.warn(
                '[deterministic-dca-agent] Auto-discovery failed: ogModule has no code at latest block.'
            );
            return null;
        }
        cachedAutoStartBlock = discovered;
        console.log(
            `[deterministic-dca-agent] Auto-discovered scan start block from OG deployment: ${discovered.toString()}`
        );
        return discovered;
    } catch (error) {
        autoDiscoveryFailed = true;
        console.warn(
            '[deterministic-dca-agent] Failed to auto-discover scan start block; set START_BLOCK explicitly.',
            error?.message ?? error
        );
        return null;
    }
}

async function getBlockTimestampMs(publicClient, blockNumber, cache) {
    const key = blockNumber.toString();
    if (cache.has(key)) {
        return cache.get(key);
    }

    const block = await publicClient.getBlock({ blockNumber });
    const timestampMs = Number(block.timestamp) * 1000;
    cache.set(key, timestampMs);
    return timestampMs;
}

function splitReimbursementTranches(totalUsdcWei) {
    const trancheCount = BigInt(POLICY.tranchesPerCampaign);
    const base = totalUsdcWei / trancheCount;
    const remainder = totalUsdcWei - base * trancheCount;

    const tranches = [];
    for (let i = 0; i < POLICY.tranchesPerCampaign; i += 1) {
        if (i < POLICY.tranchesPerCampaign - 1) {
            tranches.push(base);
        } else {
            tranches.push(base + remainder);
        }
    }

    return tranches;
}

function computeFillNotionalUsdcWei(reimbursementUsdcWei) {
    return (reimbursementUsdcWei * (POLICY.bpsDenominator - POLICY.feeBps)) / POLICY.bpsDenominator;
}

function computeWethAmountWei({ fillNotionalUsdcWei, chainlinkAnswer }) {
    // fillNotionalUsdcWei has 6 decimals; Chainlink answer has 8 decimals.
    // wethWei = floor(fillUsd * 1e18 / ethPriceUsd)
    //         = floor(fillNotionalUsdcWei * 1e20 / chainlinkAnswer)
    const scale = 10n ** 20n;
    return (fillNotionalUsdcWei * scale) / chainlinkAnswer;
}

function buildCampaigns({ deposits, reimbursementRecords, agentFillDeposits }) {
    const campaigns = deposits.map((deposit, index) => {
        const reimbursementTranches = splitReimbursementTranches(deposit.amountWei);
        return {
            campaignIndex: index,
            deposit,
            reimbursementTranches,
            fillNotionalTranches: reimbursementTranches.map((amountWei) =>
                computeFillNotionalUsdcWei(amountWei)
            ),
            reimbursementRecords: [],
            proposalCount: 0,
            executedCount: 0,
            pendingCount: 0,
            agentFillCount: 0,
            unpairedFillCount: 0,
        };
    });

    let reimbursementCursor = 0;
    for (const campaign of campaigns) {
        for (let trancheIndex = 0; trancheIndex < POLICY.tranchesPerCampaign; trancheIndex += 1) {
            const record = reimbursementRecords[reimbursementCursor];
            if (!record) break;

            const expectedAmount = campaign.reimbursementTranches[trancheIndex];
            if (record.amountWei !== expectedAmount) {
                break;
            }

            campaign.reimbursementRecords.push({ ...record, trancheIndex });
            campaign.proposalCount += 1;
            if (record.status === 'executed') {
                campaign.executedCount += 1;
            }
            if (record.status === 'pending') {
                campaign.pendingCount += 1;
                reimbursementCursor += 1;
                break;
            }

            reimbursementCursor += 1;
        }
    }

    const unmatchedReimbursements = reimbursementRecords.length - reimbursementCursor;

    const proposalCountTotal = campaigns.reduce((acc, campaign) => acc + campaign.proposalCount, 0);
    let extraAgentFills = agentFillDeposits.length - proposalCountTotal;

    if (extraAgentFills < 0) {
        return {
            campaigns,
            anomalies: [
                `Observed ${agentFillDeposits.length} agent WETH deposits but ${proposalCountTotal} reimbursement proposals; reimbursements exceed deposits.`,
            ],
            unmatchedReimbursements,
        };
    }

    for (const campaign of campaigns) {
        campaign.agentFillCount = campaign.proposalCount;
    }

    for (const campaign of campaigns) {
        while (extraAgentFills > 0 && campaign.agentFillCount < POLICY.tranchesPerCampaign) {
            campaign.agentFillCount += 1;
            extraAgentFills -= 1;
        }
    }

    const anomalies = [];
    if (extraAgentFills > 0) {
        anomalies.push(
            `Observed ${agentFillDeposits.length} agent WETH deposits with ${proposalCountTotal} proposals; extra deposits overflow campaign capacity.`
        );
    }
    if (unmatchedReimbursements > 0) {
        anomalies.push(
            `Found ${unmatchedReimbursements} reimbursement proposal(s) that did not match campaign tranche expectations.`
        );
    }

    for (const campaign of campaigns) {
        campaign.unpairedFillCount = campaign.agentFillCount - campaign.proposalCount;
    }

    return {
        campaigns,
        anomalies,
        unmatchedReimbursements,
    };
}

function getActiveCampaign(campaigns) {
    return campaigns.find((campaign) => campaign.executedCount < POLICY.tranchesPerCampaign) ?? null;
}

function chooseCampaignAction({ campaign, nowMs }) {
    if (!campaign) {
        return { action: 'ignore', reason: 'No campaigns detected.' };
    }

    if (campaign.pendingCount > 0) {
        return {
            action: 'ignore',
            reason: `Campaign ${campaign.campaignIndex} has a pending reimbursement proposal.`,
        };
    }

    if (campaign.unpairedFillCount > 1) {
        return {
            action: 'ignore',
            reason: `Campaign ${campaign.campaignIndex} has ${campaign.unpairedFillCount} unpaired fills; refusing to continue automatically.`,
        };
    }

    const nextTrancheIndex = campaign.proposalCount;
    if (nextTrancheIndex >= POLICY.tranchesPerCampaign) {
        return { action: 'ignore', reason: `Campaign ${campaign.campaignIndex} is complete.` };
    }

    const trancheDueAtMs = campaign.deposit.timestampMs + POLICY.trancheIntervalMs * nextTrancheIndex;
    if (nowMs < trancheDueAtMs) {
        return {
            action: 'ignore',
            reason: `Campaign ${campaign.campaignIndex} tranche ${nextTrancheIndex + 1} not due yet.`,
            nextTrancheIndex,
            trancheDueAtMs,
        };
    }

    const reimbursementAmountWei = campaign.reimbursementTranches[nextTrancheIndex];
    const fillNotionalUsdcWei = campaign.fillNotionalTranches[nextTrancheIndex];
    if (reimbursementAmountWei <= 0n || fillNotionalUsdcWei <= 0n) {
        return {
            action: 'ignore',
            reason: `Campaign ${campaign.campaignIndex} tranche ${nextTrancheIndex + 1} has non-positive amount.`,
        };
    }

    return {
        action: campaign.unpairedFillCount === 1 ? 'propose_only' : 'deposit_and_propose',
        reason: `Campaign ${campaign.campaignIndex} tranche ${nextTrancheIndex + 1} is due.`,
        nextTrancheIndex,
        reimbursementAmountWei,
        fillNotionalUsdcWei,
        trancheDueAtMs,
    };
}

function parseReimbursementProposal(log, { agentAddress }) {
    const proposalHash = normalizeHashOrNull(log?.args?.proposalHash);
    if (!proposalHash) {
        return null;
    }

    const proposer = normalizeAddressOrNull(log?.args?.proposer, { requireHex: false });
    if (proposer !== agentAddress) {
        return null;
    }

    const proposal = log?.args?.proposal;
    const transactions = Array.isArray(proposal?.transactions) ? proposal.transactions : null;
    if (!transactions || transactions.length !== 1) {
        return null;
    }

    const tx = transactions[0];
    const txTo = normalizeAddressOrNull(tx?.to, { requireHex: false });
    if (txTo !== POLICY.usdcAddress) {
        return null;
    }

    if (BigInt(tx?.value ?? 0n) !== 0n) {
        return null;
    }

    const decodedTransfer = decodeErc20TransferCallData(tx?.data);
    if (!decodedTransfer) {
        return null;
    }

    if (decodedTransfer.to !== agentAddress || decodedTransfer.amount <= 0n) {
        return null;
    }

    const proposalTime = log?.args?.proposalTime;
    const proposalTimeMs = typeof proposalTime === 'bigint' ? Number(proposalTime) * 1000 : null;

    return {
        proposalHash,
        amountWei: decodedTransfer.amount,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex ?? 0,
        proposalTimeMs,
    };
}

async function getDeterministicToolCalls({ commitmentSafe, agentAddress, publicClient, config }) {
    const safeAddress = normalizeAddressOrThrow(commitmentSafe, { requireHex: false });
    const normalizedAgentAddress = normalizeAddressOrThrow(agentAddress, { requireHex: false });
    const latestBlock = await publicClient.getBlockNumber();
    const fromBlock = await resolveScanStartBlock({
        publicClient,
        config,
        latestBlock,
    });
    if (fromBlock === null) {
        return [];
    }
    if (fromBlock > latestBlock) {
        return [];
    }

    const latestBlockData = await publicClient.getBlock({ blockNumber: latestBlock });
    const nowMs = Number(latestBlockData.timestamp) * 1000;

    const [
        usdcDepositsRaw,
        agentWethDepositsRaw,
        proposedLogsRaw,
        executedLogsRaw,
        deletedLogsRaw,
    ] = await Promise.all([
        getLogsChunked({
            publicClient,
            address: POLICY.usdcAddress,
            event: transferEvent,
            args: { to: safeAddress },
            fromBlock,
            toBlock: latestBlock,
        }),
        getLogsChunked({
            publicClient,
            address: POLICY.wethAddress,
            event: transferEvent,
            args: { from: normalizedAgentAddress, to: safeAddress },
            fromBlock,
            toBlock: latestBlock,
        }),
        getLogsChunked({
            publicClient,
            address: config.ogModule,
            event: transactionsProposedEvent,
            fromBlock,
            toBlock: latestBlock,
        }),
        getLogsChunked({
            publicClient,
            address: config.ogModule,
            event: proposalExecutedEvent,
            fromBlock,
            toBlock: latestBlock,
        }),
        getLogsChunked({
            publicClient,
            address: config.ogModule,
            event: proposalDeletedEvent,
            fromBlock,
            toBlock: latestBlock,
        }),
    ]);

    const blockTimestampCache = new Map();
    const usdcDeposits = [];
    for (const log of usdcDepositsRaw) {
        const amount = BigInt(log?.args?.value ?? 0n);
        if (amount <= 0n) continue;
        const timestampMs = await getBlockTimestampMs(publicClient, log.blockNumber, blockTimestampCache);
        usdcDeposits.push({
            amountWei: amount,
            blockNumber: log.blockNumber,
            logIndex: log.logIndex ?? 0,
            timestampMs,
        });
    }

    if (usdcDeposits.length === 0) {
        return [];
    }

    const agentWethDeposits = sortByChainOrder(
        agentWethDepositsRaw
            .map((log) => ({
                amountWei: BigInt(log?.args?.value ?? 0n),
                blockNumber: log.blockNumber,
                logIndex: log.logIndex ?? 0,
            }))
            .filter((entry) => entry.amountWei > 0n)
    );

    const executedHashes = new Set(
        executedLogsRaw
            .map((log) => normalizeHashOrNull(log?.args?.proposalHash))
            .filter(Boolean)
    );
    const deletedHashes = new Set(
        deletedLogsRaw
            .map((log) => normalizeHashOrNull(log?.args?.proposalHash))
            .filter(Boolean)
    );

    const proposedLogs = sortByChainOrder(proposedLogsRaw);
    const reimbursementRecords = [];
    let pendingProposalCount = 0;

    for (const log of proposedLogs) {
        const proposalHash = normalizeHashOrNull(log?.args?.proposalHash);
        if (!proposalHash) continue;
        if (deletedHashes.has(proposalHash)) continue;

        const status = executedHashes.has(proposalHash) ? 'executed' : 'pending';
        if (status === 'pending') pendingProposalCount += 1;

        const reimbursement = parseReimbursementProposal(log, {
            agentAddress: normalizedAgentAddress,
        });
        if (!reimbursement) continue;

        reimbursementRecords.push({
            ...reimbursement,
            status,
        });
    }

    if (pendingProposalCount > 0) {
        return [];
    }

    const sortedDeposits = sortByChainOrder(usdcDeposits);
    const sortedReimbursements = sortByChainOrder(reimbursementRecords);

    const { campaigns, anomalies } = buildCampaigns({
        deposits: sortedDeposits,
        reimbursementRecords: sortedReimbursements,
        agentFillDeposits: agentWethDeposits,
    });

    if (anomalies.length > 0) {
        console.warn('[deterministic-dca-agent] History anomalies detected:', anomalies.join(' | '));
        return [];
    }

    const activeCampaign = getActiveCampaign(campaigns);
    const selection = chooseCampaignAction({ campaign: activeCampaign, nowMs });
    if (selection.action === 'ignore') {
        return [];
    }

    const safeUsdcBalance = await publicClient.readContract({
        address: POLICY.usdcAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [safeAddress],
    });
    if (BigInt(safeUsdcBalance) < selection.reimbursementAmountWei) {
        return [];
    }

    const buildCall = {
        callId: `deterministic-build-c${activeCampaign.campaignIndex + 1}-t${selection.nextTrancheIndex + 1}`,
        name: 'build_og_transactions',
        arguments: JSON.stringify({
            actions: [
                {
                    kind: 'erc20_transfer',
                    token: POLICY.usdcAddress,
                    to: normalizedAgentAddress,
                    amountWei: selection.reimbursementAmountWei.toString(),
                },
            ],
        }),
    };

    if (selection.action === 'propose_only') {
        return [buildCall];
    }

    const priceRound = await publicClient.readContract({
        address: config?.chainlinkPriceFeed ?? POLICY.chainlinkEthUsdFeed,
        abi: chainlinkAbi,
        functionName: 'latestRoundData',
    });
    const chainlinkAnswer = BigInt(priceRound?.[1] ?? 0n);
    if (chainlinkAnswer <= 0n) {
        return [];
    }

    const wethDepositAmountWei = computeWethAmountWei({
        fillNotionalUsdcWei: selection.fillNotionalUsdcWei,
        chainlinkAnswer,
    });
    if (wethDepositAmountWei <= 0n) {
        return [];
    }

    const agentWethBalance = await publicClient.readContract({
        address: POLICY.wethAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [normalizedAgentAddress],
    });
    if (BigInt(agentWethBalance) < wethDepositAmountWei) {
        return [];
    }

    return [
        {
            callId: `deterministic-deposit-c${activeCampaign.campaignIndex + 1}-t${selection.nextTrancheIndex + 1}`,
            name: 'make_deposit',
            arguments: JSON.stringify({
                asset: POLICY.wethAddress,
                amountWei: wethDepositAmountWei.toString(),
            }),
        },
        buildCall,
    ];
}

function parseCallArgs(call) {
    if (call?.parsedArguments && typeof call.parsedArguments === 'object') {
        return call.parsedArguments;
    }
    if (typeof call?.arguments === 'string') {
        try {
            return JSON.parse(call.arguments);
        } catch {
            return null;
        }
    }
    return null;
}

async function validateToolCalls({ toolCalls, commitmentSafe, agentAddress }) {
    const safeAddress = normalizeAddressOrThrow(commitmentSafe, { requireHex: false });
    const normalizedAgentAddress = normalizeAddressOrThrow(agentAddress, { requireHex: false });

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        return [];
    }

    if (toolCalls.length > 2) {
        throw new Error('Deterministic DCA agent allows at most two tool calls per run.');
    }

    const normalizedCalls = [];
    for (const call of toolCalls) {
        if (!call?.name || !call?.callId) {
            throw new Error('Each tool call must include name and callId.');
        }
        if (call.name !== 'make_deposit' && call.name !== 'build_og_transactions') {
            throw new Error(`Unsupported tool call for deterministic DCA agent: ${call.name}`);
        }

        const args = parseCallArgs(call);
        if (!args) {
            throw new Error(`Invalid JSON arguments for ${call.name}.`);
        }

        if (call.name === 'make_deposit') {
            const asset = normalizeAddressOrThrow(String(args.asset), { requireHex: false });
            const amountWei = BigInt(String(args.amountWei));
            if (asset !== POLICY.wethAddress) {
                throw new Error('make_deposit asset must be Sepolia WETH.');
            }
            if (amountWei <= 0n) {
                throw new Error('make_deposit amountWei must be positive.');
            }
            normalizedCalls.push({
                ...call,
                parsedArguments: {
                    asset,
                    amountWei: amountWei.toString(),
                },
            });
            continue;
        }

        const actions = Array.isArray(args.actions) ? args.actions : null;
        if (!actions || actions.length !== 1) {
            throw new Error('build_og_transactions must include exactly one action.');
        }

        const action = actions[0];
        if (action.kind !== 'erc20_transfer') {
            throw new Error('Only erc20_transfer is allowed for reimbursement proposals.');
        }

        const token = normalizeAddressOrThrow(String(action.token), { requireHex: false });
        const to = normalizeAddressOrThrow(String(action.to), { requireHex: false });
        const amountWei = BigInt(String(action.amountWei));
        if (token !== POLICY.usdcAddress) {
            throw new Error('Reimbursement transfer token must be Sepolia USDC.');
        }
        if (to !== normalizedAgentAddress) {
            throw new Error('Reimbursement transfer recipient must be agentAddress.');
        }
        if (amountWei <= 0n) {
            throw new Error('Reimbursement amountWei must be positive.');
        }

        normalizedCalls.push({
            ...call,
            parsedArguments: {
                actions: [
                    {
                        kind: 'erc20_transfer',
                        token,
                        to,
                        amountWei: amountWei.toString(),
                    },
                ],
            },
        });
    }

    if (normalizedCalls.length === 2) {
        if (normalizedCalls[0].name !== 'make_deposit' || normalizedCalls[1].name !== 'build_og_transactions') {
            throw new Error('Two-step runs must execute make_deposit before build_og_transactions.');
        }
    }

    if (normalizedCalls.some((call) => call.name === 'build_og_transactions')) {
        const buildCall = normalizedCalls.find((call) => call.name === 'build_og_transactions');
        const action = buildCall.parsedArguments.actions[0];
        if (action.to !== normalizedAgentAddress) {
            throw new Error('build_og_transactions reimbursement recipient must match agentAddress.');
        }
        if (safeAddress.length === 0) {
            throw new Error('Invalid commitmentSafe address.');
        }
    }

    return normalizedCalls;
}

export {
    POLICY,
    getSystemPrompt,
    augmentSignals,
    getDeterministicToolCalls,
    validateToolCalls,
    splitReimbursementTranches,
    computeFillNotionalUsdcWei,
    computeWethAmountWei,
    findContractDeploymentBlock,
    buildCampaigns,
    chooseCampaignAction,
};
