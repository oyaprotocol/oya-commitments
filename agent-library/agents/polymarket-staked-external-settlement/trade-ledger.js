import { stringifyCanonicalJson } from '../../../agent/src/lib/canonical-json.js';
import { buildStructuredProposalExplanation } from '../../../agent/src/lib/proposal-explanation.js';
import {
    decodeErc20TransferCallData,
    normalizeAddressOrNull,
    normalizeAddressOrThrow,
} from '../../../agent/src/lib/utils.js';
import { cloneJson } from './state-store.js';

const MODULE_NAME = 'polymarket-staked-external-settlement';
const POLYMARKET_REIMBURSEMENT_REQUEST_KIND = 'polymarketReimbursementRequest';
const TRADE_ENTRY_KINDS = new Set(['initiated', 'continuation']);
const TRADE_COMMANDS = new Set(['polymarket_trade', 'polymarket_log_trade']);
const SETTLEMENT_COMMANDS = new Set(['polymarket_settlement', 'polymarket_settle_market']);
const DEFAULT_DISPATCH_GRACE_MS = 30_000;
const DEFAULT_PENDING_TX_TIMEOUT_MS = 900_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function normalizeNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}

function normalizeOptionalString(value) {
    if (value === undefined || value === null) {
        return null;
    }
    const normalized = String(value).trim();
    return normalized ? normalized : null;
}

function normalizeAddress(value, label) {
    return normalizeAddressOrThrow(value, { requireHex: false });
}

function normalizeOptionalAddress(value) {
    return normalizeAddressOrNull(value, { requireHex: false });
}

function parsePositiveInteger(value, label) {
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return normalized;
}

function parseNonNegativeBigIntString(value, label) {
    try {
        const normalized = BigInt(String(value));
        if (normalized < 0n) {
            throw new Error(`${label} must be a non-negative integer.`);
        }
        return normalized.toString();
    } catch {
        throw new Error(`${label} must be a non-negative integer.`);
    }
}

function sumBigIntStrings(values) {
    return values.reduce((total, value) => total + BigInt(String(value ?? 0)), 0n).toString();
}

function resolveModuleConfig(config = {}) {
    const moduleConfig =
        config?.agentConfig?.polymarketStakedExternalSettlement ??
        config?.polymarketStakedExternalSettlement;
    if (moduleConfig && typeof moduleConfig === 'object' && !Array.isArray(moduleConfig)) {
        return moduleConfig;
    }
    return {};
}

function normalizeMarketConfig(rawMarket, marketId, fallbackUserAddress) {
    if (!rawMarket || typeof rawMarket !== 'object' || Array.isArray(rawMarket)) {
        return {
            marketId,
            userAddress: fallbackUserAddress,
            label: null,
        };
    }
    return {
        marketId,
        userAddress:
            normalizeOptionalAddress(rawMarket.userAddress ?? rawMarket.user) ?? fallbackUserAddress,
        label: normalizeOptionalString(rawMarket.label ?? rawMarket.description),
    };
}

function resolvePolicy(config = {}) {
    const moduleConfig = resolveModuleConfig(config);
    const authorizedAgent = normalizeOptionalAddress(moduleConfig.authorizedAgent);
    const tradingWallet =
        normalizeOptionalAddress(moduleConfig.tradingWallet) ?? authorizedAgent ?? null;
    const userAddress = normalizeOptionalAddress(moduleConfig.userAddress ?? moduleConfig.user);
    const collateralToken =
        normalizeOptionalAddress(moduleConfig.collateralToken) ??
        normalizeOptionalAddress(config?.defaultDepositAsset) ??
        normalizeOptionalAddress(Array.isArray(config?.watchAssets) ? config.watchAssets[0] : null);
    const marketsById = Object.fromEntries(
        Object.entries(moduleConfig.marketsById ?? {}).map(([marketId, rawMarket]) => [
            String(marketId),
            normalizeMarketConfig(rawMarket, String(marketId), userAddress),
        ])
    );

    const errors = [];
    if (!authorizedAgent) {
        errors.push('polymarketStakedExternalSettlement.authorizedAgent is required.');
    }
    if (!tradingWallet) {
        errors.push('polymarketStakedExternalSettlement.tradingWallet is required.');
    }
    if (!collateralToken) {
        errors.push(
            'polymarketStakedExternalSettlement.collateralToken is required or watchAssets[0] must be configured.'
        );
    }
    if (!config?.commitmentSafe) {
        errors.push('commitmentSafe is required in the resolved runtime config.');
    }
    if (!config?.ogModule) {
        errors.push('ogModule is required in the resolved runtime config.');
    }
    if (Object.keys(marketsById).length === 0) {
        errors.push('polymarketStakedExternalSettlement.marketsById must define at least one market.');
    }
    const marketsMissingUserAddress = Object.values(marketsById)
        .filter((market) => !market.userAddress)
        .map((market) => market.marketId);
    if (marketsMissingUserAddress.length > 0) {
        errors.push(
            `polymarketStakedExternalSettlement.userAddress is required globally or per market; missing for: ${marketsMissingUserAddress.join(', ')}.`
        );
    }

    return {
        ready: errors.length === 0,
        errors,
        authorizedAgent,
        tradingWallet,
        userAddress,
        collateralToken,
        messagePublishApiKeys:
            config?.messagePublishApiKeys &&
            typeof config.messagePublishApiKeys === 'object' &&
            !Array.isArray(config.messagePublishApiKeys)
                ? cloneJson(config.messagePublishApiKeys)
                : {},
        proposalPublishApiKeys:
            config?.proposalPublishApiKeys &&
            typeof config.proposalPublishApiKeys === 'object' &&
            !Array.isArray(config.proposalPublishApiKeys)
                ? cloneJson(config.proposalPublishApiKeys)
                : {},
        stateFile: normalizeOptionalString(moduleConfig.stateFile),
        nodeStateFile: normalizeOptionalString(moduleConfig.nodeStateFile),
        dispatchGraceMs: parsePositiveInteger(
            moduleConfig.dispatchGraceMs ?? DEFAULT_DISPATCH_GRACE_MS,
            'polymarketStakedExternalSettlement.dispatchGraceMs'
        ),
        pendingTxTimeoutMs: parsePositiveInteger(
            moduleConfig.pendingTxTimeoutMs ?? DEFAULT_PENDING_TX_TIMEOUT_MS,
            'polymarketStakedExternalSettlement.pendingTxTimeoutMs'
        ),
        publishTimeoutMs: parsePositiveInteger(
            moduleConfig.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,
            'polymarketStakedExternalSettlement.publishTimeoutMs'
        ),
        marketsById,
    };
}

function buildStateScope({ config, policy, chainId, commitmentSafe, ogModule }) {
    const marketScopes = Object.fromEntries(
        Object.entries(policy.marketsById ?? {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([marketId, marketConfig]) => [
                marketId,
                {
                    userAddress: marketConfig?.userAddress ?? null,
                },
            ])
    );
    return {
        chainId: Number(chainId),
        commitmentSafe: normalizeAddress(commitmentSafe, 'commitmentSafe'),
        ogModule: normalizeAddress(ogModule, 'ogModule'),
        authorizedAgent: policy.authorizedAgent,
        tradingWallet: policy.tradingWallet,
        userAddress: policy.userAddress,
        collateralToken: policy.collateralToken,
        marketsById: marketScopes,
    };
}

function buildStream({ policy, config, marketId }) {
    const marketConfig = policy.marketsById[marketId];
    if (!marketConfig) {
        throw new Error(`Market "${marketId}" is not configured in marketsById.`);
    }
    const userAddress = marketConfig.userAddress ?? policy.userAddress;
    if (!userAddress) {
        throw new Error(`Market "${marketId}" is missing a userAddress.`);
    }
    return {
        commitmentSafe: normalizeAddress(config.commitmentSafe, 'config.commitmentSafe'),
        ogModule: normalizeAddress(config.ogModule, 'config.ogModule'),
        user: userAddress,
        marketId,
        tradingWallet: policy.tradingWallet,
    };
}

function createEmptyMarketState({ policy, config, marketId }) {
    return {
        stream: buildStream({ policy, config, marketId }),
        revision: 0,
        publishedRevision: 0,
        lastPublishedSequence: 0,
        lastPublishedCid: null,
        latestValidation: null,
        pendingPublication: null,
        trades: [],
        tradeClassifications: {},
        settlement: {
            finalSettlementValueWei: null,
            settledAtMs: null,
            settlementKind: null,
            requestId: null,
            depositDispatchAtMs: null,
            depositTxHash: null,
            depositSubmittedAtMs: null,
            depositConfirmedAtMs: null,
            depositError: null,
        },
        reimbursement: {
            requestDispatchAtMs: null,
            requestId: null,
            requestCid: null,
            requestedAtMs: null,
            pendingRevision: null,
            requestedRevision: null,
            pendingMessage: null,
            lastError: null,
        },
    };
}

function ensureMarketState(state, { policy, config, marketId }) {
    if (!state.markets[marketId]) {
        state.markets[marketId] = createEmptyMarketState({ policy, config, marketId });
    }
    return state.markets[marketId];
}

function findTradeById(market, tradeId) {
    return market.trades.find((trade) => trade.tradeId === tradeId) ?? null;
}

function normalizeTradeCommand(signal, { policy }) {
    const args = signal?.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('polymarket trade commands require args to be a JSON object.');
    }
    const marketId = normalizeNonEmptyString(args.marketId, 'args.marketId');
    if (!policy.marketsById[marketId]) {
        throw new Error(`Trade references unsupported marketId "${marketId}".`);
    }
    const tradeEntryKind = normalizeNonEmptyString(
        args.tradeEntryKind,
        'args.tradeEntryKind'
    ).toLowerCase();
    if (!TRADE_ENTRY_KINDS.has(tradeEntryKind)) {
        throw new Error('args.tradeEntryKind must be "initiated" or "continuation".');
    }
    const principalContributionWei = parseNonNegativeBigIntString(
        args.principalContributionWei ?? '0',
        'args.principalContributionWei'
    );
    if (tradeEntryKind === 'initiated' && BigInt(principalContributionWei) <= 0n) {
        throw new Error('Initiated trades require principalContributionWei > 0.');
    }
    if (tradeEntryKind === 'continuation' && BigInt(principalContributionWei) !== 0n) {
        throw new Error('Continuation trades must set principalContributionWei = 0.');
    }
    return {
        commandType: 'trade',
        marketId,
        requestId: normalizeNonEmptyString(signal.requestId, 'signal.requestId'),
        trade: {
            tradeId: normalizeNonEmptyString(args.tradeId, 'args.tradeId'),
            tradeEntryKind,
            executedAtMs: parsePositiveInteger(args.executedAtMs, 'args.executedAtMs'),
            principalContributionWei,
            side: normalizeOptionalString(args.side),
            outcome: normalizeOptionalString(args.outcome),
            tokenId: normalizeOptionalString(args.tokenId),
            collateralAmountWei:
                args.collateralAmountWei !== undefined
                    ? parseNonNegativeBigIntString(
                          args.collateralAmountWei,
                          'args.collateralAmountWei'
                      )
                    : null,
            shareAmount:
                args.shareAmount !== undefined
                    ? parseNonNegativeBigIntString(args.shareAmount, 'args.shareAmount')
                    : null,
            externalTradeId: normalizeOptionalString(args.externalTradeId),
            description: normalizeOptionalString(signal.text),
            sourceRequestId: normalizeNonEmptyString(signal.requestId, 'signal.requestId'),
        },
    };
}

function normalizeSettlementCommand(signal, { policy }) {
    const args = signal?.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('polymarket settlement commands require args to be a JSON object.');
    }
    const marketId = normalizeNonEmptyString(args.marketId, 'args.marketId');
    if (!policy.marketsById[marketId]) {
        throw new Error(`Settlement references unsupported marketId "${marketId}".`);
    }
    const settlementKind = normalizeNonEmptyString(
        args.settlementKind ?? 'resolved',
        'args.settlementKind'
    ).toLowerCase();
    if (settlementKind !== 'resolved' && settlementKind !== 'flat_exit') {
        throw new Error('args.settlementKind must be "resolved" or "flat_exit".');
    }
    return {
        commandType: 'settlement',
        marketId,
        requestId: normalizeNonEmptyString(signal.requestId, 'signal.requestId'),
        settlement: {
            finalSettlementValueWei: parseNonNegativeBigIntString(
                args.finalSettlementValueWei ?? '0',
                'args.finalSettlementValueWei'
            ),
            settledAtMs: parsePositiveInteger(args.settledAtMs, 'args.settledAtMs'),
            settlementKind,
            description: normalizeOptionalString(signal.text),
        },
    };
}

function interpretSignedAgentCommandSignal(signal, { policy }) {
    if (
        signal?.kind !== 'userMessage' ||
        signal?.sender?.authType !== 'eip191' ||
        !signal?.sender?.address
    ) {
        return null;
    }
    const signer = normalizeOptionalAddress(signal.sender.address);
    if (!signer || signer !== policy.authorizedAgent) {
        return null;
    }
    const command = normalizeOptionalString(signal.command)?.toLowerCase();
    if (!command) {
        return null;
    }
    if (TRADE_COMMANDS.has(command)) {
        return normalizeTradeCommand(signal, { policy });
    }
    if (SETTLEMENT_COMMANDS.has(command)) {
        return normalizeSettlementCommand(signal, { policy });
    }
    return null;
}

function markMarketDirty(market) {
    market.revision = Number(market.revision ?? 0) + 1;
}

function settlementTermsChanged(currentSettlement, nextSettlement) {
    return (
        String(currentSettlement?.finalSettlementValueWei ?? '0') !==
            String(nextSettlement?.finalSettlementValueWei ?? '0') ||
        Number(currentSettlement?.settledAtMs ?? 0) !== Number(nextSettlement?.settledAtMs ?? 0) ||
        String(currentSettlement?.settlementKind ?? '') !==
            String(nextSettlement?.settlementKind ?? '')
    );
}

function ingestCommand(state, command, { policy, config }) {
    if (!command) {
        return false;
    }
    if (state.processedCommands[command.requestId]) {
        return false;
    }
    const market = ensureMarketState(state, {
        policy,
        config,
        marketId: command.marketId,
    });

    if (command.commandType === 'trade') {
        const existing = findTradeById(market, command.trade.tradeId);
        if (existing) {
            throw new Error(
                `Trade "${command.trade.tradeId}" already exists for market "${command.marketId}".`
            );
        }
        if (
            command.trade.tradeEntryKind === 'continuation' &&
            !market.trades.some((trade) => trade.tradeEntryKind === 'initiated')
        ) {
            throw new Error(
                `Continuation trade "${command.trade.tradeId}" requires at least one prior initiated trade for market "${command.marketId}".`
            );
        }
        market.trades.push(cloneJson(command.trade));
        markMarketDirty(market);
    } else if (command.commandType === 'settlement') {
        const nextSettlement = {
            ...market.settlement,
            ...command.settlement,
            requestId: command.requestId,
            depositError: null,
        };
        if (settlementTermsChanged(market.settlement, nextSettlement)) {
            nextSettlement.depositDispatchAtMs = null;
            nextSettlement.depositTxHash = null;
            nextSettlement.depositSubmittedAtMs = null;
            nextSettlement.depositConfirmedAtMs = null;
        }
        if (stringifyCanonicalJson(nextSettlement) !== stringifyCanonicalJson(market.settlement)) {
            market.settlement = nextSettlement;
            markMarketDirty(market);
        }
    }

    state.processedCommands[command.requestId] = {
        commandType: command.commandType,
        marketId: command.marketId,
        processedAtMs: Date.now(),
    };
    return true;
}

function mergeTradeClassifications(market, classifications = [], cid = null) {
    let changed = false;
    for (const entry of Array.isArray(classifications) ? classifications : []) {
        if (!entry?.id || !entry?.classification) {
            continue;
        }
        const existing = market.tradeClassifications[entry.id];
        const normalized = {
            classification: String(entry.classification),
            firstSeenAtMs: Number(entry.firstSeenAtMs ?? 0) || null,
            reason: normalizeOptionalString(entry.reason),
            cid,
        };
        if (stringifyCanonicalJson(existing) === stringifyCanonicalJson(normalized)) {
            continue;
        }
        market.tradeClassifications[entry.id] = normalized;
        changed = true;
    }
    return changed;
}

function computeReimbursementEligibleWei(market) {
    return market.trades
        .filter(
            (trade) =>
                trade.tradeEntryKind === 'initiated' &&
                market.tradeClassifications[trade.tradeId]?.classification === 'reimbursable'
        )
        .reduce((total, trade) => total + BigInt(trade.principalContributionWei), 0n)
        .toString();
}

function computeTotalInitiatedPrincipalWei(market) {
    return market.trades
        .filter((trade) => trade.tradeEntryKind === 'initiated')
        .reduce((total, trade) => total + BigInt(trade.principalContributionWei), 0n)
        .toString();
}

function computeOutstandingSettlementWei(market) {
    const required = BigInt(market.settlement.finalSettlementValueWei ?? 0);
    return required > 0n && !market.settlement.depositConfirmedAtMs ? required.toString() : '0';
}

function buildMarketSummary(market) {
    const reimbursableTradeCount = Object.values(market.tradeClassifications).filter(
        (entry) => entry?.classification === 'reimbursable'
    ).length;
    const lateTradeCount = Object.values(market.tradeClassifications).filter(
        (entry) => entry?.classification === 'non_reimbursable_late'
    ).length;

    return {
        tradeCount: market.trades.length,
        initiatedTradeCount: market.trades.filter((trade) => trade.tradeEntryKind === 'initiated')
            .length,
        continuationTradeCount: market.trades.filter(
            (trade) => trade.tradeEntryKind === 'continuation'
        ).length,
        reimbursableTradeCount,
        lateTradeCount,
        initiatedPrincipalWei: computeTotalInitiatedPrincipalWei(market),
        reimbursementEligibleWei: computeReimbursementEligibleWei(market),
        finalSettlementValueWei: market.settlement.finalSettlementValueWei ?? null,
        settlementOutstandingWei: computeOutstandingSettlementWei(market),
        settlementKind: market.settlement.settlementKind ?? null,
        settledAtMs: market.settlement.settledAtMs ?? null,
        settlementDepositTxHash: market.settlement.depositTxHash ?? null,
        settlementDepositConfirmedAtMs: market.settlement.depositConfirmedAtMs ?? null,
        reimbursementRequestCid: market.reimbursement.requestCid ?? null,
        reimbursementRequestedAtMs: market.reimbursement.requestedAtMs ?? null,
    };
}

function buildPortfolioSummary(state) {
    const markets = Object.values(state.markets ?? {});
    return {
        marketCount: markets.length,
        unsettledMarketIds: markets
            .filter((market) => isMarketBlockingWithdrawals(market))
            .map((market) => market.stream.marketId),
        totalUnsettledReimbursementEligibleWei: sumBigIntStrings(
            markets
                .filter((market) => !market.reimbursement.reimbursedAtMs)
                .map((market) => computeReimbursementEligibleWei(market))
        ),
        totalUnsettledSettlementObligationWei: sumBigIntStrings(
            markets.map((market) => computeOutstandingSettlementWei(market))
        ),
    };
}

function isMarketBlockingWithdrawals(market) {
    if (!market.trades.length) {
        return false;
    }
    if (!market.settlement.settledAtMs) {
        return true;
    }
    return BigInt(computeOutstandingSettlementWei(market)) > 0n;
}

function buildPublicationRequestId(market) {
    return `${MODULE_NAME}:${market.stream.marketId}:seq:${Number(market.lastPublishedSequence) + 1}:rev:${Number(market.revision)}`;
}

function buildReimbursementRequestId(market) {
    return `${MODULE_NAME}:${market.stream.marketId}:reimbursement:${Number(market.revision)}`;
}

function buildTradeLogMessage({ market, config, agentAddress, revision }) {
    return {
        chainId: Number(config.chainId),
        requestId: buildPublicationRequestId(market),
        commitmentAddresses: [market.stream.commitmentSafe, market.stream.ogModule],
        agentAddress,
        kind: 'polymarketTradeLog',
        payload: {
            stream: cloneJson(market.stream),
            sequence: Number(market.lastPublishedSequence) + 1,
            previousCid: market.lastPublishedCid ?? null,
            trades: market.trades.map((trade) => cloneJson(trade)),
            summary: buildMarketSummary(market),
            portfolio: buildPortfolioSummary({ markets: { [market.stream.marketId]: market } }),
            revision,
        },
    };
}

function buildReimbursementExplanation({ market }) {
    return buildStructuredProposalExplanation({
        kind: 'agent_proxy_reimbursement',
        description: `Reimburse the agent for published Polymarket market ${market.stream.marketId}. snapshotCid=${market.lastPublishedCid ?? 'missing'} requestCid=${market.reimbursement.requestCid ?? 'missing'}`,
    });
}

function buildReimbursementRequestMessage({ market, config, agentAddress }) {
    return {
        chainId: Number(config.chainId),
        requestId: buildReimbursementRequestId(market),
        commitmentAddresses: [market.stream.commitmentSafe, market.stream.ogModule],
        agentAddress,
        kind: POLYMARKET_REIMBURSEMENT_REQUEST_KIND,
        payload: {
            stream: cloneJson(market.stream),
            snapshotCid: market.lastPublishedCid,
        },
    };
}

function extractUserTransferFromTransaction(transaction, userAddress) {
    if (!transaction || !userAddress) {
        return false;
    }
    const normalizedTo = normalizeOptionalAddress(transaction.to);
    if (!normalizedTo) {
        return false;
    }
    const nativeValue = BigInt(String(transaction.value ?? '0'));
    if (normalizedTo === userAddress && nativeValue > 0n) {
        return true;
    }
    const transfer = decodeErc20TransferCallData(transaction.data);
    return Boolean(transfer && transfer.to === userAddress && transfer.amount > 0n);
}

function findWithdrawalViolationSignals({ signals, state, policy }) {
    const blockingMarkets = Object.values(state.markets ?? {}).filter((market) =>
        isMarketBlockingWithdrawals(market)
    );
    if (blockingMarkets.length === 0) {
        return [];
    }
    const disputedAssertionIds = new Set(state.disputedAssertionIds ?? []);
    const candidateUserAddresses = new Set(
        blockingMarkets
            .map((market) => normalizeOptionalAddress(market.stream.user))
            .filter(Boolean)
    );

    const violations = [];
    for (const signal of Array.isArray(signals) ? signals : []) {
        if (!signal?.assertionId || disputedAssertionIds.has(signal.assertionId)) {
            continue;
        }
        if (!Array.isArray(signal.transactions) || signal.transactions.length === 0) {
            continue;
        }
        const violates = Array.from(candidateUserAddresses).some((userAddress) =>
            signal.transactions.some((transaction) =>
                extractUserTransferFromTransaction(transaction, userAddress)
            )
        );
        if (!violates) {
            continue;
        }
        violations.push({
            assertionId: signal.assertionId,
            proposalHash: normalizeOptionalString(signal.proposalHash),
            blockingMarketIds: blockingMarkets.map((market) => market.stream.marketId),
        });
    }
    return violations;
}

function clearStaleDispatches(state, dispatchGraceMs, nowMs = Date.now()) {
    let changed = false;
    for (const market of Object.values(state.markets ?? {})) {
        const pendingPublicationAge =
            market.pendingPublication && Number.isInteger(market.pendingPublication.dispatchAtMs)
                ? nowMs - market.pendingPublication.dispatchAtMs
                : null;
        if (pendingPublicationAge !== null && pendingPublicationAge > dispatchGraceMs) {
            market.pendingPublication = null;
            changed = true;
        }
        const reimbursementRequestAge = Number.isInteger(
            market.reimbursement?.requestDispatchAtMs
        )
            ? nowMs - market.reimbursement.requestDispatchAtMs
            : null;
        if (reimbursementRequestAge !== null && reimbursementRequestAge > dispatchGraceMs) {
            market.reimbursement.requestDispatchAtMs = null;
            changed = true;
        }
        const settlementDepositDispatchAge = Number.isInteger(
            market.settlement?.depositDispatchAtMs
        )
            ? nowMs - market.settlement.depositDispatchAtMs
            : null;
        if (
            settlementDepositDispatchAge !== null &&
            settlementDepositDispatchAge > dispatchGraceMs
        ) {
            market.settlement.depositDispatchAtMs = null;
            market.settlement.depositError =
                'Settlement deposit dispatch expired before tool output arrived; retrying is allowed.';
            changed = true;
        }
    }
    return changed;
}

export {
    DEFAULT_DISPATCH_GRACE_MS,
    DEFAULT_PENDING_TX_TIMEOUT_MS,
    ZERO_ADDRESS,
    buildMarketSummary,
    buildPublicationRequestId,
    buildReimbursementRequestId,
    buildReimbursementExplanation,
    buildReimbursementRequestMessage,
    buildStateScope,
    buildStream,
    buildTradeLogMessage,
    clearStaleDispatches,
    computeOutstandingSettlementWei,
    computeReimbursementEligibleWei,
    createEmptyMarketState,
    ensureMarketState,
    findWithdrawalViolationSignals,
    ingestCommand,
    interpretSignedAgentCommandSignal,
    isMarketBlockingWithdrawals,
    markMarketDirty,
    mergeTradeClassifications,
    POLYMARKET_REIMBURSEMENT_REQUEST_KIND,
    resolvePolicy,
    resolveModuleConfig,
};
