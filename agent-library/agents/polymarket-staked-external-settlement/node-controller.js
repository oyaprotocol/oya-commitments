import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEventLog, erc20Abi } from 'viem';
import { buildOgTransactions } from '../../../agent/src/lib/tx.js';
import { normalizeHashOrNull } from '../../../agent/src/lib/utils.js';
import {
    cloneJson,
    deletePersistedState,
    readPersistedState,
    STATE_VERSION,
    writePersistedState,
} from './state-store.js';
import {
    buildReimbursementExplanation,
    buildStream,
    buildStateScope,
    computeOutstandingSettlementWei,
    computeReimbursementEligibleWei,
    findWithdrawalViolationSignals,
    resolvePolicy,
    ZERO_ADDRESS,
} from './trade-ledger.js';
import {
    extractProposalHashFromReceipt,
} from './settlement-reconciliation.js';
import {
    extractPublishedReimbursementRequestRecord,
    extractPublishedTradeLogRecord,
} from './published-message-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_NODE_STATE_FILE = path.join(__dirname, '.settlement-node-state.json');
const MODULE_NAME = 'polymarket-staked-external-settlement';
const REIMBURSEMENT_PROPOSAL_KIND = 'agent_proxy_reimbursement';

let runtimeNodeState = createEmptyNodeState();
let runtimeNodeStateHydrated = false;
let runtimeNodeStatePath = null;
let runtimeNodeScopeKey = null;
const queuedNodeProposalEventUpdates = [];

function normalizeOptionalString(value) {
    if (value === undefined || value === null) {
        return null;
    }
    const normalized = String(value).trim();
    return normalized ? normalized : null;
}

function resolveNodeStatePath(policy) {
    if (policy?.nodeStateFile) {
        return path.resolve(policy.nodeStateFile);
    }
    return DEFAULT_NODE_STATE_FILE;
}

function serializeScope(scope) {
    return JSON.stringify(scope ?? null);
}

function createEmptyNodeState(scope = null) {
    return {
        version: STATE_VERSION,
        scope: cloneJson(scope),
        markets: {},
        disputedAssertionIds: [],
        pendingDispute: null,
    };
}

function createEmptyNodeMarketState() {
    return {
        reimbursement: {
            requestId: null,
            requestCid: null,
            requestSnapshotCid: null,
            requestedAtMs: null,
            dispatchAtMs: null,
            submissionTxHash: null,
            proposalHash: null,
            submittedAtMs: null,
            reimbursedAtMs: null,
            lastError: null,
        },
    };
}

function ensureNodeMarketState(state, marketId) {
    if (!state.markets[marketId]) {
        state.markets[marketId] = createEmptyNodeMarketState();
    }
    return state.markets[marketId];
}

async function configureNodeStateContext({ config, policy, commitmentSafe, ogModule }) {
    const scope = buildStateScope({
        config,
        policy,
        chainId: config.chainId,
        commitmentSafe,
        ogModule,
    });
    const nextStatePath = resolveNodeStatePath(policy);
    const nextScopeKey = `${nextStatePath}:${serializeScope(scope)}`;
    if (runtimeNodeScopeKey === nextScopeKey) {
        return { scope, statePath: nextStatePath };
    }
    runtimeNodeState = createEmptyNodeState(scope);
    runtimeNodeStateHydrated = false;
    runtimeNodeStatePath = nextStatePath;
    runtimeNodeScopeKey = nextScopeKey;
    return { scope, statePath: nextStatePath };
}

async function hydrateNodeState({ config, policy, commitmentSafe, ogModule }) {
    const { scope, statePath } = await configureNodeStateContext({
        config,
        policy,
        commitmentSafe,
        ogModule,
    });
    if (runtimeNodeStateHydrated) {
        return;
    }

    const persisted = await readPersistedState(statePath);
    if (!persisted) {
        runtimeNodeState = createEmptyNodeState(scope);
        runtimeNodeStateHydrated = true;
        return;
    }
    if (persisted.version !== STATE_VERSION) {
        throw new Error(
            `Unsupported persisted node state version in ${statePath}: ${persisted.version}`
        );
    }
    if (serializeScope(persisted.scope) !== serializeScope(scope)) {
        throw new Error(
            `Persisted node state scope in ${statePath} does not match the current runtime scope.`
        );
    }
    runtimeNodeState = persisted;
    runtimeNodeStateHydrated = true;
}

async function persistNodeState() {
    if (!runtimeNodeStatePath) {
        throw new Error('Node state path is not configured.');
    }
    await writePersistedState(runtimeNodeStatePath, runtimeNodeState);
}

function getNodeState() {
    return cloneJson(runtimeNodeState);
}

async function resetNodeStateForTest({ config } = {}) {
    const policy = resolvePolicy(config ?? {});
    await configureNodeStateContext({
        config: config ?? {},
        policy,
        commitmentSafe: config?.commitmentSafe ?? '0x1111111111111111111111111111111111111111',
        ogModule: config?.ogModule ?? '0x2222222222222222222222222222222222222222',
    });
    runtimeNodeState = createEmptyNodeState(runtimeNodeState.scope ?? null);
    runtimeNodeStateHydrated = true;
    queuedNodeProposalEventUpdates.length = 0;
    if (runtimeNodeStatePath) {
        await deletePersistedState(runtimeNodeStatePath);
    }
}

function buildPublishedMarketViews(records) {
    const groupedTradeLogs = new Map();
    const latestRequests = new Map();

    for (const record of Array.isArray(records) ? records : []) {
        const tradeLog = extractPublishedTradeLogRecord(record);
        if (tradeLog) {
            const group = groupedTradeLogs.get(tradeLog.streamKey) ?? [];
            group.push(tradeLog);
            groupedTradeLogs.set(tradeLog.streamKey, group);
            continue;
        }

        const request = extractPublishedReimbursementRequestRecord(record);
        if (!request) {
            continue;
        }
        const existing = latestRequests.get(request.streamKey);
        if (
            !existing ||
            Number(request.record.createdAtMs ?? 0) > Number(existing.record.createdAtMs ?? 0)
        ) {
            latestRequests.set(request.streamKey, request);
        }
    }

    const markets = [];
    for (const [streamKey, tradeLogs] of groupedTradeLogs.entries()) {
        tradeLogs.sort((left, right) => left.message.payload.sequence - right.message.payload.sequence);
        const latestTradeLog = tradeLogs.at(-1);
        if (!latestTradeLog) {
            continue;
        }

        const tradeClassifications = {};
        for (const tradeLog of tradeLogs) {
            const classifications =
                tradeLog.record?.artifact?.publication?.validation?.classifications ?? [];
            for (const classification of Array.isArray(classifications) ? classifications : []) {
                if (!classification?.id || !classification?.classification) {
                    continue;
                }
                tradeClassifications[classification.id] = {
                    classification: String(classification.classification),
                    firstSeenAtMs:
                        Number(classification.firstSeenAtMs ?? 0) > 0
                            ? Number(classification.firstSeenAtMs)
                            : null,
                    reason: normalizeOptionalString(classification.reason),
                    cid: tradeLog.record.cid,
                };
            }
        }

        const summary = latestTradeLog.message.payload.summary ?? {};
        const latestRequest = latestRequests.get(streamKey) ?? null;
        markets.push({
            chainId: Number(latestTradeLog.message.chainId),
            agentAddress: latestTradeLog.message.agentAddress,
            stream: cloneJson(latestTradeLog.message.payload.stream),
            trades: cloneJson(latestTradeLog.message.payload.trades),
            tradeClassifications,
            lastPublishedCid: latestTradeLog.record.cid,
            publishedAtMs: Number(latestTradeLog.record.publishedAtMs ?? 0) || null,
            settlement: {
                finalSettlementValueWei: summary.finalSettlementValueWei,
                settledAtMs: summary.settledAtMs,
                settlementKind: summary.settlementKind,
                depositTxHash: summary.settlementDepositTxHash,
                depositConfirmedAtMs: summary.settlementDepositConfirmedAtMs,
            },
            reimbursementRequest: latestRequest
                ? {
                      requestId: latestRequest.message.requestId,
                      requestCid: latestRequest.record.cid,
                      requestedAtMs:
                          Number(latestRequest.record.publishedAtMs ?? latestRequest.record.createdAtMs ?? 0) ||
                          null,
                      snapshotCid: latestRequest.message.payload.snapshotCid,
                  }
                : null,
        });
    }

    return markets.sort((left, right) =>
        left.stream.marketId.localeCompare(right.stream.marketId)
    );
}

function clearStaleNodeDispatches(state, dispatchGraceMs, nowMs = Date.now()) {
    let changed = false;
    if (
        Number.isInteger(state.pendingDispute?.dispatchAtMs) &&
        nowMs - state.pendingDispute.dispatchAtMs > dispatchGraceMs
    ) {
        state.pendingDispute = null;
        changed = true;
    }

    for (const marketState of Object.values(state.markets ?? {})) {
        if (
            Number.isInteger(marketState.reimbursement?.dispatchAtMs) &&
            nowMs - marketState.reimbursement.dispatchAtMs > dispatchGraceMs
        ) {
            marketState.reimbursement.dispatchAtMs = null;
            changed = true;
        }
    }
    return changed;
}

function buildConfiguredPublishedMarketIdentity({ marketId, policy, config }) {
    return {
        chainId: Number(config.chainId),
        agentAddress: policy.authorizedAgent,
        stream: buildStream({ policy, config, marketId }),
    };
}

function isConfiguredPublishedMarket(market, policy, config) {
    const marketId = market?.stream?.marketId;
    if (typeof marketId !== 'string' || !policy?.marketsById?.[marketId]) {
        return false;
    }

    const expected = buildConfiguredPublishedMarketIdentity({
        marketId,
        policy,
        config,
    });
    return (
        Number(market?.chainId) === expected.chainId &&
        normalizeOptionalString(market?.agentAddress)?.toLowerCase() === expected.agentAddress &&
        market?.stream?.commitmentSafe === expected.stream.commitmentSafe &&
        market?.stream?.ogModule === expected.stream.ogModule &&
        market?.stream?.user === expected.stream.user &&
        market?.stream?.marketId === expected.stream.marketId &&
        market?.stream?.tradingWallet === expected.stream.tradingWallet
    );
}

function syncNodeMarketLifecycle(state, publishedMarkets) {
    let changed = false;
    const seenMarketIds = new Set();

    for (const market of publishedMarkets) {
        const marketId = market.stream.marketId;
        seenMarketIds.add(marketId);
        const nodeMarket = ensureNodeMarketState(state, marketId);
        const latestRequest = market.reimbursementRequest;
        if (
            latestRequest &&
            latestRequest.requestId !== nodeMarket.reimbursement.requestId &&
            !nodeMarket.reimbursement.submissionTxHash &&
            !nodeMarket.reimbursement.proposalHash &&
            !nodeMarket.reimbursement.submittedAtMs &&
            !nodeMarket.reimbursement.reimbursedAtMs
        ) {
            nodeMarket.reimbursement.requestId = latestRequest.requestId;
            nodeMarket.reimbursement.requestCid = latestRequest.requestCid;
            nodeMarket.reimbursement.requestSnapshotCid = latestRequest.snapshotCid;
            nodeMarket.reimbursement.requestedAtMs = latestRequest.requestedAtMs;
            nodeMarket.reimbursement.lastError = null;
            changed = true;
        } else if (latestRequest && !nodeMarket.reimbursement.requestId) {
            nodeMarket.reimbursement.requestId = latestRequest.requestId;
            nodeMarket.reimbursement.requestCid = latestRequest.requestCid;
            nodeMarket.reimbursement.requestSnapshotCid = latestRequest.snapshotCid;
            nodeMarket.reimbursement.requestedAtMs = latestRequest.requestedAtMs;
            changed = true;
        }
    }

    for (const marketId of Object.keys(state.markets ?? {})) {
        if (seenMarketIds.has(marketId)) {
            continue;
        }
        delete state.markets[marketId];
        changed = true;
    }

    return changed;
}

async function verifySettlementDeposit({
    publicClient,
    market,
    policy,
    commitmentSafe,
}) {
    const requiredAmount = BigInt(market.settlement.finalSettlementValueWei ?? '0');
    if (!market.settlement.settledAtMs) {
        return false;
    }
    if (requiredAmount <= 0n) {
        return true;
    }

    const txHash = normalizeHashOrNull(market.settlement.depositTxHash);
    if (!txHash || !publicClient || typeof publicClient.getTransactionReceipt !== 'function') {
        return false;
    }

    try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
        if (receipt?.status === 0n || receipt?.status === 0 || receipt?.status === 'reverted') {
            return false;
        }
        if (policy.collateralToken === ZERO_ADDRESS) {
            return false;
        }

        let transferred = 0n;
        for (const log of receipt.logs ?? []) {
            if (
                String(log?.address ?? '').toLowerCase() !==
                String(policy.collateralToken).toLowerCase()
            ) {
                continue;
            }
            try {
                const decoded = decodeEventLog({
                    abi: erc20Abi,
                    data: log.data,
                    topics: log.topics,
                });
                if (decoded?.eventName !== 'Transfer') {
                    continue;
                }
                if (
                    String(decoded.args.from ?? '').toLowerCase() !==
                        String(policy.authorizedAgent).toLowerCase() ||
                    String(decoded.args.to ?? '').toLowerCase() !==
                        String(commitmentSafe).toLowerCase()
                ) {
                    continue;
                }
                transferred += BigInt(decoded.args.value ?? 0);
            } catch {
                continue;
            }
        }
        return transferred >= requiredAmount;
    } catch {
        return false;
    }
}

function buildDisputeToolCall(assertionId, blockingMarketIds) {
    return {
        callId: `node-dispute-withdrawal-${assertionId}`,
        name: 'dispute_assertion',
        arguments: JSON.stringify({
            assertionId,
            explanation: `Dispute withdrawal while unsettled Polymarket markets remain: ${blockingMarketIds.join(', ')}`,
        }),
    };
}

function buildNodeReimbursementProposalCallId({ marketId, requestCid }) {
    return `node-reimbursement-proposal:${encodeURIComponent(marketId)}:${requestCid ?? 'missing'}`;
}

function extractNodeReimbursementProposalMarketId(callId) {
    if (typeof callId !== 'string' || !callId.startsWith('node-reimbursement-proposal:')) {
        return null;
    }
    const remainder = callId.slice('node-reimbursement-proposal:'.length);
    const separatorIndex = remainder.indexOf(':');
    const encodedMarketId = separatorIndex === -1 ? remainder : remainder.slice(0, separatorIndex);
    if (!encodedMarketId) {
        return null;
    }
    try {
        return decodeURIComponent(encodedMarketId);
    } catch {
        return encodedMarketId;
    }
}

function buildReimbursementProposalPublicationRequestId(market) {
    const requestCid =
        market.reimbursementRequest?.requestCid ??
        market.lastPublishedCid ??
        market.stream.marketId;
    return `${MODULE_NAME}:${market.stream.marketId}:proposal:${requestCid}`;
}

function assertProposalPublicationReady(config) {
    if (!config?.proposalPublishApiEnabled) {
        throw new Error(
            `${MODULE_NAME} control-node reimbursement proposals require proposalPublishApi.enabled=true.`
        );
    }
    if (String(config.proposalPublishApiMode ?? '').trim().toLowerCase() !== 'propose') {
        throw new Error(
            `${MODULE_NAME} control-node reimbursement proposals require proposalPublishApi.mode=\"propose\".`
        );
    }
}

function resolveBearerTokenFromKeyMap(keyMap) {
    if (!keyMap || typeof keyMap !== 'object' || Array.isArray(keyMap)) {
        return null;
    }
    const entry = Object.entries(keyMap)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .sort(([left], [right]) => left.localeCompare(right))[0];
    return entry ? entry[1].trim() : null;
}

function buildReimbursementProposalToolCall({ market, policy, config }) {
    const reimbursementAmountWei = computeReimbursementEligibleWei(market);
    const transactions = buildOgTransactions(
        [
            {
                kind: 'erc20_transfer',
                token: policy.collateralToken,
                to: policy.authorizedAgent,
                amountWei: reimbursementAmountWei,
                operation: 0,
            },
        ],
        { config }
    );
    const requestCid = market.reimbursementRequest?.requestCid ?? null;
    const requestSnapshotCid = market.reimbursementRequest?.snapshotCid ?? null;
    return {
        callId: buildNodeReimbursementProposalCallId({
            marketId: market.stream.marketId,
            requestCid,
        }),
        name: 'publish_signed_proposal',
        arguments: JSON.stringify({
            proposal: {
                chainId: Number(config.chainId),
                requestId: buildReimbursementProposalPublicationRequestId(market),
                commitmentSafe: config.commitmentSafe,
                ogModule: config.ogModule,
                transactions,
                explanation: buildReimbursementExplanation({
                    market: {
                        ...market,
                        reimbursement: {
                            requestCid,
                        },
                        lastPublishedCid: market.lastPublishedCid,
                    },
                }),
                metadata: {
                    module: MODULE_NAME,
                    proposalKind: REIMBURSEMENT_PROPOSAL_KIND,
                    marketId: market.stream.marketId,
                    publishedTradeLogCid: market.lastPublishedCid ?? null,
                    reimbursementRequestCid: requestCid,
                    reimbursementRequestId: market.reimbursementRequest?.requestId ?? null,
                    reimbursementRequestSnapshotCid: requestSnapshotCid,
                },
            },
            bearerToken: resolveBearerTokenFromKeyMap(policy.proposalPublishApiKeys),
            timeoutMs: policy.publishTimeoutMs,
        }),
    };
}

async function refreshPendingNodeReimbursements(
    state,
    { publicClient, ogModule, pendingTxTimeoutMs }
) {
    if (!publicClient || typeof publicClient.getTransactionReceipt !== 'function') {
        return false;
    }
    let changed = false;
    const nowMs = Date.now();
    for (const marketState of Object.values(state.markets ?? {})) {
        if (marketState.reimbursement.proposalHash || marketState.reimbursement.reimbursedAtMs) {
            continue;
        }
        const txHash = normalizeHashOrNull(marketState.reimbursement.submissionTxHash);
        if (!txHash) {
            continue;
        }
        try {
            const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
            if (receipt?.status === 0n || receipt?.status === 0 || receipt?.status === 'reverted') {
                marketState.reimbursement.submissionTxHash = null;
                marketState.reimbursement.submittedAtMs = null;
                marketState.reimbursement.lastError =
                    'Reimbursement proposal transaction reverted.';
                changed = true;
                continue;
            }
            const proposalHash = extractProposalHashFromReceipt(receipt, ogModule);
            if (proposalHash && proposalHash !== marketState.reimbursement.proposalHash) {
                marketState.reimbursement.proposalHash = proposalHash;
                marketState.reimbursement.lastError = null;
                changed = true;
                continue;
            }
            marketState.reimbursement.submissionTxHash = null;
            marketState.reimbursement.submittedAtMs = null;
            marketState.reimbursement.lastError =
                'Reimbursement proposal transaction confirmed without creating an OG proposal.';
            changed = true;
        } catch {
            const submittedAtMs = Number(marketState.reimbursement.submittedAtMs ?? 0);
            if (
                submittedAtMs > 0 &&
                nowMs - submittedAtMs > Number(pendingTxTimeoutMs ?? 0)
            ) {
                marketState.reimbursement.submissionTxHash = null;
                marketState.reimbursement.submittedAtMs = null;
                marketState.reimbursement.lastError =
                    'Reimbursement proposal transaction could not be reconciled before timeout; retrying is allowed.';
                changed = true;
            }
            continue;
        }
    }
    return changed;
}

function applyNodeProposalLifecycleEvents(state, { executedProposals = [], deletedProposals = [] }) {
    const executed = new Set((executedProposals ?? []).map((value) => normalizeHashOrNull(value)).filter(Boolean));
    const deleted = new Set((deletedProposals ?? []).map((value) => normalizeHashOrNull(value)).filter(Boolean));
    let changed = false;

    for (const marketState of Object.values(state.markets ?? {})) {
        const proposalHash = normalizeHashOrNull(marketState.reimbursement.proposalHash);
        if (!proposalHash) {
            continue;
        }
        if (executed.has(proposalHash)) {
            marketState.reimbursement.reimbursedAtMs = Date.now();
            changed = true;
            continue;
        }
        if (deleted.has(proposalHash)) {
            marketState.reimbursement.submissionTxHash = null;
            marketState.reimbursement.proposalHash = null;
            marketState.reimbursement.submittedAtMs = null;
            marketState.reimbursement.reimbursedAtMs = null;
            marketState.reimbursement.lastError = null;
            changed = true;
        }
    }

    return changed;
}

async function getNodeDeterministicToolCalls({
    signals,
    commitmentSafe,
    publicClient,
    config,
    messagePublicationStore,
    onchainPendingProposal = false,
}) {
    const policy = resolvePolicy(config);
    if (!policy.ready) {
        return [];
    }
    if (!messagePublicationStore || typeof messagePublicationStore.listRecords !== 'function') {
        throw new Error(
            'polymarket-staked-external-settlement node control requires messagePublicationStore.listRecords().'
        );
    }

    await hydrateNodeState({
        config,
        policy,
        commitmentSafe,
        ogModule: config.ogModule,
    });

    let changed = clearStaleNodeDispatches(runtimeNodeState, policy.dispatchGraceMs);
    while (queuedNodeProposalEventUpdates.length > 0) {
        changed =
            applyNodeProposalLifecycleEvents(runtimeNodeState, queuedNodeProposalEventUpdates.shift()) ||
            changed;
    }
    changed =
        (await refreshPendingNodeReimbursements(runtimeNodeState, {
            publicClient,
            ogModule: config.ogModule,
            pendingTxTimeoutMs: policy.pendingTxTimeoutMs,
        })) || changed;

    const publishedMarkets = buildPublishedMarketViews(await messagePublicationStore.listRecords());
    const configuredPublishedMarkets = publishedMarkets.filter((market) =>
        isConfiguredPublishedMarket(market, policy, config)
    );
    changed = syncNodeMarketLifecycle(runtimeNodeState, configuredPublishedMarkets) || changed;
    if (changed) {
        await persistNodeState();
    }

    const decisionState = {
        markets: Object.fromEntries(
            configuredPublishedMarkets.map((market) => [market.stream.marketId, cloneJson(market)])
        ),
        disputedAssertionIds: runtimeNodeState.disputedAssertionIds,
        pendingDispute: runtimeNodeState.pendingDispute,
    };

    if (config?.disputeEnabled && runtimeNodeState.pendingDispute?.assertionId) {
        return [
            buildDisputeToolCall(
                runtimeNodeState.pendingDispute.assertionId,
                runtimeNodeState.pendingDispute.blockingMarketIds ?? []
            ),
        ];
    }

    if (config?.disputeEnabled) {
        const violations = findWithdrawalViolationSignals({
            signals,
            state: decisionState,
            policy,
        });
        if (violations.length > 0) {
            runtimeNodeState.pendingDispute = {
                ...violations[0],
                dispatchAtMs: Date.now(),
            };
            await persistNodeState();
            return [
                buildDisputeToolCall(
                    runtimeNodeState.pendingDispute.assertionId,
                    runtimeNodeState.pendingDispute.blockingMarketIds
                ),
            ];
        }
    }

    if (!config?.proposeEnabled || onchainPendingProposal) {
        return [];
    }

    for (const market of configuredPublishedMarkets) {
        const marketId = market.stream.marketId;
        const nodeMarket = ensureNodeMarketState(runtimeNodeState, marketId);
        if (!market.reimbursementRequest) {
            continue;
        }
        if (market.reimbursementRequest.snapshotCid !== market.lastPublishedCid) {
            continue;
        }
        if (!market.settlement.settledAtMs) {
            continue;
        }
        if (BigInt(computeReimbursementEligibleWei(market)) <= 0n) {
            continue;
        }
        if (BigInt(computeOutstandingSettlementWei(market)) > 0n) {
            continue;
        }
        if (
            nodeMarket.reimbursement.dispatchAtMs ||
            nodeMarket.reimbursement.submissionTxHash ||
            nodeMarket.reimbursement.proposalHash ||
            nodeMarket.reimbursement.submittedAtMs ||
            nodeMarket.reimbursement.reimbursedAtMs
        ) {
            continue;
        }
        const depositReady = await verifySettlementDeposit({
            publicClient,
            market,
            policy,
            commitmentSafe,
        });
        if (!depositReady) {
            continue;
        }
        assertProposalPublicationReady(config);

        nodeMarket.reimbursement.requestId = market.reimbursementRequest.requestId;
        nodeMarket.reimbursement.requestCid = market.reimbursementRequest.requestCid;
        nodeMarket.reimbursement.requestSnapshotCid = market.reimbursementRequest.snapshotCid;
        nodeMarket.reimbursement.requestedAtMs = market.reimbursementRequest.requestedAtMs;
        nodeMarket.reimbursement.dispatchAtMs = Date.now();
        await persistNodeState();
        return [buildReimbursementProposalToolCall({ market, policy, config })];
    }

    return [];
}

async function onNodeToolOutput({ callId, name, parsedOutput, config, commitmentSafe }) {
    const policy = resolvePolicy(config);
    if (!policy.ready) {
        return;
    }
    await hydrateNodeState({
        config,
        policy,
        commitmentSafe: commitmentSafe ?? config.commitmentSafe,
        ogModule: config.ogModule,
    });

    let changed = false;
    if (name === 'dispute_assertion') {
        const status = String(parsedOutput?.status ?? '').trim().toLowerCase();
        if (status === 'submitted' || status === 'confirmed' || status === 'pending') {
            if (!runtimeNodeState.disputedAssertionIds.includes(runtimeNodeState.pendingDispute?.assertionId)) {
                runtimeNodeState.disputedAssertionIds.push(runtimeNodeState.pendingDispute?.assertionId);
            }
            runtimeNodeState.pendingDispute = null;
            changed = true;
        }
    } else if (name === 'publish_signed_proposal') {
        const marketId = extractNodeReimbursementProposalMarketId(callId);
        const nodeMarket = runtimeNodeState.markets?.[marketId];
        if (nodeMarket) {
            nodeMarket.reimbursement.dispatchAtMs = null;
            const publicationStatus = String(parsedOutput?.status ?? '').trim().toLowerCase();
            const submission = parsedOutput?.submission;
            const submissionStatus = String(submission?.status ?? '').trim().toLowerCase();
            if (
                submissionStatus === 'submitted' ||
                submissionStatus === 'resolved' ||
                submissionStatus === 'uncertain'
            ) {
                nodeMarket.reimbursement.submissionTxHash =
                    normalizeHashOrNull(submission?.transactionHash) ??
                    nodeMarket.reimbursement.submissionTxHash;
                nodeMarket.reimbursement.proposalHash =
                    normalizeHashOrNull(submission?.ogProposalHash) ??
                    nodeMarket.reimbursement.proposalHash;
                nodeMarket.reimbursement.submittedAtMs = Date.now();
                nodeMarket.reimbursement.lastError = null;
            } else {
                nodeMarket.reimbursement.lastError =
                    parsedOutput?.message ??
                    (publicationStatus
                        ? `Reimbursement proposal publication returned unexpected status "${publicationStatus}".`
                        : 'Reimbursement proposal publication failed.');
            }
            changed = true;
        }
    }

    if (changed) {
        await persistNodeState();
    }
}

function onNodeProposalEvents({ executedProposals = [], deletedProposals = [] } = {}) {
    queuedNodeProposalEventUpdates.push({
        executedProposals,
        deletedProposals,
    });
}

export {
    getNodeDeterministicToolCalls,
    getNodeState,
    onNodeProposalEvents,
    onNodeToolOutput,
    resetNodeStateForTest,
};
