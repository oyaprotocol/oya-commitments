import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOgTransactions } from '../../../agent/src/lib/tx.js';
import { getAlwaysEmitBalanceSnapshotPollingOptions } from '../../../agent/src/lib/polling.js';
import { normalizeHashOrNull } from '../../../agent/src/lib/utils.js';
import {
    applyDepositToolOutput,
    applyDisputeToolOutput,
    applyProposalLifecycleEvents,
    applyPublicationToolOutput,
    applyReimbursementToolOutput,
    refreshPendingReimbursements,
    refreshPendingSettlementDeposits,
} from './settlement-reconciliation.js';
import {
    cloneJson,
    createEmptyState,
    deletePersistedState,
    readPersistedState,
    STATE_VERSION,
    writePersistedState,
} from './state-store.js';
import {
    buildPublicationRequestId,
    buildReimbursementExplanation,
    buildStateScope,
    buildTradeLogMessage,
    clearStaleDispatches,
    computeOutstandingSettlementWei,
    computeReimbursementEligibleWei,
    findWithdrawalViolationSignals,
    ingestCommand,
    interpretSignedAgentCommandSignal,
    isMarketBlockingWithdrawals,
    resolvePolicy,
} from './trade-ledger.js';
import {
    derivePublishedMessageLockKeys,
    validatePublishedMessage,
} from './published-message-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_STATE_FILE = path.join(__dirname, '.settlement-state.json');

let runtimeState = createEmptyState();
let runtimeStateHydrated = false;
let runtimeStatePath = null;
let runtimeScopeKey = null;
const queuedProposalEventUpdates = [];

function getStatePath(policy) {
    if (policy?.stateFile) {
        return path.resolve(policy.stateFile);
    }
    return DEFAULT_STATE_FILE;
}

function serializeScope(scope) {
    return JSON.stringify(scope ?? null);
}

async function configureStateContext({ config, policy, commitmentSafe, ogModule }) {
    const scope = buildStateScope({
        config,
        policy,
        chainId: config.chainId,
        commitmentSafe,
        ogModule,
    });
    const nextStatePath = getStatePath(policy);
    const nextScopeKey = `${nextStatePath}:${serializeScope(scope)}`;
    if (runtimeScopeKey === nextScopeKey) {
        return { scope, statePath: nextStatePath };
    }
    runtimeState = createEmptyState(scope);
    runtimeStateHydrated = false;
    runtimeStatePath = nextStatePath;
    runtimeScopeKey = nextScopeKey;
    return { scope, statePath: nextStatePath };
}

async function hydrateState({ config, policy, commitmentSafe, ogModule }) {
    const { scope, statePath } = await configureStateContext({
        config,
        policy,
        commitmentSafe,
        ogModule,
    });
    if (runtimeStateHydrated) {
        return;
    }

    const persisted = await readPersistedState(statePath);
    if (!persisted) {
        runtimeState = createEmptyState(scope);
        runtimeStateHydrated = true;
        return;
    }
    if (persisted.version !== STATE_VERSION) {
        throw new Error(
            `Unsupported persisted ${STATE_VERSION ? 'state version' : 'state'} in ${statePath}: ${persisted.version}`
        );
    }
    if (serializeScope(persisted.scope) !== serializeScope(scope)) {
        throw new Error(
            `Persisted module state scope in ${statePath} does not match the current runtime scope.`
        );
    }
    runtimeState = persisted;
    runtimeStateHydrated = true;
}

async function persistState() {
    if (!runtimeStatePath) {
        throw new Error('State path is not configured.');
    }
    await writePersistedState(runtimeStatePath, runtimeState);
}

function getModuleState() {
    return cloneJson(runtimeState);
}

async function resetModuleStateForTest({ config } = {}) {
    const policy = resolvePolicy(config ?? {});
    await configureStateContext({
        config: config ?? {},
        policy,
        commitmentSafe: config?.commitmentSafe ?? '0x1111111111111111111111111111111111111111',
        ogModule: config?.ogModule ?? '0x2222222222222222222222222222222222222222',
    });
    runtimeState = createEmptyState(runtimeState.scope ?? null);
    runtimeStateHydrated = true;
    queuedProposalEventUpdates.length = 0;
    if (runtimeStatePath) {
        await deletePersistedState(runtimeStatePath);
    }
}

function getSystemPrompt({ proposeEnabled, disputeEnabled, commitmentText }) {
    const mode = proposeEnabled && disputeEnabled
        ? 'You may propose reimbursements and dispute invalid withdrawals.'
        : proposeEnabled
            ? 'You may propose reimbursements but you may not dispute.'
            : disputeEnabled
                ? 'You may dispute invalid withdrawals but you may not propose reimbursements.'
                : 'You may not propose or dispute; provide state only.';

    return [
        'You are a deterministic Polymarket external-settlement agent.',
        'Accept only signed agent-authored trade and settlement commands.',
        'Publish every material market-state change through the companion Oya message-publication node before settlement or reimbursement steps advance.',
        'Treat node-attested trade classifications as the only source of reimbursement eligibility.',
        'Prefer no-op when publication, settlement, or proposal state is incomplete.',
        mode,
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

function getPollingOptions() {
    return getAlwaysEmitBalanceSnapshotPollingOptions();
}

function extractProposalHashes(entries) {
    return (Array.isArray(entries) ? entries : [])
        .map((entry) =>
            typeof entry === 'string'
                ? normalizeHashOrNull(entry)
                : normalizeHashOrNull(entry?.proposalHash)
        )
        .filter(Boolean);
}

function selectSortedMarkets() {
    return Object.values(runtimeState.markets ?? {}).sort((left, right) =>
        left.stream.marketId.localeCompare(right.stream.marketId)
    );
}

function buildPublishToolCall(market, policy) {
    const pending = market.pendingPublication;
    return {
        callId: `publish-trade-log-${market.stream.marketId}-${pending.sequence}`,
        name: 'publish_signed_message',
        arguments: JSON.stringify({
            message: pending.message,
            baseUrl: null,
            bearerToken: null,
            timeoutMs: policy.publishTimeoutMs,
        }),
    };
}

function buildSettlementDepositToolCall(market, policy) {
    return {
        callId: `settlement-deposit-${market.stream.marketId}-${market.revision}`,
        name: 'make_deposit',
        arguments: JSON.stringify({
            asset: policy.collateralToken,
            amountWei: market.settlement.finalSettlementValueWei,
        }),
    };
}

function buildReimbursementToolCall({ market, policy, config }) {
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
    return {
        callId: `reimbursement-proposal-${market.stream.marketId}-${market.revision}`,
        name: 'post_bond_and_propose',
        arguments: JSON.stringify({
            transactions,
            explanation: buildReimbursementExplanation({ market }),
        }),
    };
}

function buildDisputeToolCall(assertionId, blockingMarketIds) {
    return {
        callId: `dispute-withdrawal-${assertionId}`,
        name: 'dispute_assertion',
        arguments: JSON.stringify({
            assertionId,
            explanation: `Dispute withdrawal while unsettled Polymarket markets remain: ${blockingMarketIds.join(', ')}`,
        }),
    };
}

function ingestSignals(signals, { policy, config }) {
    let changed = false;
    for (const signal of Array.isArray(signals) ? signals : []) {
        const interpreted = interpretSignedAgentCommandSignal(signal, { policy });
        if (!interpreted) {
            continue;
        }
        changed = ingestCommand(runtimeState, interpreted, { policy, config }) || changed;
    }
    return changed;
}

function findOrCreatePendingPublication({ policy, config, agentAddress }) {
    for (const market of selectSortedMarkets()) {
        if (!market.pendingPublication && Number(market.revision) > Number(market.publishedRevision)) {
            const message = buildTradeLogMessage({
                market,
                config,
                agentAddress,
                revision: market.revision,
            });
            market.pendingPublication = {
                requestId: buildPublicationRequestId(market),
                sequence: Number(market.lastPublishedSequence) + 1,
                revision: Number(market.revision),
                dispatchAtMs: Date.now(),
                message,
            };
            return { market, changed: true };
        }
        if (market.pendingPublication) {
            return { market, changed: false };
        }
    }
    return null;
}

function selectSettlementDepositCandidate() {
    for (const market of selectSortedMarkets()) {
        if (!market.settlement?.settledAtMs) {
            continue;
        }
        if (BigInt(computeOutstandingSettlementWei(market)) <= 0n) {
            continue;
        }
        if (
            market.settlement.depositDispatchAtMs ||
            market.settlement.depositTxHash ||
            market.settlement.depositConfirmedAtMs
        ) {
            continue;
        }
        market.settlement.depositDispatchAtMs = Date.now();
        return market;
    }
    return null;
}

function selectReimbursementCandidate({ config, onchainPendingProposal }) {
    if (onchainPendingProposal || !config?.proposeEnabled) {
        return null;
    }
    for (const market of selectSortedMarkets()) {
        if (!market.trades.length || !market.settlement?.settledAtMs) {
            continue;
        }
        if (Number(market.revision) > Number(market.publishedRevision) || market.pendingPublication) {
            continue;
        }
        if (BigInt(computeOutstandingSettlementWei(market)) > 0n) {
            continue;
        }
        if (
            market.reimbursement.dispatchAtMs ||
            market.reimbursement.submissionTxHash ||
            market.reimbursement.proposalHash ||
            market.reimbursement.reimbursedAtMs
        ) {
            continue;
        }
        if (BigInt(computeReimbursementEligibleWei(market)) <= 0n) {
            continue;
        }
        market.reimbursement.dispatchAtMs = Date.now();
        return market;
    }
    return null;
}

async function getDeterministicToolCalls({
    signals,
    commitmentSafe,
    agentAddress,
    publicClient,
    config,
    onchainPendingProposal = false,
}) {
    const policy = resolvePolicy(config);
    if (!policy.ready) {
        return [];
    }
    if (String(agentAddress).toLowerCase() !== String(policy.authorizedAgent).toLowerCase()) {
        throw new Error(
            `polymarket-staked-external-settlement may only be served by authorized agent ${policy.authorizedAgent}.`
        );
    }

    await hydrateState({
        config,
        policy,
        commitmentSafe,
        ogModule: config.ogModule,
    });

    let changed = clearStaleDispatches(runtimeState, policy.dispatchGraceMs);
    while (queuedProposalEventUpdates.length > 0) {
        changed =
            applyProposalLifecycleEvents(runtimeState, queuedProposalEventUpdates.shift()) || changed;
    }
    changed =
        (await refreshPendingSettlementDeposits(runtimeState, { publicClient })) || changed;
    changed =
        (await refreshPendingReimbursements(runtimeState, {
            publicClient,
            ogModule: config.ogModule,
        })) || changed;
    changed = ingestSignals(signals, { policy, config }) || changed;

    if (changed) {
        await persistState();
    }

    if (config?.disputeEnabled && runtimeState.pendingDispute?.assertionId) {
        return [
            buildDisputeToolCall(
                runtimeState.pendingDispute.assertionId,
                runtimeState.pendingDispute.blockingMarketIds ?? []
            ),
        ];
    }

    if (config?.disputeEnabled) {
        const violations = findWithdrawalViolationSignals({
            signals,
            state: runtimeState,
            policy,
        });
        if (violations.length > 0) {
            runtimeState.pendingDispute = {
                ...violations[0],
                dispatchAtMs: Date.now(),
            };
            await persistState();
            return [
                buildDisputeToolCall(
                    runtimeState.pendingDispute.assertionId,
                    runtimeState.pendingDispute.blockingMarketIds
                ),
            ];
        }
    }

    const pendingPublication = findOrCreatePendingPublication({
        policy,
        config,
        agentAddress: policy.authorizedAgent,
    });
    if (pendingPublication?.changed) {
        await persistState();
    }
    if (pendingPublication?.market) {
        return [buildPublishToolCall(pendingPublication.market, policy)];
    }

    const settlementDepositMarket = selectSettlementDepositCandidate();
    if (settlementDepositMarket) {
        await persistState();
        return [buildSettlementDepositToolCall(settlementDepositMarket, policy)];
    }

    const reimbursementMarket = selectReimbursementCandidate({
        config,
        onchainPendingProposal,
    });
    if (reimbursementMarket) {
        await persistState();
        return [buildReimbursementToolCall({ market: reimbursementMarket, policy, config })];
    }

    return [];
}

async function onToolOutput({ name, parsedOutput, config, commitmentSafe }) {
    const policy = resolvePolicy(config);
    if (!policy.ready) {
        return;
    }
    await hydrateState({
        config,
        policy,
        commitmentSafe: commitmentSafe ?? config.commitmentSafe,
        ogModule: config.ogModule,
    });

    let changed = false;
    if (name === 'publish_signed_message') {
        changed = applyPublicationToolOutput(runtimeState, parsedOutput) || changed;
    } else if (name === 'make_deposit') {
        changed = applyDepositToolOutput(runtimeState, parsedOutput) || changed;
    } else if (name === 'post_bond_and_propose' || name === 'auto_post_bond_and_propose') {
        changed = applyReimbursementToolOutput(runtimeState, parsedOutput) || changed;
    } else if (name === 'dispute_assertion') {
        changed = applyDisputeToolOutput(runtimeState, parsedOutput) || changed;
    }

    if (changed) {
        await persistState();
    }
}

function onProposalEvents({ executedProposals = [], deletedProposals = [] } = {}) {
    queuedProposalEventUpdates.push({
        executedProposals: extractProposalHashes(executedProposals),
        deletedProposals: extractProposalHashes(deletedProposals),
    });
}

export {
    derivePublishedMessageLockKeys,
    getDeterministicToolCalls,
    getModuleState,
    getPollingOptions,
    getSystemPrompt,
    onProposalEvents,
    onToolOutput,
    resetModuleStateForTest,
    validatePublishedMessage,
};
