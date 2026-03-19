import { erc20Abi } from 'viem';
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
import {
    chainPositionCompare,
    findContractDeploymentBlock,
    getBlockTimestampMs,
    getLogsChunked,
} from '../../../agent/src/lib/chain-history.js';
import { getChainlinkAnswerAtBlock } from '../../../agent/src/lib/chainlink.js';
import { isAssertionDisputable, parseProposalRecord } from '../../../agent/src/lib/og-state.js';

const CHAINLINK_ETH_USD_FEED_SEPOLIA = '0x694AA1769357215DE4FAC081bf1f309aDC325306';
const CHAINLINK_ETH_USD_FEED_MAINNET = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const POLICY_PRESETS = Object.freeze({
    testnet: Object.freeze({
        usdcAddress: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
        wethAddress: '0x7b79995e5f793a07bc00c21412e50ecae098e7f9',
        chainlinkEthUsdFeed: CHAINLINK_ETH_USD_FEED_SEPOLIA,
    }),
    mainnet: Object.freeze({
        usdcAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        wethAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        chainlinkEthUsdFeed: CHAINLINK_ETH_USD_FEED_MAINNET,
    }),
});
const DEFAULT_POLICY_PRESET = 'testnet';
const POLICY = Object.freeze({
    ...POLICY_PRESETS[DEFAULT_POLICY_PRESET],
    tranchesPerCampaign: 4,
    trancheIntervalMs: 3 * 60 * 60 * 1000,
    feeBps: 50n,
    bpsDenominator: 10_000n,
    logChunkSize: 5_000n,
});
let cachedAutoStartBlock = null;
let autoDiscoveryRetryAfterMs = 0;
const MAX_DISPUTE_EXPLANATION_LENGTH = 240;
const AUTO_DISCOVERY_RETRY_DELAY_MS = 60_000;

function resolvePolicyPresetName(config) {
    const raw = String(
        config?.agentConfig?.deterministicDcaPolicyPreset ??
            config?.deterministicDcaPolicyPreset ??
            ''
    )
        .trim()
        .toLowerCase();
    if (!raw) return DEFAULT_POLICY_PRESET;
    if (raw === 'mainnet' || raw === 'testnet') return raw;
    console.warn(
        `[deterministic-dca-agent] Unsupported deterministicDcaPolicyPreset='${raw}', defaulting to ${DEFAULT_POLICY_PRESET}.`
    );
    return DEFAULT_POLICY_PRESET;
}

function resolvePolicy(config) {
    const preset = resolvePolicyPresetName(config);
    return {
        ...POLICY,
        ...POLICY_PRESETS[preset],
    };
}

/**
 * Adds a deterministic heartbeat signal so the module can run on a timer
 * even when no new deposit/proposal events were observed.
 */
function augmentSignals(signals, { nowMs } = {}) {
    return [
        ...signals,
        {
            kind: 'deterministicTick',
            nowMs: nowMs ?? Date.now(),
        },
    ];
}

/**
 * Builds a sortable key from (blockNumber, logIndex) so events can be
 * ordered exactly as they occurred on chain.
 */
function toChronologicalSortKey(entry) {
    const block = BigInt(entry.blockNumber ?? 0n);
    const logIndex = BigInt(entry.logIndex ?? 0n);
    return block * 1_000_000n + logIndex;
}

/**
 * Returns a copy of entries sorted in chain order (block first, then log index).
 */
function sortByChainOrder(entries) {
    return [...entries].sort((a, b) => {
        const left = toChronologicalSortKey(a);
        const right = toChronologicalSortKey(b);
        if (left === right) return 0;
        return left < right ? -1 : 1;
    });
}

/**
 * Resolves the block range size used for eth_getLogs calls.
 * Priority: shared config LOG_CHUNK_SIZE -> legacy agent-specific env var -> default policy.
 */
function resolveLogChunkSize(config) {
    const genericChunkSize = config?.logChunkSize;
    if (typeof genericChunkSize === 'bigint' && genericChunkSize > 0n) {
        return genericChunkSize;
    }

    const legacyRaw =
        config?.agentConfig?.deterministicDcaLogChunkSize ?? config?.deterministicDcaLogChunkSize;
    if (legacyRaw === undefined || legacyRaw === null || String(legacyRaw).trim() === '') {
        return POLICY.logChunkSize;
    }

    try {
        const parsed = BigInt(String(legacyRaw).trim());
        if (parsed <= 0n) {
            throw new Error('chunk size must be greater than 0');
        }
        return parsed;
    } catch {
        console.warn(
            `[deterministic-dca-agent] Invalid deterministicDcaLogChunkSize='${legacyRaw}', using default ${POLICY.logChunkSize.toString()}.`
        );
        return POLICY.logChunkSize;
    }
}

/**
 * Resolves the historical scan lower bound for deterministic reconstruction.
 * Uses START_BLOCK when provided, otherwise auto-discovers OG deployment block once and caches it.
 */
async function resolveScanStartBlock({ publicClient, config, latestBlock }) {
    if (config?.startBlock !== undefined) {
        return BigInt(config.startBlock);
    }
    if (cachedAutoStartBlock !== null) {
        return cachedAutoStartBlock;
    }
    if (Date.now() < autoDiscoveryRetryAfterMs) {
        return null;
    }

    try {
        const discovered = await findContractDeploymentBlock({
            publicClient,
            address: config.ogModule,
            latestBlock,
        });
        if (discovered === null) {
            autoDiscoveryRetryAfterMs = Date.now() + AUTO_DISCOVERY_RETRY_DELAY_MS;
            console.warn(
                `[deterministic-dca-agent] Auto-discovery failed: ogModule has no code at latest block. Retrying in ${AUTO_DISCOVERY_RETRY_DELAY_MS}ms.`
            );
            return null;
        }
        cachedAutoStartBlock = discovered;
        autoDiscoveryRetryAfterMs = 0;
        console.log(
            `[deterministic-dca-agent] Auto-discovered scan start block from OG deployment: ${discovered.toString()}`
        );
        return discovered;
    } catch (error) {
        autoDiscoveryRetryAfterMs = Date.now() + AUTO_DISCOVERY_RETRY_DELAY_MS;
        console.warn(
            `[deterministic-dca-agent] Failed to auto-discover scan start block; will retry in ${AUTO_DISCOVERY_RETRY_DELAY_MS}ms (or set START_BLOCK explicitly).`,
            error?.message ?? error
        );
        return null;
    }
}

/**
 * Splits a campaign reimbursement total into 4 tranches, assigning remainder to the final tranche.
 */
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

/**
 * Applies the implied service fee by converting reimbursement amount (100%) to fill notional (99.5%).
 */
function computeFillNotionalUsdcWei(reimbursementUsdcWei) {
    return (reimbursementUsdcWei * (POLICY.bpsDenominator - POLICY.feeBps)) / POLICY.bpsDenominator;
}

/**
 * Converts a USD notional (USDC 6 decimals) to WETH wei using Chainlink ETH/USD answer (8 decimals).
 */
function computeWethAmountWei({ fillNotionalUsdcWei, chainlinkAnswer }) {
    // fillNotionalUsdcWei has 6 decimals; Chainlink answer has 8 decimals.
    // wethWei = floor(fillUsd * 1e18 / ethPriceUsd)
    //         = floor(fillNotionalUsdcWei * 1e20 / chainlinkAnswer)
    const scale = 10n ** 20n;
    return (fillNotionalUsdcWei * scale) / chainlinkAnswer;
}

/**
 * Maps the Nth valid reimbursement proposal to its expected campaign tranche
 * and returns the tranche amount plus due timestamp.
 */
function getExpectedTranche({ campaignDeposits, validProposalCount }) {
    if (!Array.isArray(campaignDeposits) || campaignDeposits.length === 0) {
        return null;
    }

    const campaignIndex = Math.floor(validProposalCount / POLICY.tranchesPerCampaign);
    const trancheIndex = validProposalCount % POLICY.tranchesPerCampaign;
    const campaignDeposit = campaignDeposits[campaignIndex];
    if (!campaignDeposit) {
        return null;
    }

    const reimbursementTranches = splitReimbursementTranches(campaignDeposit.amountWei);
    const reimbursementAmountWei = reimbursementTranches[trancheIndex];
    const fillNotionalUsdcWei = computeFillNotionalUsdcWei(reimbursementAmountWei);
    const dueAtMs = campaignDeposit.timestampMs + POLICY.trancheIntervalMs * trancheIndex;

    return {
        campaignIndex,
        trancheIndex,
        reimbursementAmountWei,
        fillNotionalUsdcWei,
        dueAtMs,
        deposit: campaignDeposit,
    };
}

/**
 * Trims and length-bounds dispute explanations to fit downstream constraints.
 */
function normalizeDisputeExplanation(explanation) {
    const text = String(explanation ?? '').trim();
    if (!text) return null;
    if (text.length <= MAX_DISPUTE_EXPLANATION_LENGTH) return text;
    return text.slice(0, MAX_DISPUTE_EXPLANATION_LENGTH - 3).trimEnd() + '...';
}

/**
 * Validates that a proposal is exactly one USDC transfer reimbursing the agent,
 * and returns the decoded transfer amount when valid.
 */
function parseReimbursementTransfer({ proposalRecord, normalizedAgentAddress, policy }) {
    if (!proposalRecord?.transactions || proposalRecord.transactions.length !== 1) {
        return { ok: false, reason: 'proposal must include exactly one transaction' };
    }

    const tx = proposalRecord.transactions[0];
    const to = normalizeAddressOrNull(tx?.to, { requireHex: false });
    if (to !== policy.usdcAddress) {
        return { ok: false, reason: 'transaction target must be policy USDC token' };
    }
    const operation = Number(tx?.operation ?? 0);
    if (!Number.isInteger(operation) || operation !== 0) {
        return { ok: false, reason: 'transaction operation must be CALL (0)' };
    }
    const value = BigInt(tx?.value ?? 0n);
    if (value !== 0n) {
        return { ok: false, reason: 'transaction value must be 0 for ERC20 transfer' };
    }

    const decoded = decodeErc20TransferCallData(tx?.data);
    if (!decoded) {
        return { ok: false, reason: 'transaction calldata must decode as ERC20 transfer' };
    }
    if (decoded.to !== normalizedAgentAddress) {
        return { ok: false, reason: 'transfer recipient must be agentAddress' };
    }
    if (decoded.amount <= 0n) {
        return { ok: false, reason: 'transfer amount must be positive' };
    }

    return {
        ok: true,
        transferAmountWei: decoded.amount,
    };
}

/**
 * Reconstructs campaign state from deposit/fill/reimbursement history and flags anomalies.
 */
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

/**
 * Returns the first campaign that is not fully executed, or null when all campaigns are done.
 */
function getActiveCampaign(campaigns) {
    return campaigns.find((campaign) => campaign.executedCount < POLICY.tranchesPerCampaign) ?? null;
}

/**
 * Chooses the next campaign action based on timing and consistency checks:
 * ignore, propose_only, or deposit_and_propose.
 */
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

/**
 * Main deterministic planner.
 * Reconstructs chain state, validates prior proposals/fills, disputes invalid pending proposals,
 * and emits the next safe tool calls when a tranche is due.
 */
async function getDeterministicToolCalls({ commitmentSafe, agentAddress, publicClient, config }) {
    const safeAddress = normalizeAddressOrThrow(commitmentSafe, { requireHex: false });
    const normalizedAgentAddress = normalizeAddressOrThrow(agentAddress, { requireHex: false });
    const policy = resolvePolicy(config);
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
    const nowSeconds = BigInt(latestBlockData.timestamp);
    const chainlinkFeedAddress = config?.chainlinkPriceFeed ?? policy.chainlinkEthUsdFeed;
    const logChunkSize = resolveLogChunkSize(config);

    const [
        usdcDepositsRaw,
        usdcWithdrawalsRaw,
        agentWethDepositsRaw,
        proposedLogsRaw,
        executedLogsRaw,
        deletedLogsRaw,
    ] = await Promise.all([
        getLogsChunked({
            publicClient,
            address: policy.usdcAddress,
            event: transferEvent,
            args: { to: safeAddress },
            fromBlock,
            toBlock: latestBlock,
            chunkSize: logChunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: policy.usdcAddress,
            event: transferEvent,
            args: { from: safeAddress },
            fromBlock,
            toBlock: latestBlock,
            chunkSize: logChunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: policy.wethAddress,
            event: transferEvent,
            args: { from: normalizedAgentAddress, to: safeAddress },
            fromBlock,
            toBlock: latestBlock,
            chunkSize: logChunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: config.ogModule,
            event: transactionsProposedEvent,
            fromBlock,
            toBlock: latestBlock,
            chunkSize: logChunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: config.ogModule,
            event: proposalExecutedEvent,
            fromBlock,
            toBlock: latestBlock,
            chunkSize: logChunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: config.ogModule,
            event: proposalDeletedEvent,
            fromBlock,
            toBlock: latestBlock,
            chunkSize: logChunkSize,
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
    const sortedCampaignDeposits = sortByChainOrder(usdcDeposits);

    const sortedUserUsdcWithdrawals = sortByChainOrder(
        usdcWithdrawalsRaw
            .map((log) => {
                const amount = BigInt(log?.args?.value ?? 0n);
                const to = normalizeAddressOrNull(log?.args?.to, { requireHex: false });
                return {
                    amountWei: amount,
                    to,
                    blockNumber: log.blockNumber,
                    logIndex: log.logIndex ?? 0,
                };
            })
            .filter(
                (entry) =>
                    entry.amountWei > 0n &&
                    typeof entry.to === 'string' &&
                    entry.to !== normalizedAgentAddress
            )
    );
    const firstUserUsdcWithdrawal =
        sortedUserUsdcWithdrawals.find(
            (entry) => chainPositionCompare(entry, sortedCampaignDeposits[0]) >= 0
        ) ?? null;

    const sortedAgentWethDeposits = sortByChainOrder(
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
    const proposalRecords = sortByChainOrder(
        proposedLogsRaw
            .map((log) => parseProposalRecord(log))
            .filter(Boolean)
            .filter((record) => !deletedHashes.has(record.proposalHash))
            .map((record) => ({
                ...record,
                status: executedHashes.has(record.proposalHash) ? 'executed' : 'pending',
            }))
    );

    let validProposalCount = 0;
    let consumedFillCount = 0;
    let pendingValidProposalCount = 0;
    let invalidExecutedProposalCount = 0;
    const invalidPendingProposals = [];
    const chainlinkAnswerByBlock = new Map();

    for (const proposalRecord of proposalRecords) {
        let invalidReason = null;
        let expected = null;
        if (!proposalRecord.assertionId) {
            invalidReason = 'missing assertionId';
        }
        if (
            !invalidReason &&
            firstUserUsdcWithdrawal &&
            chainPositionCompare(firstUserUsdcWithdrawal, proposalRecord) <= 0
        ) {
            invalidReason = 'campaign canceled by user USDC withdrawal';
        }
        if (!invalidReason) {
            expected = getExpectedTranche({
                campaignDeposits: sortedCampaignDeposits,
                validProposalCount,
            });
        }
        if (!invalidReason && !expected) {
            invalidReason = 'no scheduled campaign tranche available for this proposal';
        }

        const transferCheck = parseReimbursementTransfer({
            proposalRecord,
            normalizedAgentAddress,
            policy,
        });
        if (!invalidReason && !transferCheck.ok) {
            invalidReason = transferCheck.reason;
        }
        if (
            !invalidReason &&
            transferCheck.transferAmountWei !== expected.reimbursementAmountWei
        ) {
            invalidReason =
                `reimbursement amount mismatch (expected ${expected.reimbursementAmountWei.toString()}, got ${transferCheck.transferAmountWei.toString()})`;
        }

        if (!invalidReason) {
            const proposalTimestampMs = await getBlockTimestampMs(
                publicClient,
                proposalRecord.blockNumber,
                blockTimestampCache
            );
            if (proposalTimestampMs < expected.dueAtMs) {
                invalidReason = 'proposal submitted before tranche due time';
            }
        }

        let expectedFillAmountWei = null;
        if (!invalidReason) {
            const fillRecord = sortedAgentWethDeposits[consumedFillCount];
            if (!fillRecord) {
                invalidReason = 'missing agent WETH fill deposit for this tranche';
            } else if (chainPositionCompare(fillRecord, proposalRecord) > 0) {
                invalidReason = 'agent WETH fill deposit occurs after proposal';
            } else {
                const chainlinkAnswer = await getChainlinkAnswerAtBlock({
                    publicClient,
                    feedAddress: chainlinkFeedAddress,
                    blockNumber: fillRecord.blockNumber,
                    cache: chainlinkAnswerByBlock,
                });
                expectedFillAmountWei = computeWethAmountWei({
                    fillNotionalUsdcWei: expected.fillNotionalUsdcWei,
                    chainlinkAnswer,
                });
                if (fillRecord.amountWei !== expectedFillAmountWei) {
                    invalidReason =
                        `fill amount mismatch (expected ${expectedFillAmountWei.toString()}, got ${fillRecord.amountWei.toString()})`;
                }
            }
        }

        if (invalidReason) {
            if (proposalRecord.status === 'pending') {
                invalidPendingProposals.push({
                    proposalHash: proposalRecord.proposalHash,
                    assertionId: proposalRecord.assertionId,
                    reason: invalidReason,
                });
            } else if (proposalRecord.status === 'executed') {
                invalidExecutedProposalCount += 1;
            }
            continue;
        }

        validProposalCount += 1;
        consumedFillCount += 1;
        if (proposalRecord.status === 'pending') {
            pendingValidProposalCount += 1;
        }
        void expectedFillAmountWei;
    }

    if (invalidPendingProposals.length > 0) {
        if (!config?.disputeEnabled) {
            return [];
        }

        const disputeCalls = [];
        const optimisticOracleCache = { value: null };
        const assertionDisputableCache = new Map();
        for (const invalidProposal of invalidPendingProposals) {
            if (!invalidProposal.assertionId) continue;
            const disputable = await isAssertionDisputable({
                publicClient,
                ogModule: config.ogModule,
                assertionId: invalidProposal.assertionId,
                nowSeconds,
                optimisticOracleCache,
                assertionCache: assertionDisputableCache,
            });
            if (!disputable) continue;

            const explanation = normalizeDisputeExplanation(
                `Proposal ${invalidProposal.proposalHash.slice(0, 10)} invalid: ${invalidProposal.reason}.`
            );
            if (!explanation) continue;

            disputeCalls.push({
                callId: `deterministic-dispute-${invalidProposal.proposalHash.slice(2, 10)}`,
                name: 'dispute_assertion',
                arguments: JSON.stringify({
                    assertionId: invalidProposal.assertionId,
                    explanation,
                }),
            });
        }
        if (disputeCalls.length > 0) {
            return disputeCalls;
        }
        return [];
    }

    if (pendingValidProposalCount > 0) {
        return [];
    }

    if (invalidExecutedProposalCount > 0) {
        console.warn(
            `[deterministic-dca-agent] Found ${invalidExecutedProposalCount} invalid executed proposal(s); refusing automatic proposals.`
        );
        return [];
    }

    if (firstUserUsdcWithdrawal) {
        return [];
    }

    const selection = getExpectedTranche({
        campaignDeposits: sortedCampaignDeposits,
        validProposalCount,
    });
    if (!selection) {
        return [];
    }
    if (nowMs < selection.dueAtMs) {
        return [];
    }

    const unpairedFillCount = sortedAgentWethDeposits.length - consumedFillCount;
    if (unpairedFillCount > 1) {
        console.warn(
            `[deterministic-dca-agent] Found ${unpairedFillCount} unpaired WETH fills; refusing automatic proposals.`
        );
        return [];
    }

    const safeUsdcBalance = await publicClient.readContract({
        address: policy.usdcAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [safeAddress],
    });
    if (BigInt(safeUsdcBalance) < selection.reimbursementAmountWei) {
        return [];
    }

    const buildCall = {
        callId: `deterministic-build-c${selection.campaignIndex + 1}-t${selection.trancheIndex + 1}`,
        name: 'build_og_transactions',
        arguments: JSON.stringify({
            actions: [
                {
                    kind: 'erc20_transfer',
                    token: policy.usdcAddress,
                    to: normalizedAgentAddress,
                    amountWei: selection.reimbursementAmountWei.toString(),
                },
            ],
        }),
    };

    if (unpairedFillCount === 1) {
        const unpairedFill = sortedAgentWethDeposits[consumedFillCount];
        if (!unpairedFill) {
            return [];
        }
        const chainlinkAnswer = await getChainlinkAnswerAtBlock({
            publicClient,
            feedAddress: chainlinkFeedAddress,
            blockNumber: unpairedFill.blockNumber,
            cache: chainlinkAnswerByBlock,
        });
        const expectedFillAmountWei = computeWethAmountWei({
            fillNotionalUsdcWei: selection.fillNotionalUsdcWei,
            chainlinkAnswer,
        });
        if (unpairedFill.amountWei !== expectedFillAmountWei) {
            return [];
        }
        return [buildCall];
    }

    const chainlinkAnswer = await getChainlinkAnswerAtBlock({
        publicClient,
        feedAddress: chainlinkFeedAddress,
        blockNumber: latestBlock,
        cache: chainlinkAnswerByBlock,
    });

    const wethDepositAmountWei = computeWethAmountWei({
        fillNotionalUsdcWei: selection.fillNotionalUsdcWei,
        chainlinkAnswer,
    });
    if (wethDepositAmountWei <= 0n) {
        return [];
    }

    const agentWethBalance = await publicClient.readContract({
        address: policy.wethAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [normalizedAgentAddress],
    });
    if (BigInt(agentWethBalance) < wethDepositAmountWei) {
        return [];
    }

    return [
        {
            callId: `deterministic-deposit-c${selection.campaignIndex + 1}-t${selection.trancheIndex + 1}`,
            name: 'make_deposit',
            arguments: JSON.stringify({
                asset: policy.wethAddress,
                amountWei: wethDepositAmountWei.toString(),
            }),
        },
        buildCall,
    ];
}

/**
 * Parses pre-parsed or JSON-encoded tool call arguments.
 */
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

/**
 * Strictly validates and normalizes tool calls the module is allowed to execute.
 * Enforces dispute/proposal separation and deterministic DCA transfer constraints.
 */
async function validateToolCalls({ toolCalls, commitmentSafe, agentAddress, config }) {
    const safeAddress = normalizeAddressOrThrow(commitmentSafe, { requireHex: false });
    const normalizedAgentAddress = normalizeAddressOrThrow(agentAddress, { requireHex: false });
    const policy = resolvePolicy(config);

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        return [];
    }

    const disputeCalls = toolCalls.filter((call) => call?.name === 'dispute_assertion');
    if (disputeCalls.length > 0) {
        const nonDisputeCalls = toolCalls.filter((call) => call?.name !== 'dispute_assertion');
        if (nonDisputeCalls.length > 0) {
            throw new Error(
                'Deterministic DCA agent does not mix dispute_assertion with proposal/deposit calls in one run.'
            );
        }
        return disputeCalls.map((call, index) => {
            if (!call?.callId) {
                throw new Error('dispute_assertion call must include callId.');
            }
            const args = parseCallArgs(call);
            if (!args) {
                throw new Error('Invalid JSON arguments for dispute_assertion.');
            }
            const assertionId = normalizeHashOrNull(args.assertionId);
            if (!assertionId) {
                throw new Error('dispute_assertion requires a valid assertionId.');
            }
            const explanation = normalizeDisputeExplanation(args.explanation);
            if (!explanation) {
                throw new Error('dispute_assertion requires a non-empty explanation.');
            }
            return {
                ...call,
                callId: call.callId || `deterministic-dispute-${index}`,
                parsedArguments: {
                    assertionId,
                    explanation,
                },
            };
        });
    }

    if (toolCalls.length > 2) {
        throw new Error('Deterministic DCA agent allows at most two non-dispute tool calls per run.');
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
            if (asset !== policy.wethAddress) {
                throw new Error('make_deposit asset must be policy WETH.');
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
        if (token !== policy.usdcAddress) {
            throw new Error('Reimbursement transfer token must be policy USDC.');
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
