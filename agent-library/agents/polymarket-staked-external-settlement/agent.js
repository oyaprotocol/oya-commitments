import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAlwaysEmitBalanceSnapshotPollingOptions } from '../../../agent/src/lib/polling.js';
import {
    applyDepositToolOutput,
    applyPublicationToolOutput,
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
    buildReimbursementRequestId,
    buildReimbursementRequestMessage,
    buildStateScope,
    buildTradeLogMessage,
    clearStaleDispatches,
    computeOutstandingSettlementWei,
    computeReimbursementEligibleWei,
    ingestCommand,
    interpretSignedAgentCommandSignal,
    resolvePolicy,
} from './trade-ledger.js';
import {
    derivePublishedMessageLockKeys,
    validatePublishedMessage,
} from './published-message-validator.js';
import {
    getNodeDeterministicToolCalls,
    getNodeState,
    onNodeProposalEvents,
    onNodeToolOutput,
    resetNodeStateForTest,
} from './node-controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_STATE_FILE = path.join(__dirname, '.settlement-state.json');

let runtimeState = createEmptyState();
let runtimeStateHydrated = false;
let runtimeStatePath = null;
let runtimeScopeKey = null;

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
            `Unsupported persisted state version in ${statePath}: ${persisted.version}`
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
    if (runtimeStatePath) {
        await deletePersistedState(runtimeStatePath);
    }
}

function getSystemPrompt({ commitmentText }) {
    return [
        'You are a deterministic Polymarket external-settlement agent.',
        'Accept only signed agent-authored trade and settlement commands.',
        'Publish every material market-state change through the companion Oya message-publication node before reimbursement requests advance.',
        'Treat node-attested trade classifications as the only source of reimbursement eligibility.',
        'This agent loop is responsible for trade logging and settlement deposits, while the standalone node owns withdrawal disputes and reimbursement proposal submission.',
        'Prefer no-op when publication or settlement state is incomplete.',
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

function getPollingOptions() {
    return getAlwaysEmitBalanceSnapshotPollingOptions();
}

function selectSortedMarkets() {
    return Object.values(runtimeState.markets ?? {}).sort((left, right) =>
        left.stream.marketId.localeCompare(right.stream.marketId)
    );
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

function buildPublishToolCall({ message, callId }, policy) {
    return {
        callId,
        name: 'publish_signed_message',
        arguments: JSON.stringify({
            message,
            baseUrl: null,
            bearerToken: resolveBearerTokenFromKeyMap(policy.messagePublishApiKeys),
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

function findOrCreatePendingTradeLogPublication({ policy, config, agentAddress }) {
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
            return {
                changed: true,
                toolCall: buildPublishToolCall(
                    {
                        message,
                        callId: `publish-trade-log-${market.stream.marketId}-${market.pendingPublication.sequence}`,
                    },
                    policy
                ),
            };
        }
        if (market.pendingPublication) {
            return {
                changed: false,
                toolCall: buildPublishToolCall(
                    {
                        message: market.pendingPublication.message,
                        callId: `publish-trade-log-${market.stream.marketId}-${market.pendingPublication.sequence}`,
                    },
                    policy
                ),
            };
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

function findOrCreatePendingReimbursementRequest({ policy, config, agentAddress }) {
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
        if (BigInt(computeReimbursementEligibleWei(market)) <= 0n) {
            continue;
        }
        if (market.reimbursement.requestDispatchAtMs) {
            return {
                changed: false,
                toolCall: buildPublishToolCall(
                    {
                        message: market.reimbursement.pendingMessage,
                        callId: `publish-reimbursement-request-${market.stream.marketId}-${market.revision}`,
                    },
                    policy
                ),
            };
        }
        if (market.reimbursement.requestedRevision === Number(market.revision)) {
            continue;
        }

        market.reimbursement.requestId = buildReimbursementRequestId(market);
        market.reimbursement.pendingMessage = buildReimbursementRequestMessage({
            market,
            config,
            agentAddress,
        });
        market.reimbursement.pendingRevision = Number(market.revision);
        market.reimbursement.requestDispatchAtMs = Date.now();
        return {
            changed: true,
            toolCall: buildPublishToolCall(
                {
                    message: market.reimbursement.pendingMessage,
                    callId: `publish-reimbursement-request-${market.stream.marketId}-${market.revision}`,
                },
                policy
            ),
        };
    }
    return null;
}

async function getDeterministicToolCalls({
    signals,
    commitmentSafe,
    agentAddress,
    publicClient,
    config,
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
    changed = (await refreshPendingSettlementDeposits(runtimeState, { publicClient })) || changed;
    changed = ingestSignals(signals, { policy, config }) || changed;

    if (changed) {
        await persistState();
    }

    const pendingPublication = findOrCreatePendingTradeLogPublication({
        policy,
        config,
        agentAddress: policy.authorizedAgent,
    });
    if (pendingPublication) {
        if (pendingPublication.changed) {
            await persistState();
        }
        return [pendingPublication.toolCall];
    }

    const settlementDepositMarket = selectSettlementDepositCandidate();
    if (settlementDepositMarket) {
        await persistState();
        return [buildSettlementDepositToolCall(settlementDepositMarket, policy)];
    }

    const reimbursementRequest = findOrCreatePendingReimbursementRequest({
        policy,
        config,
        agentAddress: policy.authorizedAgent,
    });
    if (reimbursementRequest) {
        if (reimbursementRequest.changed) {
            await persistState();
        }
        return [reimbursementRequest.toolCall];
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
    }

    if (changed) {
        await persistState();
    }
}

function onProposalEvents() {}

export {
    derivePublishedMessageLockKeys,
    getDeterministicToolCalls,
    getModuleState,
    getNodeDeterministicToolCalls,
    getNodeState,
    getPollingOptions,
    getSystemPrompt,
    onNodeProposalEvents,
    onNodeToolOutput,
    onProposalEvents,
    onToolOutput,
    resetModuleStateForTest,
    resetNodeStateForTest,
    validatePublishedMessage,
};
