import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    decodeEventLog,
    erc1155Abi,
    getAddress,
    isAddressEqual,
    parseAbiItem,
    parseUnits,
} from 'viem';
import { buildSignedMessagePayload } from '../../../agent/src/lib/message-signing.js';
import {
    transactionsProposedEvent,
} from '../../../agent/src/lib/og.js';
import { getAlwaysEmitBalanceSnapshotPollingOptions } from '../../../agent/src/lib/polling.js';
import {
    DEFAULT_COLLATERAL_TOKEN,
} from '../../../agent/src/lib/polymarket.js';
import { resolveRelayerProxyWallet } from '../../../agent/src/lib/polymarket-relayer.js';
import { buildOgTransactions } from '../../../agent/src/lib/tx.js';
import {
    decodeErc20TransferCallData,
    normalizeAddressOrNull,
    normalizeHashOrNull,
    normalizeTokenId,
} from '../../../agent/src/lib/utils.js';
import {
    buildCreditSnapshot,
    createDepositRecord,
    getAvailableCreditWeiForAddress,
    getDepositedCreditWeiForAddress,
    getReservedCreditWeiForAddress,
} from './credit-ledger.js';
import {
    backfillDeposits,
    backfillReimbursementCommitments,
} from './history-backfill.js';
import {
    clearStageAmbiguity,
    clearStageDispatchStarted,
    clearStageSubmissionTracking,
    getLifecycleStageFields,
    markStageAmbiguity,
    markStageDispatchStarted,
    noteStageTimeoutAmbiguity,
} from './lifecycle-stage.js';
import {
    reduceArchiveToolOutput,
    reduceDepositSubmissionConfirmedReceipt,
    reduceDepositSubmissionMissingTxTimeout,
    reduceDepositSubmissionReceiptTimeout,
    reduceDepositSubmissionRevertedReceipt,
    reduceDepositToolOutput,
    reduceOrderToolOutput,
    reduceReimbursementSubmissionConfirmedReceipt,
    reduceReimbursementSubmissionMissingTxTimeout,
    reduceReimbursementSubmissionReceiptTimeout,
    reduceReimbursementSubmissionRevertedReceipt,
    reduceReimbursementToolOutput,
} from './lifecycle-reducers.js';
import { planNextActionCandidates } from './planner.js';
import {
    extractOrderIdFromSubmission,
    extractOrderStatusFromSubmission,
    fetchClobFeeRateBps,
    getClobAuthAddress,
    refreshPolicyMarketConstraints,
    refreshOrderStatus,
} from './polymarket-reconciliation.js';
import {
    cloneJson,
    createEmptyTradeIntentState,
    deletePersistedTradeIntentState,
    readPersistedTradeIntentState,
    writePersistedTradeIntentState,
} from './state-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_VERSION = 4;
const ARTIFACT_VERSION = 'oya-polymarket-signed-intent-archive-v1';
const FILENAME_PREFIX = 'signed-trade-intent-';
const FILENAME_SUFFIX = '.json';
const PRICE_SCALE = 1_000_000n;
const USDC_DECIMALS = 6;
const SHARE_DECIMALS = 6;
const DEFAULT_ARCHIVE_RETRY_DELAY_MS = 30_000;
const DEFAULT_PENDING_TX_TIMEOUT_MS = 900_000;
const PENDING_ORDER_DISPATCH_GRACE_MS = 30_000;
const PENDING_DEPOSIT_DISPATCH_GRACE_MS = 30_000;
const PENDING_PROPOSAL_DISPATCH_GRACE_MS = 30_000;
const DEFAULT_LOG_CHUNK_SIZE = 5_000n;
const DEFAULT_SIGNED_COMMANDS = [
    'buy',
    'trade',
    'intent',
    'polymarket_buy',
    'polymarket_trade',
    'polymarket_intent',
];
const erc1155TransferSingleEvent = parseAbiItem(
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)'
);
const erc1155TransferBatchEvent = parseAbiItem(
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
);

const tradeIntentState = createEmptyTradeIntentState();

let tradeIntentStateHydrated = false;
let statePathOverride = null;
let runtimeStatePath = null;
let runtimeStateNamespaceKey = null;
let pendingArtifactPublish = null;
let pendingOrderSubmission = null;
let pendingDepositSubmission = null;
let pendingProposalSubmission = null;
let depositBackfillStatusLogged = false;
let reimbursementBackfillStatusLogged = false;
const queuedProposalEventUpdates = [];

function markStateDirty() {
    // State writes are infrequent and the runtime is single-threaded enough for direct writes.
}

async function resolveEffectivePolicy(config = {}) {
    const policy = resolvePolicy(config);
    if (!policy.ready) {
        return policy;
    }
    return refreshPolicyMarketConstraints({ policy, config });
}

function resetInMemoryState({ hydrated = false, preserveQueuedProposalEventUpdates = false } = {}) {
    const emptyState = createEmptyTradeIntentState();
    tradeIntentState.nextSequence = emptyState.nextSequence;
    tradeIntentState.intents = emptyState.intents;
    tradeIntentState.deposits = emptyState.deposits;
    tradeIntentState.reimbursementCommitments = emptyState.reimbursementCommitments;
    tradeIntentState.pendingExecutedProposalHashes = emptyState.pendingExecutedProposalHashes;
    tradeIntentState.pendingDeletedProposalHashes = emptyState.pendingDeletedProposalHashes;
    tradeIntentState.backfilledDepositsThroughBlock = emptyState.backfilledDepositsThroughBlock;
    tradeIntentState.backfilledReimbursementCommitmentsThroughBlock =
        emptyState.backfilledReimbursementCommitmentsThroughBlock;
    tradeIntentStateHydrated = hydrated;
    pendingArtifactPublish = null;
    pendingOrderSubmission = null;
    pendingDepositSubmission = null;
    pendingProposalSubmission = null;
    depositBackfillStatusLogged = false;
    reimbursementBackfillStatusLogged = false;
    if (!preserveQueuedProposalEventUpdates) {
        queuedProposalEventUpdates.length = 0;
    }
}

function sanitizeStatePathSegment(value) {
    const sanitized = String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return sanitized || 'default';
}

function getStatePath() {
    if (typeof statePathOverride === 'string' && statePathOverride.trim()) {
        return path.resolve(statePathOverride.trim());
    }
    if (typeof runtimeStatePath === 'string' && runtimeStatePath.trim()) {
        return runtimeStatePath;
    }
    return path.join(__dirname, '.trade-intent-state.json');
}

async function configureRuntimeStateContext({ publicClient, commitmentSafe, config }) {
    if (typeof statePathOverride === 'string' && statePathOverride.trim()) {
        return;
    }

    const normalizedSafe = normalizeAddress(commitmentSafe);
    let chainId = 'unknown';
    if (typeof publicClient?.getChainId === 'function') {
        try {
            chainId = String(await publicClient.getChainId());
        } catch (error) {
            chainId = 'unknown';
        }
    }

    const namespaceKey = `chain-${chainId}-safe-${normalizedSafe.toLowerCase()}`;
    const agentConfig = config?.agentConfig ?? {};
    const configuredStatePath =
        typeof agentConfig.statePath === 'string' && agentConfig.statePath.trim()
            ? path.resolve(agentConfig.statePath.trim())
            : null;
    const configuredStateDir =
        typeof agentConfig.stateDir === 'string' && agentConfig.stateDir.trim()
            ? path.resolve(agentConfig.stateDir.trim())
            : __dirname;
    const nextStatePath =
        configuredStatePath ??
        path.join(
            configuredStateDir,
            `.trade-intent-state-${sanitizeStatePathSegment(namespaceKey)}.json`
        );

    if (runtimeStateNamespaceKey === namespaceKey && runtimeStatePath === nextStatePath) {
        return;
    }

    const preserveQueuedProposalEventUpdates =
        runtimeStateNamespaceKey === null && runtimeStatePath === null;
    runtimeStateNamespaceKey = namespaceKey;
    runtimeStatePath = nextStatePath;
    resetInMemoryState({ preserveQueuedProposalEventUpdates });
}

function normalizeAddress(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('Address must be a non-empty string.');
    }
    return getAddress(value.trim()).toLowerCase();
}

function normalizeHash(value) {
    return normalizeHashOrNull(value);
}

function normalizeHashArray(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    return Array.from(new Set(values.map((value) => normalizeHash(value)).filter(Boolean)));
}

function normalizeNonEmptyString(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function parseOptionalPositiveInteger(value) {
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized <= 0) {
        return null;
    }
    return normalized;
}

function parseOptionalNonNegativeIntegerString(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    try {
        const normalized = BigInt(String(value));
        if (normalized < 0n) {
            return null;
        }
        return normalized.toString();
    } catch (error) {
        return null;
    }
}

function normalizeWhitespace(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeDecimalText(value) {
    const normalized = String(value ?? '')
        .replace(/,/g, '')
        .trim();
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
        return null;
    }
    const [wholeRaw, fractionRaw = ''] = normalized.split('.');
    const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
    const fraction = fractionRaw.replace(/0+$/, '');
    return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

function formatScaledDecimal(value, decimals) {
    const normalized = BigInt(value);
    const negative = normalized < 0n;
    const absolute = negative ? -normalized : normalized;
    const scale = 10n ** BigInt(decimals);
    const whole = absolute / scale;
    const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
    const sign = negative ? '-' : '';
    return fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

function computeCeilDiv(numerator, denominator) {
    const normalizedNumerator = BigInt(numerator);
    const normalizedDenominator = BigInt(denominator);
    if (normalizedDenominator <= 0n) {
        throw new Error('denominator must be > 0.');
    }
    return (normalizedNumerator + normalizedDenominator - 1n) / normalizedDenominator;
}

function normalizeTradePrice(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
        return null;
    }
    return parsed;
}

function isReceiptUnavailableError(error) {
    const name = String(error?.name ?? '');
    if (
        name.includes('TransactionReceiptNotFoundError') ||
        name.includes('TransactionNotFoundError')
    ) {
        return true;
    }

    const message = String(error?.shortMessage ?? error?.message ?? '').toLowerCase();
    return message.includes('transaction receipt') && message.includes('not found');
}

function hasTimedOut(submittedAtMs, timeoutMs, nowMs = Date.now()) {
    const normalizedSubmittedAtMs = Number(submittedAtMs ?? 0);
    if (!Number.isFinite(normalizedSubmittedAtMs) || normalizedSubmittedAtMs <= 0) {
        return false;
    }
    return nowMs - normalizedSubmittedAtMs >= timeoutMs;
}

function clearStalePendingDepositSubmission(nowMs = Date.now()) {
    if (
        !pendingDepositSubmission?.intentKey ||
        !hasTimedOut(
            pendingDepositSubmission.startedAtMs,
            PENDING_DEPOSIT_DISPATCH_GRACE_MS,
            nowMs
        )
    ) {
        return false;
    }
    pendingDepositSubmission = null;
    return true;
}

function clearStalePendingOrderSubmission(nowMs = Date.now()) {
    if (
        !pendingOrderSubmission?.intentKey ||
        !hasTimedOut(
            pendingOrderSubmission.startedAtMs,
            PENDING_ORDER_DISPATCH_GRACE_MS,
            nowMs
        )
    ) {
        return false;
    }
    pendingOrderSubmission = null;
    return true;
}

function clearStalePendingProposalSubmission(nowMs = Date.now()) {
    if (
        !pendingProposalSubmission?.intentKey ||
        !hasTimedOut(
            pendingProposalSubmission.startedAtMs,
            PENDING_PROPOSAL_DISPATCH_GRACE_MS,
            nowMs
        )
    ) {
        return false;
    }
    pendingProposalSubmission = null;
    return true;
}

function reconcileDurableDispatchState(nowMs = Date.now()) {
    let changed = false;
    const orderFields = getLifecycleStageFields('order');
    const depositFields = getLifecycleStageFields('deposit');
    const reimbursementFields = getLifecycleStageFields('reimbursement');

    for (const intent of getOpenIntents()) {
        if (
            Number.isInteger(intent[orderFields.dispatchAt]) &&
            !intent[orderFields.externalId] &&
            !intent[orderFields.submittedAt] &&
            hasTimedOut(intent[orderFields.dispatchAt], PENDING_ORDER_DISPATCH_GRACE_MS, nowMs)
        ) {
            intent[orderFields.submittedAt] = intent[orderFields.dispatchAt];
            intent[orderFields.status] = intent[orderFields.status] ?? 'dispatch_pending';
            intent[orderFields.error] =
                intent[orderFields.error] ??
                'Polymarket order tool output was lost after dispatch; treating submission as ambiguous and refusing automatic retry.';
            delete intent[orderFields.backoffAt];
            clearStageDispatchStarted(intent, 'order');
            intent.updatedAtMs = nowMs;
            changed = true;
        }

        if (
            Number.isInteger(intent[depositFields.dispatchAt]) &&
            !intent[depositFields.txHash] &&
            !intent[depositFields.submittedAt] &&
            hasTimedOut(intent[depositFields.dispatchAt], PENDING_DEPOSIT_DISPATCH_GRACE_MS, nowMs)
        ) {
            intent[depositFields.submittedAt] = intent[depositFields.dispatchAt];
            delete intent[depositFields.backoffAt];
            clearStageDispatchStarted(intent, 'deposit');
            markStageAmbiguity(
                intent,
                'deposit',
                'ERC1155 deposit tool output was lost after dispatch; treating submission as ambiguous and refusing automatic retry.',
                nowMs
            );
            changed = true;
        }

        if (
            Number.isInteger(intent[reimbursementFields.dispatchAt]) &&
            !intent.reimbursementProposalHash &&
            !intent[reimbursementFields.txHash] &&
            !intent[reimbursementFields.submittedAt] &&
            hasTimedOut(intent[reimbursementFields.dispatchAt], PENDING_PROPOSAL_DISPATCH_GRACE_MS, nowMs)
        ) {
            intent[reimbursementFields.submittedAt] = intent[reimbursementFields.dispatchAt];
            intent.lastReimbursementSubmissionStatus =
                intent.lastReimbursementSubmissionStatus ?? 'dispatch_pending';
            clearStageDispatchStarted(intent, 'reimbursement');
            markStageAmbiguity(
                intent,
                'reimbursement',
                'Reimbursement proposal tool output was lost after dispatch; treating submission as ambiguous and refusing automatic retry.',
                nowMs
            );
            changed = true;
        }
    }

    return changed;
}

async function readOutcomeTokenBalance({
    publicClient,
    policy,
    tokenHolderAddress,
    tokenId,
}) {
    if (!publicClient || !policy?.ctfContract || !tokenHolderAddress || tokenId === undefined || tokenId === null) {
        return null;
    }

    const balance = await publicClient.readContract({
        address: policy.ctfContract,
        abi: erc1155Abi,
        functionName: 'balanceOf',
        args: [tokenHolderAddress, BigInt(tokenId)],
    });
    return BigInt(balance);
}

async function observeFilledTokenInventoryDelta({
    publicClient,
    policy,
    tokenHolderAddress,
    intent,
}) {
    const normalizedHolder = normalizeAddressOrNull(
        tokenHolderAddress ?? intent?.preOrderTokenHolderAddress ?? null
    );
    const preOrderTokenBalance = parseOptionalNonNegativeIntegerString(intent?.preOrderTokenBalance);
    if (!normalizedHolder || !preOrderTokenBalance) {
        return null;
    }
    if (hasConcurrentTokenSettlementDependency({ intent, tokenHolderAddress: normalizedHolder })) {
        return null;
    }

    const currentBalance = await readOutcomeTokenBalance({
        publicClient,
        policy,
        tokenHolderAddress: normalizedHolder,
        tokenId: intent.tokenId,
    });
    if (currentBalance === null) {
        return null;
    }

    const observedDelta = currentBalance - BigInt(preOrderTokenBalance);
    return observedDelta > 0n ? observedDelta.toString() : null;
}

function getExpectedDepositSourceAddress(intent) {
    return normalizeAddressOrNull(
        intent?.depositSourceAddress ??
            intent?.preOrderTokenHolderAddress ??
            intent?.tradingWalletAddress ??
            intent?.reimbursementRecipientAddress ??
            null
    );
}

function getExpectedDepositAmount(intent) {
    return parseOptionalNonNegativeIntegerString(
        intent?.depositExpectedAmount ?? intent?.filledShareAmount ?? null
    );
}

function matchesRecoveredDepositSignal({ signal, intent, policy }) {
    if (signal?.kind !== 'erc1155Deposit') {
        return false;
    }
    const signalToken = normalizeAddressOrNull(signal?.token ?? signal?.asset ?? null);
    if (!signalToken || !policy?.ctfContract || signalToken !== policy.ctfContract) {
        return false;
    }
    if (normalizeTokenId(signal?.tokenId) !== normalizeTokenId(intent?.tokenId)) {
        return false;
    }
    const expectedSourceAddress = getExpectedDepositSourceAddress(intent);
    if (!expectedSourceAddress) {
        return false;
    }
    const signalSourceAddress = normalizeAddressOrNull(signal?.from ?? null);
    if (!signalSourceAddress || signalSourceAddress !== expectedSourceAddress) {
        return false;
    }
    const expectedAmount = getExpectedDepositAmount(intent);
    const signalAmount = parseOptionalNonNegativeIntegerString(signal?.amount);
    if (!expectedAmount || !signalAmount || signalAmount !== expectedAmount) {
        return false;
    }
    return true;
}

function findRecoveredDepositSignal({ signals, intent, policy }) {
    for (const signal of Array.isArray(signals) ? signals : []) {
        if (matchesRecoveredDepositSignal({ signal, intent, policy })) {
            return signal;
        }
    }
    return null;
}

function extractRecoveredDepositLogMatch({ intent, log }) {
    if (!log?.args) {
        return null;
    }

    const expectedTokenId = normalizeTokenId(intent?.tokenId);
    const expectedAmount = getExpectedDepositAmount(intent);
    if (!expectedTokenId || !expectedAmount) {
        return null;
    }

    const logTokenId = parseOptionalNonNegativeIntegerString(log.args?.id);
    const logAmount = parseOptionalNonNegativeIntegerString(log.args?.value);
    if (logTokenId && logAmount && logTokenId === expectedTokenId && logAmount === expectedAmount) {
        return log;
    }

    const ids = Array.isArray(log.args?.ids) ? log.args.ids : [];
    const values = Array.isArray(log.args?.values) ? log.args.values : [];
    for (let index = 0; index < ids.length; index += 1) {
        const batchTokenId = parseOptionalNonNegativeIntegerString(ids[index]);
        const batchAmount = parseOptionalNonNegativeIntegerString(values[index]);
        if (
            batchTokenId &&
            batchAmount &&
            batchTokenId === expectedTokenId &&
            batchAmount === expectedAmount
        ) {
            return log;
        }
    }

    return null;
}

async function findRecoveredDepositLog({
    publicClient,
    policy,
    commitmentSafe,
    latestBlock,
    intent,
}) {
    if (!publicClient || !policy?.ctfContract || !commitmentSafe) {
        return null;
    }

    const depositSourceAddress = getExpectedDepositSourceAddress(intent);
    const fromBlock = parseOptionalNonNegativeIntegerString(intent?.depositDispatchBlockNumber);
    if (!depositSourceAddress || !fromBlock) {
        return null;
    }

    const toBlock = BigInt(latestBlock);
    const normalizedFromBlock = BigInt(fromBlock);
    if (normalizedFromBlock > toBlock) {
        return null;
    }

    const [singleLogs, batchLogs] = await Promise.all([
        publicClient.getLogs({
            address: policy.ctfContract,
            event: erc1155TransferSingleEvent,
            args: {
                from: depositSourceAddress,
                to: commitmentSafe,
            },
            fromBlock: normalizedFromBlock,
            toBlock,
        }),
        publicClient.getLogs({
            address: policy.ctfContract,
            event: erc1155TransferBatchEvent,
            args: {
                from: depositSourceAddress,
                to: commitmentSafe,
            },
            fromBlock: normalizedFromBlock,
            toBlock,
        }),
    ]);

    const matches = [...singleLogs, ...batchLogs]
        .map((log) => extractRecoveredDepositLogMatch({ intent, log }))
        .filter(Boolean)
        .sort((left, right) => {
            const leftBlock = BigInt(left.blockNumber ?? 0n);
            const rightBlock = BigInt(right.blockNumber ?? 0n);
            if (leftBlock !== rightBlock) {
                return leftBlock < rightBlock ? -1 : 1;
            }
            return Number(left.logIndex ?? 0) - Number(right.logIndex ?? 0);
        });

    return matches[0] ?? null;
}

function markRecoveredDepositTransfer(intent, recovered, nowMs = Date.now()) {
    const transactionHash = normalizeHash(recovered?.transactionHash);
    if (transactionHash) {
        intent.depositTxHash = transactionHash;
    }
    if (recovered?.blockNumber !== undefined && recovered?.blockNumber !== null) {
        intent.depositBlockNumber = BigInt(recovered.blockNumber).toString();
    }
    if (!Number.isInteger(intent.depositSubmittedAtMs)) {
        intent.depositSubmittedAtMs = intent.depositDispatchAtMs ?? nowMs;
    }
    intent.tokenDeposited = true;
    intent.tokenDepositedAtMs = nowMs;
    clearStageDispatchStarted(intent, 'deposit');
    clearStageAmbiguity(intent, 'deposit');
    intent.updatedAtMs = nowMs;
}

async function reconcileRecoveredDepositSubmissions({
    signals,
    publicClient,
    commitmentSafe,
    latestBlock,
    policy,
}) {
    let changed = false;
    const nowMs = Date.now();

    for (const intent of getOpenIntents()) {
        if (intent.tokenDeposited) {
            continue;
        }
        if (!Number.isInteger(intent.depositSubmittedAtMs) && !Number.isInteger(intent.depositDispatchAtMs)) {
            continue;
        }

        const recoveredSignal = findRecoveredDepositSignal({ signals, intent, policy });
        if (recoveredSignal) {
            markRecoveredDepositTransfer(intent, recoveredSignal, nowMs);
            changed = true;
            continue;
        }

        const recoveredLog = await findRecoveredDepositLog({
            publicClient,
            policy,
            commitmentSafe,
            latestBlock,
            intent,
        });
        if (recoveredLog) {
            markRecoveredDepositTransfer(intent, recoveredLog, nowMs);
            changed = true;
        }
    }

    return changed;
}

function hasConcurrentTokenSettlementDependency({ intent, tokenHolderAddress }) {
    const normalizedHolder = normalizeAddressOrNull(
        tokenHolderAddress ?? intent?.preOrderTokenHolderAddress ?? null
    );
    if (!normalizedHolder) {
        return true;
    }

    return getOpenIntents().some((otherIntent) => {
        if (!otherIntent || otherIntent.intentKey === intent?.intentKey) {
            return false;
        }
        if (otherIntent.tokenDeposited || otherIntent.closedAtMs || otherIntent.creditReleasedAtMs) {
            return false;
        }
        if (normalizeTokenId(otherIntent.tokenId) !== normalizeTokenId(intent?.tokenId)) {
            return false;
        }
        const otherHolder = normalizeAddressOrNull(
            otherIntent.preOrderTokenHolderAddress ??
                otherIntent.tradingWalletAddress ??
                otherIntent.reimbursementRecipientAddress ??
                null
        );
        return otherHolder === normalizedHolder;
    });
}

function clearDepositSubmissionAmbiguity(intent) {
    clearStageAmbiguity(intent, 'deposit');
}

function markAmbiguousDepositSubmission(intent, detail, nowMs = Date.now()) {
    markStageAmbiguity(intent, 'deposit', detail, nowMs);
}

function clearReimbursementSubmissionAmbiguity(intent) {
    clearStageAmbiguity(intent, 'reimbursement');
}

function markAmbiguousReimbursementSubmission(intent, detail, nowMs = Date.now()) {
    markStageAmbiguity(intent, 'reimbursement', detail, nowMs);
}

function clearReimbursementSubmissionTracking(intent) {
    clearStageSubmissionTracking(intent, 'reimbursement');
}

function setPendingProposalLifecycleHashes({ executed = [], deleted = [] }) {
    const nextExecuted = normalizeHashArray(executed);
    const nextDeleted = normalizeHashArray(deleted);
    const executedChanged =
        JSON.stringify(tradeIntentState.pendingExecutedProposalHashes) !== JSON.stringify(nextExecuted);
    const deletedChanged =
        JSON.stringify(tradeIntentState.pendingDeletedProposalHashes) !== JSON.stringify(nextDeleted);
    if (!executedChanged && !deletedChanged) {
        return false;
    }
    tradeIntentState.pendingExecutedProposalHashes = nextExecuted;
    tradeIntentState.pendingDeletedProposalHashes = nextDeleted;
    markStateDirty();
    return true;
}

function getClobExecutionPreflightError(config) {
    if (!config?.polymarketClobEnabled) {
        return 'polymarketClobEnabled=true is required before placing Polymarket orders.';
    }
    if (!config?.proposeEnabled) {
        return 'proposeEnabled=true is required before placing Polymarket orders, because filled intents must deposit outcome tokens and submit reimbursement proposals onchain.';
    }
    if (
        !config?.polymarketClobApiKey ||
        !config?.polymarketClobApiSecret ||
        !config?.polymarketClobApiPassphrase
    ) {
        return 'Missing CLOB credentials. Set POLYMARKET_CLOB_API_KEY, POLYMARKET_CLOB_API_SECRET, and POLYMARKET_CLOB_API_PASSPHRASE.';
    }
    return null;
}

function sortIntentRecords(records) {
    return [...records].sort((left, right) => {
        const leftSequence = Number(left?.sequence ?? 0);
        const rightSequence = Number(right?.sequence ?? 0);
        if (leftSequence !== rightSequence) {
            return leftSequence - rightSequence;
        }
        return String(left?.intentKey ?? '').localeCompare(String(right?.intentKey ?? ''));
    });
}

function getTrackedIntents() {
    return sortIntentRecords(
        Object.values(tradeIntentState.intents).filter(
            (intent) => intent?.sourceKind === 'signed_trade_intent'
        )
    );
}

function getOpenIntents() {
    return getTrackedIntents().filter(
        (intent) => !intent?.closedAtMs && !intent?.reimbursedAtMs && !intent?.creditReleasedAtMs
    );
}

function getReimbursementHeadroomWei(intent) {
    if (!intent?.signer) {
        return 0n;
    }
    const depositedWei = getDepositedCreditWeiForAddress(tradeIntentState, intent.signer);
    const reservedWei = getReservedCreditWeiForAddress(tradeIntentState, intent.signer);
    const ownReservedWei = BigInt(intent.reservedCreditAmountWei ?? 0);
    const otherReservedWei = reservedWei > ownReservedWei ? reservedWei - ownReservedWei : 0n;
    return depositedWei - otherReservedWei;
}

function allocateSequence() {
    const nextSequence = Number(tradeIntentState.nextSequence ?? 1);
    tradeIntentState.nextSequence = nextSequence + 1;
    markStateDirty();
    return nextSequence;
}

async function hydrateTradeIntentState() {
    if (tradeIntentStateHydrated) return;
    tradeIntentStateHydrated = true;
    try {
        const parsed = await readPersistedTradeIntentState(getStatePath());
        if (!parsed) {
            return;
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            tradeIntentState.nextSequence =
                Number.isInteger(parsed.nextSequence) && parsed.nextSequence > 0
                    ? parsed.nextSequence
                    : 1;
            tradeIntentState.intents =
                parsed.intents && typeof parsed.intents === 'object' && !Array.isArray(parsed.intents)
                    ? parsed.intents
                    : {};
            tradeIntentState.deposits =
                parsed.deposits &&
                typeof parsed.deposits === 'object' &&
                !Array.isArray(parsed.deposits)
                    ? parsed.deposits
                    : {};
            tradeIntentState.reimbursementCommitments =
                parsed.reimbursementCommitments &&
                typeof parsed.reimbursementCommitments === 'object' &&
                !Array.isArray(parsed.reimbursementCommitments)
                    ? parsed.reimbursementCommitments
                    : {};
            tradeIntentState.pendingExecutedProposalHashes = normalizeHashArray(
                parsed.pendingExecutedProposalHashes
            );
            tradeIntentState.pendingDeletedProposalHashes = normalizeHashArray(
                parsed.pendingDeletedProposalHashes
            );
            tradeIntentState.backfilledDepositsThroughBlock =
                typeof parsed.backfilledDepositsThroughBlock === 'string' &&
                parsed.backfilledDepositsThroughBlock.trim()
                    ? parsed.backfilledDepositsThroughBlock.trim()
                    : null;
            tradeIntentState.backfilledReimbursementCommitmentsThroughBlock =
                typeof parsed.backfilledReimbursementCommitmentsThroughBlock === 'string' &&
                parsed.backfilledReimbursementCommitmentsThroughBlock.trim()
                    ? parsed.backfilledReimbursementCommitmentsThroughBlock.trim()
                    : null;
        }
    } catch (error) {
        resetInMemoryState({ hydrated: true, preserveQueuedProposalEventUpdates: true });
        throw new Error(
            `Failed to hydrate polymarket-intent-trader state from ${getStatePath()}: ${error?.message ?? error}`
        );
    }
}

async function persistTradeIntentState() {
    await writePersistedTradeIntentState(getStatePath(), {
        version: STATE_VERSION,
        nextSequence: tradeIntentState.nextSequence,
        intents: tradeIntentState.intents,
        deposits: tradeIntentState.deposits,
        reimbursementCommitments: tradeIntentState.reimbursementCommitments,
        pendingExecutedProposalHashes: tradeIntentState.pendingExecutedProposalHashes,
        pendingDeletedProposalHashes: tradeIntentState.pendingDeletedProposalHashes,
        backfilledDepositsThroughBlock: tradeIntentState.backfilledDepositsThroughBlock,
        backfilledReimbursementCommitmentsThroughBlock:
            tradeIntentState.backfilledReimbursementCommitmentsThroughBlock,
    });
}

async function maybePersistTradeIntentState() {
    await persistTradeIntentState();
}

async function resetTradeIntentState() {
    resetInMemoryState({ hydrated: true });
    await deletePersistedTradeIntentState(getStatePath());
}

function setTradeIntentStatePathForTest(nextPath) {
    statePathOverride =
        typeof nextPath === 'string' && nextPath.trim() ? nextPath.trim() : null;
    runtimeStatePath = null;
    runtimeStateNamespaceKey = null;
    resetInMemoryState();
}

function getTradeIntentState() {
    return cloneJson(tradeIntentState);
}

async function resolveTokenHolderAddress({ publicClient, config, account }) {
    const runtimeSignerAddress = normalizeAddressOrNull(account?.address);
    const fallbackAddress =
        getClobAuthAddress({
            config,
            accountAddress: account?.address,
        }) ?? runtimeSignerAddress;

    if (!config?.polymarketRelayerEnabled) {
        return {
            tokenHolderAddress: runtimeSignerAddress,
            tokenHolderResolutionError: runtimeSignerAddress
                ? null
                : 'Unable to resolve runtime signer address for non-relayer ERC1155 deposits.',
        };
    }

    const configuredRelayerAddress = normalizeAddressOrNull(
        config?.polymarketRelayerFromAddress
    );
    if (configuredRelayerAddress) {
        return {
            tokenHolderAddress: configuredRelayerAddress,
            tokenHolderResolutionError: null,
        };
    }

    try {
        const resolved = await resolveRelayerProxyWallet({
            publicClient,
            account,
            config,
        });
        const resolvedProxyWallet = normalizeAddressOrNull(resolved?.proxyWallet);
        if (!resolvedProxyWallet) {
            return {
                tokenHolderAddress: null,
                tokenHolderResolutionError:
                    'Relayer proxy wallet resolution returned an invalid address.',
            };
        }
        return {
            tokenHolderAddress: resolvedProxyWallet,
            tokenHolderResolutionError: null,
        };
    } catch (error) {
        return {
            tokenHolderAddress: null,
            tokenHolderResolutionError: error?.message ?? String(error),
        };
    }
}

function resolvePolicy(config = {}) {
    const candidate =
        config?.agentConfig?.polymarketIntentTrader ?? config?.polymarketIntentTrader ?? {};
    const signedCommands =
        Array.isArray(candidate.signedCommands) && candidate.signedCommands.length > 0
            ? candidate.signedCommands
            : DEFAULT_SIGNED_COMMANDS;

    const collateralToken =
        normalizeAddressOrNull(candidate.collateralToken) ??
        (Array.isArray(config?.watchAssets) && config.watchAssets.length > 0
            ? normalizeAddressOrNull(config.watchAssets[0])
            : normalizeAddressOrNull(DEFAULT_COLLATERAL_TOKEN));
    const minimumTickSize =
        normalizePriceToScaled(
            candidate.minimumTickSize ?? candidate.tickSize ?? candidate.minimum_tick_size,
            null
        ) ?? null;

    const policy = {
        authorizedAgent: normalizeAddressOrNull(
            candidate.authorizedAgent ?? candidate.agentAddress ?? null
        ),
        marketId: normalizeNonEmptyString(candidate.marketId),
        minimumTickSize: minimumTickSize?.decimal ?? null,
        minimumTickSizeScaled: minimumTickSize?.scaled ?? null,
        yesTokenId: normalizeTokenId(candidate.yesTokenId),
        noTokenId: normalizeTokenId(candidate.noTokenId),
        collateralToken,
        ogModule: normalizeAddressOrNull(config?.ogModule),
        ctfContract:
            normalizeAddressOrNull(candidate.ctfContract) ??
            normalizeAddressOrNull(config?.polymarketConditionalTokens),
        archiveRetryDelayMs:
            parseOptionalPositiveInteger(candidate.archiveRetryDelayMs) ??
            DEFAULT_ARCHIVE_RETRY_DELAY_MS,
        pendingTxTimeoutMs:
            parseOptionalPositiveInteger(candidate.pendingTxTimeoutMs) ??
            DEFAULT_PENDING_TX_TIMEOUT_MS,
        logChunkSize:
            config?.logChunkSize !== undefined && config?.logChunkSize !== null
                ? BigInt(config.logChunkSize)
                : DEFAULT_LOG_CHUNK_SIZE,
        signedCommands: new Set(
            signedCommands
                .map((entry) => normalizeNonEmptyString(entry)?.toLowerCase())
                .filter(Boolean)
        ),
        errors: [],
    };

    if (!policy.marketId) {
        policy.errors.push('polymarketIntentTrader.marketId is required.');
    }
    if (!policy.minimumTickSizeScaled) {
        policy.errors.push(
            'polymarketIntentTrader.minimumTickSize is required (for example 0.01 or 0.001).'
        );
    }
    if (!policy.authorizedAgent) {
        policy.errors.push('polymarketIntentTrader.authorizedAgent is required.');
    }
    if (!policy.yesTokenId) {
        policy.errors.push('polymarketIntentTrader.yesTokenId is required.');
    }
    if (!policy.noTokenId) {
        policy.errors.push('polymarketIntentTrader.noTokenId is required.');
    }
    if (!policy.collateralToken) {
        policy.errors.push(
            'polymarketIntentTrader.collateralToken is required or watchAssets[0] must be configured.'
        );
    }
    if (!policy.ctfContract) {
        policy.errors.push(
            'polymarketIntentTrader.ctfContract is required or polymarketConditionalTokens must be configured.'
        );
    }
    policy.ready = policy.errors.length === 0;
    return policy;
}

function resolveExpiryMs(signal) {
    return parseOptionalPositiveInteger(signal?.deadline);
}

function containsBuyVerb(text) {
    return /\b(buy|purchase)\b/i.test(text);
}

function containsSellVerb(text) {
    return /\b(sell|short)\b/i.test(text);
}

function containsNegatedBuyInstruction(text) {
    return /\b(?:do\s+not|don't|dont|never|not)\s+(?:buy|purchase)\b/i.test(text);
}

function parseOutcomeFromText(text) {
    if (containsNegatedBuyInstruction(text)) {
        return null;
    }

    const actionMatch = text.match(/\b(?:buy|purchase)\s+(?:the\s+)?(yes|no)\b/i);
    if (actionMatch?.[1]) {
        return actionMatch[1].trim().toUpperCase();
    }

    const outcomes = new Set(
        Array.from(text.matchAll(/\b(yes|no)\b/gi), (match) => match[1].trim().toUpperCase())
    );
    if (outcomes.size === 1) {
        return Array.from(outcomes)[0];
    }
    return null;
}

function parseMaxSpendFromText(text) {
    const patterns = [
        /\bfor\s+up\s+to\s+\$?((?:[\d,]+(?:\.\d+)?|\.\d+))\s*(?:usdc|usd|dollars?)\b/gi,
        /\bfor\s+up\s+to\s+\$((?:[\d,]+(?:\.\d+)?|\.\d+))\b/gi,
        /\bup\s+to\s+\$?((?:[\d,]+(?:\.\d+)?|\.\d+))\s*(?:usdc|usd|dollars?)\b/gi,
        /\bup\s+to\s+\$((?:[\d,]+(?:\.\d+)?|\.\d+))\b/gi,
        /\b(?:spend|use|risk)\s+up\s+to\s+\$?((?:[\d,]+(?:\.\d+)?|\.\d+))\s*(?:usdc|usd|dollars?)\b/gi,
        /\b(?:spend|use|risk)\s+up\s+to\s+\$((?:[\d,]+(?:\.\d+)?|\.\d+))\b/gi,
        /\bmax(?:imum)?\s+(?:spend|cost|notional)?\s*\$?((?:[\d,]+(?:\.\d+)?|\.\d+))\s*(?:usdc|usd|dollars?)\b/gi,
        /\bmax(?:imum)?\s+(?:spend|cost|notional)?\s*\$((?:[\d,]+(?:\.\d+)?|\.\d+))\b/gi,
        /\bfor\s+\$?((?:[\d,]+(?:\.\d+)?|\.\d+))\s*(?:usdc|usd|dollars?)\b/gi,
        /\bfor\s+\$((?:[\d,]+(?:\.\d+)?|\.\d+))\b/gi,
    ];

    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            const normalized = normalizeDecimalText(match[1]);
            if (!normalized) continue;
            try {
                const wei = parseUnits(normalized, USDC_DECIMALS);
                if (wei <= 0n) continue;
                return {
                    usdc: normalized,
                    wei: wei.toString(),
                };
            } catch (error) {
                // Ignore malformed candidates and continue scanning.
            }
        }
    }

    return null;
}

function normalizePriceToScaled(value, unit) {
    const normalized = normalizeDecimalText(value);
    if (!normalized) return null;

    try {
        const scaled =
            unit === 'c' || unit === 'cent' || unit === 'cents' || unit === '%'
                ? parseUnits(normalized, 4)
                : parseUnits(normalized, 6);
        if (scaled <= 0n || scaled > PRICE_SCALE) {
            return null;
        }
        return {
            decimal: formatScaledDecimal(scaled, 6),
            scaled: scaled.toString(),
        };
    } catch (error) {
        return null;
    }
}

function isPriceOnTick({ priceScaled, tickSizeScaled }) {
    try {
        const normalizedPriceScaled = BigInt(String(priceScaled));
        const normalizedTickSizeScaled = BigInt(String(tickSizeScaled));
        if (normalizedPriceScaled <= 0n || normalizedTickSizeScaled <= 0n) {
            return false;
        }
        return normalizedPriceScaled % normalizedTickSizeScaled === 0n;
    } catch (error) {
        return false;
    }
}

function parseMaxPriceFromText(text) {
    const patterns = [
        /\b(?:price\s*(?:is|<=|=<|<|under|at\s+most|up\s+to)|max(?:imum)?\s+price(?:\s+is)?|at)\s*\$?((?:[\d,]+(?:\.\d+)?|\.\d+))\s*(c|cent|cents|%)\b(?:\s+or\s+(?:better|less|lower))?/gi,
        /\b(?:price\s*(?:is|<=|=<|<|under|at\s+most|up\s+to)|max(?:imum)?\s+price(?:\s+is)?|at)\s*\$?((?:[\d,]+(?:\.\d+)?|\.\d+))\b(?:\s+or\s+(?:better|less|lower))?/gi,
    ];

    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            const normalized = normalizePriceToScaled(match[1], match[2]?.toLowerCase() ?? null);
            if (normalized) {
                return normalized;
            }
        }
    }

    return null;
}

function buildIntentKey({ signer, requestId }) {
    return `${signer}:${requestId}`;
}

function encodeRequestIdForFilename(requestId) {
    return Buffer.from(String(requestId), 'utf8').toString('hex');
}

function buildArtifactFilename(requestId) {
    return `${FILENAME_PREFIX}${encodeRequestIdForFilename(requestId)}${FILENAME_SUFFIX}`;
}

function computeBuyOrderAmounts({ collateralAmountWei, price, tickSizeScaled = null }) {
    const normalizedCollateralAmountWei = BigInt(collateralAmountWei);
    if (normalizedCollateralAmountWei <= 0n) {
        throw new Error('collateralAmountWei must be > 0 for buy-order sizing.');
    }

    const normalizedPrice = normalizeTradePrice(price);
    if (!normalizedPrice) {
        throw new Error('price must be a number between 0 and 1 for buy-order sizing.');
    }

    const priceScaled = BigInt(Math.round(normalizedPrice * Number(PRICE_SCALE)));
    if (priceScaled <= 0n) {
        throw new Error('price is too small for buy-order sizing.');
    }
    if (tickSizeScaled !== null && !isPriceOnTick({ priceScaled, tickSizeScaled })) {
        throw new Error('price does not conform to the configured minimum tick size.');
    }

    // For BUY orders on Polymarket, makerAmount is the USDC spend and takerAmount is the
    // minimum number of shares to receive at the signed worst price or better.
    const takerAmount = computeCeilDiv(
        normalizedCollateralAmountWei * PRICE_SCALE,
        priceScaled
    );
    if (takerAmount <= 0n) {
        throw new Error('takerAmount computed to zero; refusing order.');
    }

    return {
        makerAmount: normalizedCollateralAmountWei.toString(),
        takerAmount: takerAmount.toString(),
        priceScaled: priceScaled.toString(),
    };
}

function isSignedUserMessage(signal) {
    return (
        signal?.kind === 'userMessage' &&
        signal?.sender?.authType === 'eip191' &&
        typeof signal?.sender?.address === 'string' &&
        typeof signal?.sender?.signature === 'string' &&
        Number.isInteger(signal?.sender?.signedAtMs) &&
        typeof signal?.requestId === 'string' &&
        signal.requestId.trim().length > 0
    );
}

function interpretSignedTradeIntentSignal(
    signal,
    {
        policy = resolvePolicy({}),
        commitmentSafe = null,
        agentAddress = null,
        nowMs = Date.now(),
    } = {}
) {
    if (!policy.ready) {
        return { ok: false, reason: 'policy_not_ready' };
    }
    if (!isSignedUserMessage(signal)) {
        return { ok: false, reason: 'not_signed_user_message' };
    }

    const signer = normalizeAddress(signal.sender.address);
    const requestId = signal.requestId.trim();
    const normalizedCommand = normalizeNonEmptyString(signal.command)?.toLowerCase() ?? '';
    if (
        normalizedCommand &&
        policy.signedCommands.size > 0 &&
        !policy.signedCommands.has(normalizedCommand)
    ) {
        return { ok: false, reason: 'unsupported_command' };
    }

    const text = normalizeWhitespace(signal.text);
    if (!text) {
        return { ok: false, reason: 'missing_text' };
    }
    if (!containsBuyVerb(text)) {
        return { ok: false, reason: 'missing_buy_instruction' };
    }
    if (containsSellVerb(text)) {
        return { ok: false, reason: 'sell_not_supported' };
    }

    const outcome = parseOutcomeFromText(text);
    if (!outcome) {
        return { ok: false, reason: 'missing_or_ambiguous_outcome' };
    }

    const maxSpend = parseMaxSpendFromText(text);
    if (!maxSpend) {
        return { ok: false, reason: 'missing_max_spend' };
    }

    const maxPrice = parseMaxPriceFromText(text);
    if (!maxPrice) {
        return { ok: false, reason: 'missing_max_price' };
    }
    if (
        policy.minimumTickSizeScaled &&
        !isPriceOnTick({
            priceScaled: maxPrice.scaled,
            tickSizeScaled: policy.minimumTickSizeScaled,
        })
    ) {
        return { ok: false, reason: 'invalid_price_tick' };
    }

    const expiryMs = resolveExpiryMs(signal);
    if (!expiryMs) {
        return { ok: false, reason: 'missing_expiry' };
    }
    if (nowMs > expiryMs) {
        return { ok: false, reason: 'expired' };
    }

    let orderAmounts;
    try {
        orderAmounts = computeBuyOrderAmounts({
            collateralAmountWei: maxSpend.wei,
            price: maxPrice.decimal,
            tickSizeScaled: policy.minimumTickSizeScaled ?? null,
        });
    } catch (error) {
        return {
            ok: false,
            reason: 'invalid_order_price',
            detail: error?.message ?? String(error),
        };
    }
    const tokenId = outcome === 'YES' ? policy.yesTokenId : policy.noTokenId;
    const canonicalMessage = buildSignedMessagePayload({
        address: signer,
        chainId: signal.chainId,
        timestampMs: signal.sender.signedAtMs,
        text: signal.text,
        command: signal.command,
        args: signal.args,
        metadata: signal.metadata,
        requestId,
        deadline: signal.deadline,
    });

    return {
        ok: true,
        intent: {
            intentKey: buildIntentKey({ signer, requestId }),
            sourceKind: 'signed_trade_intent',
            requestId,
            messageId: signal.messageId ?? null,
            signer,
            signature: signal.sender.signature,
            signedAtMs: signal.sender.signedAtMs,
            receivedAtMs: signal.receivedAtMs ?? null,
            chainId: signal.chainId ?? null,
            deadline: signal.deadline ?? null,
            expiresAtMs: signal.expiresAtMs ?? null,
            expiryMs,
            text,
            command: signal.command ?? null,
            args: cloneJson(signal.args ?? null),
            metadata: cloneJson(signal.metadata ?? null),
            marketId: policy.marketId,
            side: 'BUY',
            outcome,
            tokenId,
            maxSpendUsdc: maxSpend.usdc,
            maxSpendWei: maxSpend.wei,
            reservedCreditAmountWei: maxSpend.wei,
            reimbursementAmountWei: null,
            filledShareAmount: null,
            maxPrice: maxPrice.decimal,
            maxPriceScaled: maxPrice.scaled,
            orderMakerAmount: orderAmounts.makerAmount,
            orderTakerAmount: orderAmounts.takerAmount,
            orderPriceScaled: orderAmounts.priceScaled,
            feeRateBps: null,
            archiveFilename: buildArtifactFilename(requestId),
            canonicalMessage,
            commitmentSafe: commitmentSafe ? normalizeAddress(commitmentSafe) : null,
            tradingWalletAddress: agentAddress ? normalizeAddress(agentAddress) : null,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
        },
    };
}

async function maybeBackfillDeposits({
    publicClient,
    commitmentSafe,
    latestBlock,
    policy,
    config,
}) {
    const result = await backfillDeposits({
        state: tradeIntentState,
        publicClient,
        commitmentSafe,
        latestBlock,
        policy,
        config,
        statusLogged: depositBackfillStatusLogged,
    });
    depositBackfillStatusLogged = result.statusLogged;
    if (result.changed) {
        markStateDirty();
    }
    return result.changed;
}

async function maybeBackfillReimbursementCommitments({
    publicClient,
    latestBlock,
    policy,
    config,
}) {
    const result = await backfillReimbursementCommitments({
        state: tradeIntentState,
        publicClient,
        latestBlock,
        policy,
        config,
        statusLogged: reimbursementBackfillStatusLogged,
    });
    reimbursementBackfillStatusLogged = result.statusLogged;
    if (result.changed) {
        markStateDirty();
    }
    return result.changed;
}

function ingestSignals(signals, policy) {
    let changed = false;

    for (const signal of Array.isArray(signals) ? signals : []) {
        try {
            const deposit = createDepositRecord(signal, {
                collateralToken: policy.collateralToken,
            });
            if (deposit && !tradeIntentState.deposits[deposit.depositKey]) {
                tradeIntentState.deposits[deposit.depositKey] = deposit;
                console.log(
                    `[agent] Recorded Polymarket collateral credit for ${deposit.depositor}: amountWei=${deposit.amountWei} depositKey=${deposit.depositKey}.`
                );
                changed = true;
            }
        } catch (error) {
            continue;
        }
    }

    if (changed) {
        markStateDirty();
    }
    return changed;
}

function buildSignedTradeIntentArchiveArtifact({ record, commitmentSafe, agentAddress }) {
    if (!record?.canonicalMessage) {
        throw new Error(
            'buildSignedTradeIntentArchiveArtifact requires a parsed signed intent record.'
        );
    }

    return {
        version: ARTIFACT_VERSION,
        requestId: record.requestId,
        messageId: record.messageId ?? null,
        interpretedIntent: {
            side: record.side,
            outcome: record.outcome,
            marketId: record.marketId,
            tokenId: record.tokenId,
            maxSpendUsdc: record.maxSpendUsdc,
            maxSpendWei: record.maxSpendWei,
            maxPrice: record.maxPrice,
            maxPriceScaled: record.maxPriceScaled,
            expiryMs: record.expiryMs,
        },
        signedRequest: {
            authType: 'eip191',
            signer: record.signer,
            signature: record.signature,
            signedAtMs: record.signedAtMs,
            canonicalMessage: record.canonicalMessage,
            envelope: {
                chainId: record.chainId ?? null,
                requestId: record.requestId,
                deadline: record.deadline ?? null,
                text: record.text ?? null,
                command: record.command ?? null,
                args: cloneJson(record.args ?? null),
                metadata: cloneJson(record.metadata ?? null),
            },
        },
        agentContext: {
            commitmentSafe: commitmentSafe ?? record.commitmentSafe ?? null,
            agentAddress: agentAddress ?? record.tradingWalletAddress ?? null,
            receivedAtMs: record.receivedAtMs ?? null,
            expiresAtMs: record.expiresAtMs ?? null,
        },
    };
}

function encodeExplanationFieldValue(value) {
    return encodeURIComponent(String(value ?? ''));
}

function buildReimbursementExplanation(record) {
    return [
        'polymarket-intent-trader reimbursement',
        `intent=${encodeExplanationFieldValue(record.intentKey)}`,
        `requestId=${encodeExplanationFieldValue(record.requestId ?? 'n/a')}`,
        `signer=${encodeExplanationFieldValue(record.signer ?? 'unknown')}`,
        `outcome=${encodeExplanationFieldValue(record.outcome ?? 'unknown')}`,
        `market=${encodeExplanationFieldValue(record.marketId ?? 'unknown')}`,
        `tokenId=${encodeExplanationFieldValue(record.tokenId ?? 'unknown')}`,
        `signedRequestCid=${encodeExplanationFieldValue(record.artifactUri ?? 'missing')}`,
        `orderId=${encodeExplanationFieldValue(record.orderId ?? 'missing')}`,
        `spentWei=${encodeExplanationFieldValue(record.reimbursementAmountWei ?? record.maxSpendWei ?? '0')}`,
        `depositTx=${encodeExplanationFieldValue(record.depositTxHash ?? 'pending')}`,
    ].join(' | ');
}

function getIntentLifecycleStatus(record, nowMs = Date.now()) {
    if (!record) return 'unknown';
    if (record.reimbursedAtMs) return 'reimbursed';
    if (record.closedAtMs) return 'closed';
    if (record.reimbursementProposalHash || record.reimbursementSubmissionTxHash) {
        return 'reimbursement_submitted';
    }
    if (record.reimbursementDispatchAtMs) return 'reimbursement_dispatching';
    if (record.tokenDeposited) return 'deposited';
    if (record.depositDispatchAtMs) return 'deposit_dispatching';
    if (record.depositTxHash) return 'deposit_submitted';
    if (record.orderFilled) return 'order_filled';
    if (record.orderSubmittedAtMs) return 'order_submitted';
    if (record.orderDispatchAtMs) return 'order_dispatching';
    if (record.orderId) return 'order_submitted';
    if (record.artifactCid) return 'archived';
    if (Number.isInteger(record.expiryMs) && nowMs > record.expiryMs) return 'expired';
    return 'accepted';
}

function buildIntentSignal(record, nowMs = Date.now()) {
    return {
        kind: 'polymarketTradeIntent',
        intentKey: record.intentKey,
        requestId: record.requestId,
        messageId: record.messageId ?? null,
        signer: record.signer,
        signedAtMs: record.signedAtMs,
        text: record.text,
        side: record.side,
        outcome: record.outcome,
        marketId: record.marketId,
        tokenId: record.tokenId,
        maxSpendUsdc: record.maxSpendUsdc,
        maxSpendWei: record.maxSpendWei,
        reservedCreditAmountWei: record.reservedCreditAmountWei,
        maxPrice: record.maxPrice,
        maxPriceScaled: record.maxPriceScaled,
        orderDispatchAtMs: record.orderDispatchAtMs ?? null,
        orderId: record.orderId ?? null,
        orderStatus: record.orderStatus ?? null,
        orderFilled: Boolean(record.orderFilled),
        depositDispatchAtMs: record.depositDispatchAtMs ?? null,
        depositTxHash: record.depositTxHash ?? null,
        tokenDeposited: Boolean(record.tokenDeposited),
        reimbursementAmountWei: record.reimbursementAmountWei ?? null,
        filledShareAmount: record.filledShareAmount ?? null,
        reimbursementDispatchAtMs: record.reimbursementDispatchAtMs ?? null,
        reimbursementProposalHash: record.reimbursementProposalHash ?? null,
        reimbursementSubmissionTxHash: record.reimbursementSubmissionTxHash ?? null,
        archived: Boolean(record.artifactCid),
        artifactCid: record.artifactCid ?? null,
        artifactUri: record.artifactUri ?? null,
        expired: Number.isInteger(record.expiryMs) && nowMs > record.expiryMs,
        status: getIntentLifecycleStatus(record, nowMs),
    };
}

function buildArchiveSignal(record, commitmentSafe, agentAddress) {
    return {
        kind: 'polymarketSignedIntentArchive',
        intentKey: record.intentKey,
        requestId: record.requestId,
        archiveFilename: record.archiveFilename,
        archiveArtifact: buildSignedTradeIntentArchiveArtifact({
            record,
            commitmentSafe,
            agentAddress,
        }),
        archived: Boolean(record.artifactCid),
        artifactCid: record.artifactCid ?? null,
        artifactUri: record.artifactUri ?? null,
    };
}

function resolveOgProposalHashFromToolOutput(parsedOutput) {
    const txHash = normalizeHash(parsedOutput?.transactionHash);
    const explicitOgHash = normalizeHash(parsedOutput?.ogProposalHash);
    if (explicitOgHash) return explicitOgHash;

    const legacyHash = normalizeHash(parsedOutput?.proposalHash);
    if (!legacyHash) return null;
    if (txHash && legacyHash === txHash) return null;
    return legacyHash;
}

function extractProposalHashFromReceipt({ receipt, ogModule }) {
    const normalizedOgModule = normalizeAddressOrNull(ogModule);
    if (!normalizedOgModule || !Array.isArray(receipt?.logs)) {
        return null;
    }

    for (const log of receipt.logs) {
        if (!isAddressEqual(log?.address, normalizedOgModule)) {
            continue;
        }

        const directHash = normalizeHash(log?.args?.proposalHash);
        if (directHash) {
            return directHash;
        }

        try {
            const decoded = decodeEventLog({
                abi: [transactionsProposedEvent],
                data: log.data,
                topics: log.topics,
            });
            const decodedHash = normalizeHash(decoded?.args?.proposalHash);
            if (decodedHash) {
                return decodedHash;
            }
        } catch (error) {
            continue;
        }
    }

    return null;
}

function matchesReimbursementProposalSignal({ signal, intent, agentAddress, policy }) {
    if (signal?.kind !== 'proposal' || !Array.isArray(signal.transactions) || signal.transactions.length !== 1) {
        return false;
    }
    if (signal.proposer && !isAddressEqual(signal.proposer, agentAddress)) {
        return false;
    }
    if (intent.reimbursementExplanation) {
        if (typeof signal.explanation !== 'string') {
            return false;
        }
        return signal.explanation.trim() === intent.reimbursementExplanation;
    }

    const [transaction] = signal.transactions;
    if (!transaction?.to || !isAddressEqual(transaction.to, policy.collateralToken)) {
        return false;
    }
    if (BigInt(transaction.value ?? 0) !== 0n) {
        return false;
    }

    const decoded = decodeErc20TransferCallData(transaction.data);
    if (!decoded) {
        return false;
    }
    const recipient = intent.reimbursementRecipientAddress ?? agentAddress;
    return (
        Boolean(recipient) &&
        decoded.to === normalizeAddress(recipient) &&
        decoded.amount === BigInt(intent.reimbursementAmountWei ?? 0)
    );
}

function recoverProposalHashesFromSignals({ signals, agentAddress, policy }) {
    let changed = false;
    const normalizedAgentAddress = normalizeAddress(agentAddress);

    for (const intent of getOpenIntents()) {
        if (intent.reimbursementProposalHash) {
            continue;
        }
        if (!intent.reimbursementSubmissionTxHash && !intent.reimbursementExplanation) {
            continue;
        }

        const matchingSignal = (Array.isArray(signals) ? signals : []).find((signal) =>
            matchesReimbursementProposalSignal({
                signal,
                intent,
                agentAddress: normalizedAgentAddress,
                policy,
            })
        );
        const proposalHash = normalizeHash(matchingSignal?.proposalHash);
        if (!proposalHash) {
            continue;
        }

        intent.reimbursementProposalHash = proposalHash;
        delete intent.reimbursementDispatchAtMs;
        delete intent.reimbursementSubmittedAtMs;
        if (pendingProposalSubmission?.intentKey === intent.intentKey) {
            pendingProposalSubmission = null;
        }
        clearReimbursementSubmissionAmbiguity(intent);
        delete intent.lastReimbursementSubmissionStatus;
        delete intent.lastReimbursementSubmissionError;
        intent.updatedAtMs = Date.now();
        changed = true;
    }

    return changed;
}

function recoverProposalHashesFromBackfilledCommitments() {
    let changed = false;
    const nowMs = Date.now();

    for (const intent of getOpenIntents()) {
        if (!intent.reimbursementExplanation) {
            continue;
        }

        const matchingCommitments = Object.values(tradeIntentState.reimbursementCommitments).filter(
            (commitment) =>
                commitment?.proposalHash &&
                commitment?.intentKey &&
                commitment.intentKey === intent.intentKey
        );
        if (matchingCommitments.length === 0) {
            continue;
        }

        const currentProposalHash = normalizeHash(intent.reimbursementProposalHash);
        const executedProposalHashes = Array.from(
            new Set(
                matchingCommitments
                    .filter((commitment) => commitment?.status === 'executed')
                    .map((commitment) => normalizeHash(commitment?.proposalHash))
                    .filter(Boolean)
            )
        );
        const liveProposalHashes = Array.from(
            new Set(
                matchingCommitments
                    .filter(
                        (commitment) =>
                            commitment?.status !== 'deleted' && commitment?.status !== 'executed'
                    )
                    .map((commitment) => normalizeHash(commitment?.proposalHash))
                    .filter(Boolean)
            )
        );
        const deletedProposalHashes = new Set(
            matchingCommitments
                .filter((commitment) => commitment?.status === 'deleted')
                .map((commitment) => normalizeHash(commitment?.proposalHash))
                .filter(Boolean)
        );

        const resolvedExecutedProposalHash =
            (currentProposalHash && executedProposalHashes.includes(currentProposalHash)
                ? currentProposalHash
                : null) ??
            (executedProposalHashes.length === 1 ? executedProposalHashes[0] : null);
        if (resolvedExecutedProposalHash) {
            intent.reimbursementProposalHash = resolvedExecutedProposalHash;
            intent.reimbursedAtMs = nowMs;
            clearReimbursementSubmissionTracking(intent);
            clearReimbursementSubmissionAmbiguity(intent);
            delete intent.lastReimbursementSubmissionStatus;
            delete intent.lastReimbursementSubmissionError;
            if (pendingProposalSubmission?.intentKey === intent.intentKey) {
                pendingProposalSubmission = null;
            }
            intent.updatedAtMs = nowMs;
            changed = true;
            continue;
        }

        const resolvedLiveProposalHash =
            (currentProposalHash && liveProposalHashes.includes(currentProposalHash)
                ? currentProposalHash
                : null) ??
            (liveProposalHashes.length === 1 ? liveProposalHashes[0] : null);
        if (resolvedLiveProposalHash) {
            intent.reimbursementProposalHash = resolvedLiveProposalHash;
            delete intent.reimbursementDispatchAtMs;
            delete intent.reimbursementSubmittedAtMs;
            if (pendingProposalSubmission?.intentKey === intent.intentKey) {
                pendingProposalSubmission = null;
            }
            clearReimbursementSubmissionAmbiguity(intent);
            delete intent.lastReimbursementSubmissionStatus;
            delete intent.lastReimbursementSubmissionError;
            intent.updatedAtMs = nowMs;
            changed = true;
            continue;
        }

        const deletedCurrentProposal =
            currentProposalHash !== null && deletedProposalHashes.has(currentProposalHash);
        const deletedOnlyBackfill =
            liveProposalHashes.length === 0 &&
            executedProposalHashes.length === 0 &&
            deletedProposalHashes.size > 0;
        if (!deletedCurrentProposal && !deletedOnlyBackfill) {
            continue;
        }

        clearReimbursementSubmissionTracking(intent);
        delete intent.reimbursementProposalHash;
        delete intent.nextReimbursementAttemptAtMs;
        if (pendingProposalSubmission?.intentKey === intent.intentKey) {
            pendingProposalSubmission = null;
        }
        delete intent.lastReimbursementSubmissionStatus;
        delete intent.lastReimbursementSubmissionError;
        intent.updatedAtMs = nowMs;
        changed = true;
    }

    return changed;
}

function markTerminalIntentFailure(
    intent,
    { stage, status, detail, releaseCredit = false, sideEffectsLikelyCommitted = false } = {}
) {
    const nowMs = Date.now();
    delete intent.orderDispatchAtMs;
    delete intent.depositDispatchAtMs;
    delete intent.reimbursementDispatchAtMs;
    intent.terminalFailureStage = stage ?? 'unknown';
    intent.terminalFailureStatus = status ?? 'unknown';
    intent.terminalFailureMessage = detail ?? null;
    intent.terminalFailureSideEffectsLikelyCommitted = sideEffectsLikelyCommitted === true;
    intent.terminalFailedAtMs = nowMs;
    intent.closedAtMs = nowMs;
    if (releaseCredit) {
        intent.creditReleasedAtMs = nowMs;
    }
    intent.updatedAtMs = nowMs;
}

function expireUnsubmittedIntents(nowMs = Date.now()) {
    let changed = false;
    for (const intent of getOpenIntents()) {
        if (intent.orderId || intent.tokenDeposited || intent.orderSubmittedAtMs) {
            continue;
        }
        if (!Number.isInteger(intent.expiryMs) || nowMs <= intent.expiryMs) {
            continue;
        }
        markTerminalIntentFailure(intent, {
            stage: 'expiry',
            status: 'expired',
            detail: 'Intent expired before execution.',
            releaseCredit: true,
        });
        changed = true;
    }
    return changed;
}

async function refreshTrackedTxSubmissionStatus({
    publicClient,
    kind,
    pendingTxTimeoutMs,
    fields,
    isComplete,
    onMissingTxTimeout,
    onConfirmedReceipt,
    onRevertedReceipt,
    onReceiptUnavailableAfterTimeout,
}) {
    let changed = false;
    const nowMs = Date.now();

    for (const intent of getOpenIntents()) {
        if (isComplete(intent)) {
            continue;
        }

        const txHash = intent[fields.txHash];
        if (!txHash) {
            if (!hasTimedOut(intent[fields.submittedAt], pendingTxTimeoutMs, nowMs)) {
                continue;
            }
            if (intent[fields.ambiguous]) {
                changed = noteStageTimeoutAmbiguity(intent, kind, nowMs) || changed;
                continue;
            }
            changed = (await onMissingTxTimeout(intent, { nowMs })) || changed;
            continue;
        }

        try {
            const receipt = await publicClient.getTransactionReceipt({
                hash: txHash,
            });
            const status = receipt?.status;
            const reverted = status === 0n || status === 0 || status === 'reverted';
            if (reverted) {
                changed = (await onRevertedReceipt(intent, { nowMs, receipt })) || changed;
                continue;
            }
            changed = (await onConfirmedReceipt(intent, { nowMs, receipt })) || changed;
        } catch (error) {
            if (!isReceiptUnavailableError(error)) {
                continue;
            }
            if (!hasTimedOut(intent[fields.submittedAt], pendingTxTimeoutMs, nowMs)) {
                continue;
            }
            changed =
                (await onReceiptUnavailableAfterTimeout(intent, {
                    nowMs,
                    error,
                })) || changed;
        }
    }

    return changed;
}

async function refreshDepositSubmissionStatus({ publicClient, latestBlock, policy }) {
    return refreshTrackedTxSubmissionStatus({
        publicClient,
        kind: 'deposit',
        pendingTxTimeoutMs: policy.pendingTxTimeoutMs,
        fields: getLifecycleStageFields('deposit'),
        isComplete: (intent) => intent.tokenDeposited,
        onMissingTxTimeout: (intent, { nowMs }) =>
            reduceDepositSubmissionMissingTxTimeout(intent, { nowMs }),
        onConfirmedReceipt: (intent, { nowMs, receipt }) =>
            reduceDepositSubmissionConfirmedReceipt(intent, {
                nowMs,
                receipt,
                latestBlock,
            }),
        onRevertedReceipt: (intent, { nowMs }) =>
            reduceDepositSubmissionRevertedReceipt(intent, { nowMs }),
        onReceiptUnavailableAfterTimeout: (intent, { nowMs, error }) => {
            const detail = error?.message ?? String(error);
            return reduceDepositSubmissionReceiptTimeout(intent, { detail, nowMs });
        },
    });
}

async function refreshProposalSubmissionStatus({ publicClient, policy }) {
    return refreshTrackedTxSubmissionStatus({
        publicClient,
        kind: 'reimbursement',
        pendingTxTimeoutMs: policy.pendingTxTimeoutMs,
        fields: getLifecycleStageFields('reimbursement'),
        isComplete: (intent) => Boolean(intent.reimbursementProposalHash),
        onMissingTxTimeout: (intent, { nowMs }) =>
            reduceReimbursementSubmissionMissingTxTimeout(intent, { nowMs }),
        onConfirmedReceipt: (intent, { nowMs, receipt }) => {
            const result = reduceReimbursementSubmissionConfirmedReceipt(intent, {
                nowMs,
                receipt,
                ogModule: policy.ogModule,
                extractProposalHashFromReceipt,
            });
            if (result.recoveredProposalHash && pendingProposalSubmission?.intentKey === intent.intentKey) {
                pendingProposalSubmission = null;
            }
            return result.changed;
        },
        onRevertedReceipt: (intent, { nowMs }) => {
            const changed = reduceReimbursementSubmissionRevertedReceipt(intent, { nowMs });
            if (pendingProposalSubmission?.intentKey === intent.intentKey) {
                pendingProposalSubmission = null;
            }
            return changed;
        },
        onReceiptUnavailableAfterTimeout: (intent, { nowMs, error }) => {
            const detail = error?.message ?? String(error);
            return reduceReimbursementSubmissionReceiptTimeout(intent, { detail, nowMs });
        },
    });
}

function applyProposalEventUpdate({ executedProposals = [], deletedProposals = [] }) {
    const executedHashes = new Set([
        ...normalizeHashArray(tradeIntentState.pendingExecutedProposalHashes),
        ...normalizeHashArray(executedProposals),
    ]);
    const deletedHashes = new Set([
        ...normalizeHashArray(tradeIntentState.pendingDeletedProposalHashes),
        ...normalizeHashArray(deletedProposals),
    ]);
    let changed = setPendingProposalLifecycleHashes({
        executed: Array.from(executedHashes),
        deleted: Array.from(deletedHashes),
    });
    const nowMs = Date.now();

    for (const intent of getTrackedIntents()) {
        const proposalHash = normalizeHash(intent?.reimbursementProposalHash);
        if (!proposalHash) {
            continue;
        }

        if (executedHashes.has(proposalHash)) {
            intent.reimbursedAtMs = nowMs;
            clearReimbursementSubmissionTracking(intent);
            intent.updatedAtMs = nowMs;
            clearReimbursementSubmissionAmbiguity(intent);
            delete intent.lastReimbursementSubmissionStatus;
            delete intent.lastReimbursementSubmissionError;
            if (pendingProposalSubmission?.intentKey === intent.intentKey) {
                pendingProposalSubmission = null;
            }
            executedHashes.delete(proposalHash);
            changed = true;
            continue;
        }

        if (deletedHashes.has(proposalHash)) {
            clearReimbursementSubmissionTracking(intent);
            delete intent.reimbursementProposalHash;
            intent.updatedAtMs = nowMs;
            if (pendingProposalSubmission?.intentKey === intent.intentKey) {
                pendingProposalSubmission = null;
            }
            deletedHashes.delete(proposalHash);
            changed = true;
        }
    }

    changed =
        setPendingProposalLifecycleHashes({
            executed: Array.from(executedHashes),
            deleted: Array.from(deletedHashes),
        }) || changed;

    return changed;
}

function buildArchiveToolCall(intent, commitmentSafe, agentAddress) {
    return {
        callId: `archive-signed-trade-intent-${intent.sequence}`,
        name: 'ipfs_publish',
        arguments: JSON.stringify({
            json: buildSignedTradeIntentArchiveArtifact({
                record: intent,
                commitmentSafe,
                agentAddress,
            }),
            filename: intent.archiveFilename,
            pin: true,
        }),
    };
}

function resolveClobOrderSignatureType(config) {
    const configuredSignatureType = normalizeNonEmptyString(config?.polymarketClobSignatureType);
    if (configuredSignatureType) {
        return configuredSignatureType;
    }
    if (!config?.polymarketRelayerEnabled) {
        return null;
    }

    const relayerTxType = normalizeNonEmptyString(config?.polymarketRelayerTxType)?.toUpperCase();
    return relayerTxType === 'PROXY' ? 'POLY_PROXY' : 'POLY_GNOSIS_SAFE';
}

function buildOrderToolCall(intent, chainId, config) {
    const feeRateBps = parseOptionalNonNegativeIntegerString(intent.feeRateBps);
    if (!feeRateBps) {
        throw new Error(
            `Missing feeRateBps for signed Polymarket trade intent ${intent.intentKey}.`
        );
    }
    const signatureType = resolveClobOrderSignatureType(config);

    return {
        callId: `place-polymarket-order-${intent.sequence}`,
        name: 'polymarket_clob_build_sign_and_place_order',
        arguments: JSON.stringify({
            side: 'BUY',
            tokenId: intent.tokenId,
            orderType: 'FOK',
            makerAmount: intent.orderMakerAmount,
            takerAmount: intent.orderTakerAmount,
            feeRateBps,
            expiration: String(Math.floor(intent.expiryMs / 1000)),
            chainId,
            ...(signatureType ? { signatureType } : {}),
        }),
    };
}

function buildDepositToolCall(intent, policy, amount) {
    return {
        callId: `deposit-polymarket-outcome-${intent.sequence}`,
        name: 'make_erc1155_deposit',
        arguments: JSON.stringify({
            token: policy.ctfContract,
            tokenId: intent.tokenId,
            amount,
            data: '0x',
        }),
    };
}

function buildReimbursementToolCall(intent, policy, config) {
    const transactions = buildOgTransactions(
        [
            {
                kind: 'erc20_transfer',
                token: policy.collateralToken,
                to: intent.reimbursementRecipientAddress,
                amountWei: intent.reimbursementAmountWei,
            },
        ],
        { config }
    );
    const explanation = buildReimbursementExplanation(intent);
    return {
        callId: `reimburse-polymarket-intent-${intent.sequence}`,
        name: 'post_bond_and_propose',
        arguments: JSON.stringify({
            transactions,
            explanation,
        }),
        explanation,
    };
}

function getSystemPrompt({ commitmentText }) {
    return [
        'You are a Polymarket signed-intent trading agent for an onchain commitment.',
        'Focus on signals where kind is "userMessage".',
        'Treat userMessage as an authenticated trade intent candidate only when sender.authType is "eip191".',
        'Use the signed human-readable message text as the primary source of trading intent. Do not treat args as authoritative execution instructions.',
        'Parse signed free-text messages into candidate BUY intents for the configured market only.',
        'Archive accepted signed trade intents before later execution or reimbursement steps when IPFS is enabled.',
        'Only reimburse the trading wallet that funded the trade, and only after fill confirmation, token deposit, and proposal submission checks pass.',
        'Prefer ignore or clarify when the message is unsigned, malformed, expired, duplicated, ambiguous, or missing trade bounds.',
        'Do not invent markets, prices, balances, or signer authority.',
        'Return strict JSON with keys: action, rationale, intentStatus, recommendedNextStep.',
        'Allowed action values: acknowledge_signed_intent, clarify, ignore.',
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

const getPollingOptions = getAlwaysEmitBalanceSnapshotPollingOptions;

async function enrichSignals(
    signals,
    {
        config,
        account,
        nowMs,
    } = {}
) {
    await hydrateTradeIntentState();
    const policy = await resolveEffectivePolicy(config);
    const effectiveNowMs = parseOptionalPositiveInteger(nowMs) ?? Date.now();
    const commitmentSafe = config?.commitmentSafe ?? null;
    const agentAddress = account?.address ?? null;
    const out = Array.isArray(signals) ? [...signals] : [];
    const emitted = new Set();

    for (const intent of getTrackedIntents()) {
        out.push(buildIntentSignal(intent, effectiveNowMs));
        out.push(buildArchiveSignal(intent, commitmentSafe, agentAddress));
        emitted.add(intent.intentKey);
    }

    for (const signal of Array.isArray(signals) ? signals : []) {
        const interpreted = interpretSignedTradeIntentSignal(signal, {
            policy,
            commitmentSafe,
            agentAddress,
            nowMs: effectiveNowMs,
        });
        if (!interpreted.ok || emitted.has(interpreted.intent.intentKey)) {
            continue;
        }
        out.push(buildIntentSignal(interpreted.intent, effectiveNowMs));
        out.push(buildArchiveSignal(interpreted.intent, commitmentSafe, agentAddress));
    }

    out.push({
        kind: 'polymarketTradeIntentState',
        policy,
        credits: buildCreditSnapshot(tradeIntentState),
    });

    return out;
}

async function getDeterministicToolCalls({
    signals,
    commitmentSafe,
    agentAddress,
    publicClient,
    config,
    onchainPendingProposal = false,
}) {
    await configureRuntimeStateContext({ publicClient, commitmentSafe, config });
    await hydrateTradeIntentState();

    const policy = await resolveEffectivePolicy(config);
    if (!policy.ready) {
        return [];
    }

    const normalizedAgentAddress = normalizeAddress(agentAddress);
    if (policy.authorizedAgent && normalizedAgentAddress !== policy.authorizedAgent) {
        throw new Error(
            `polymarket-intent-trader may only be served by authorized agent ${policy.authorizedAgent}.`
        );
    }

    const latestBlock = await publicClient.getBlockNumber();
    const normalizedCommitmentSafe = normalizeAddress(commitmentSafe);
    clearStalePendingOrderSubmission();
    clearStalePendingDepositSubmission();
    clearStalePendingProposalSubmission();
    let changed = reconcileDurableDispatchState();

    while (queuedProposalEventUpdates.length > 0) {
        changed = applyProposalEventUpdate(queuedProposalEventUpdates.shift()) || changed;
    }

    changed =
        (await maybeBackfillDeposits({
            publicClient,
            commitmentSafe: normalizedCommitmentSafe,
            latestBlock,
            policy,
            config,
        })) || changed;
    changed =
        (await maybeBackfillReimbursementCommitments({
            publicClient,
            latestBlock,
            policy,
            config,
        })) || changed;
    changed = recoverProposalHashesFromBackfilledCommitments() || changed;
    changed = ingestSignals(signals, policy) || changed;

    const clobAuthAddress = getClobAuthAddress({
        config,
        accountAddress: normalizedAgentAddress,
    });
    const { tokenHolderAddress, tokenHolderResolutionError } = await resolveTokenHolderAddress({
        publicClient,
        config,
        account: { address: normalizedAgentAddress },
    });
    let walletAlignmentError = null;
    if (config?.polymarketRelayerEnabled) {
        if (!clobAuthAddress) {
            walletAlignmentError = 'Unable to resolve CLOB auth address for relayer mode.';
        } else if (!tokenHolderAddress) {
            walletAlignmentError =
                tokenHolderResolutionError ?? 'Unable to resolve relayer token-holder address.';
        } else if (clobAuthAddress !== tokenHolderAddress) {
            walletAlignmentError =
                `POLYMARKET_CLOB_ADDRESS (${clobAuthAddress}) must match relayer proxy wallet (${tokenHolderAddress}) when POLYMARKET_RELAYER_ENABLED=true.`;
        }
    } else if (clobAuthAddress && tokenHolderAddress && clobAuthAddress !== tokenHolderAddress) {
        walletAlignmentError =
            `POLYMARKET_CLOB_ADDRESS (${clobAuthAddress}) must match runtime signer address (${tokenHolderAddress}) when POLYMARKET_RELAYER_ENABLED=false, because make_erc1155_deposit transfers from the runtime signer wallet.`;
    }
    if (walletAlignmentError) {
        throw new Error(walletAlignmentError);
    }

    changed = expireUnsubmittedIntents() || changed;
    changed =
        (await refreshOrderStatus({
            openIntents: getOpenIntents(),
            account: { address: normalizedAgentAddress },
            config,
            policy,
            hasTimedOut,
            markTerminalIntentFailure,
            observeFilledTokenInventoryDelta: ({ intent }) =>
                observeFilledTokenInventoryDelta({
                    publicClient,
                    policy,
                    tokenHolderAddress,
                    intent,
                }),
        })) || changed;
    changed =
        (await reconcileRecoveredDepositSubmissions({
            signals,
            publicClient,
            commitmentSafe: normalizedCommitmentSafe,
            latestBlock,
            policy,
        })) || changed;
    changed =
        (await refreshDepositSubmissionStatus({
            publicClient,
            latestBlock,
            policy,
        })) || changed;
    changed =
        (await refreshProposalSubmissionStatus({
            publicClient,
            policy,
        })) || changed;
    changed =
        recoverProposalHashesFromSignals({
            signals,
            agentAddress: normalizedAgentAddress,
            policy,
        }) || changed;
    changed = applyProposalEventUpdate({}) || changed;

    for (const signal of Array.isArray(signals) ? signals : []) {
        const interpreted = interpretSignedTradeIntentSignal(signal, {
            policy,
            commitmentSafe: normalizedCommitmentSafe,
            agentAddress: normalizedAgentAddress,
            nowMs: Date.now(),
        });
        if (!interpreted.ok) {
            continue;
        }

        if (tradeIntentState.intents[interpreted.intent.intentKey]) {
            continue;
        }

        const availableCreditWei = getAvailableCreditWeiForAddress(
            tradeIntentState,
            interpreted.intent.signer
        );
        if (availableCreditWei < BigInt(interpreted.intent.reservedCreditAmountWei)) {
            console.warn(
                `[agent] Ignoring signed Polymarket trade intent ${interpreted.intent.intentKey}: insufficient deposited collateral credit for signer ${interpreted.intent.signer} (availableWei=${availableCreditWei.toString()} requiredWei=${interpreted.intent.reservedCreditAmountWei}).`
            );
            continue;
        }
        if (!config?.ipfsEnabled) {
            throw new Error(
                'polymarket-intent-trader requires ipfsEnabled=true in module config to archive signed trade intents before execution.'
            );
        }

        tradeIntentState.intents[interpreted.intent.intentKey] = {
            ...interpreted.intent,
            sequence: allocateSequence(),
            creditReservedAtMs: Date.now(),
            updatedAtMs: Date.now(),
        };
        console.log(
            `[agent] Accepted signed Polymarket trade intent ${interpreted.intent.intentKey}: outcome=${interpreted.intent.outcome} maxSpendWei=${interpreted.intent.maxSpendWei} maxPrice=${interpreted.intent.maxPrice}.`
        );
        changed = true;
    }

    if (changed) {
        await maybePersistTradeIntentState();
    }

    const openIntents = getOpenIntents();

    const actionCandidates = planNextActionCandidates({
        openIntents,
        pendingOrderSubmission,
        pendingDepositSubmission,
        onchainPendingProposal,
        nowMs: Date.now(),
    });
    let chainId;

    for (const action of actionCandidates) {
        const intent = tradeIntentState.intents[action.intentKey];
        if (!intent) {
            continue;
        }

        if (action.kind === 'deposit') {
            const filledShareAmount = parseOptionalNonNegativeIntegerString(intent.filledShareAmount);
            if (!filledShareAmount || BigInt(filledShareAmount) <= 0n || !tokenHolderAddress) {
                continue;
            }
            const tokenBalance = await readOutcomeTokenBalance({
                publicClient,
                policy,
                tokenHolderAddress,
                tokenId: intent.tokenId,
            });
            if (tokenBalance === null || tokenBalance < BigInt(filledShareAmount)) {
                continue;
            }

            markStageDispatchStarted(intent, 'deposit');
            intent.depositSourceAddress = tokenHolderAddress;
            intent.depositExpectedAmount = filledShareAmount;
            intent.depositDispatchBlockNumber = latestBlock.toString();
            intent.updatedAtMs = Date.now();
            await maybePersistTradeIntentState();
            pendingDepositSubmission = {
                intentKey: intent.intentKey,
                startedAtMs: Date.now(),
            };
            return [buildDepositToolCall(intent, policy, filledShareAmount)];
        }

        if (action.kind === 'reimbursement') {
            const reimbursementRecipientAddress = clobAuthAddress ?? normalizedAgentAddress;
            if (!reimbursementRecipientAddress) {
                throw new Error('Unable to resolve reimbursement recipient address.');
            }
            const reimbursementAmountWei = BigInt(intent.reimbursementAmountWei ?? 0);
            const reimbursementHeadroomWei = getReimbursementHeadroomWei(intent);
            if (reimbursementAmountWei <= 0n || reimbursementHeadroomWei < reimbursementAmountWei) {
                const detail =
                    `Insufficient committed collateral credit remains for reimbursement (headroomWei=${reimbursementHeadroomWei.toString()} requiredWei=${reimbursementAmountWei.toString()}).`;
                if (
                    intent.lastReimbursementCreditError !== detail ||
                    !Number.isInteger(intent.reimbursementCreditBlockedAtMs)
                ) {
                    intent.lastReimbursementCreditError = detail;
                    intent.reimbursementCreditBlockedAtMs = Date.now();
                    intent.updatedAtMs = Date.now();
                    await maybePersistTradeIntentState();
                }
                continue;
            }
            intent.reimbursementRecipientAddress = reimbursementRecipientAddress;
            intent.reimbursementExplanation = buildReimbursementExplanation(intent);
            delete intent.lastReimbursementCreditError;
            delete intent.reimbursementCreditBlockedAtMs;
            delete intent.nextReimbursementAttemptAtMs;
            markStageDispatchStarted(intent, 'reimbursement');
            await maybePersistTradeIntentState();

            pendingProposalSubmission = {
                intentKey: intent.intentKey,
                startedAtMs: Date.now(),
                explanation: intent.reimbursementExplanation,
            };
            const reimbursementCall = buildReimbursementToolCall(intent, policy, config);
            return [
                {
                    callId: reimbursementCall.callId,
                    name: reimbursementCall.name,
                    arguments: reimbursementCall.arguments,
                },
            ];
        }

        if (action.kind === 'archive') {
            intent.lastArchiveAttemptAtMs = Date.now();
            intent.nextArchiveAttemptAtMs = Date.now() + policy.archiveRetryDelayMs;
            intent.updatedAtMs = Date.now();
            await maybePersistTradeIntentState();
            pendingArtifactPublish = {
                intentKey: intent.intentKey,
            };
            console.log(`[agent] Preparing signed trade intent archive for ${intent.intentKey}.`);
            return [buildArchiveToolCall(intent, normalizedCommitmentSafe, normalizedAgentAddress)];
        }

        if (action.kind !== 'order') {
            continue;
        }

        const clobExecutionPreflightError = getClobExecutionPreflightError(config);
        if (clobExecutionPreflightError) {
            intent.lastOrderSubmissionStatus = 'unavailable';
            intent.lastOrderSubmissionError = clobExecutionPreflightError;
            intent.nextOrderAttemptAtMs = Date.now() + policy.archiveRetryDelayMs;
            intent.updatedAtMs = Date.now();
            await maybePersistTradeIntentState();
            continue;
        }

        const feeRateBps = await fetchClobFeeRateBps({
            config,
            tokenId: intent.tokenId,
        });
        let preOrderTokenBalance = null;
        if (tokenHolderAddress) {
            try {
                preOrderTokenBalance = await readOutcomeTokenBalance({
                    publicClient,
                    policy,
                    tokenHolderAddress,
                    tokenId: intent.tokenId,
                });
            } catch (error) {
                preOrderTokenBalance = null;
            }
        }
        if (chainId === undefined) {
            chainId =
                typeof publicClient?.getChainId === 'function'
                    ? await publicClient.getChainId()
                    : undefined;
        }
        intent.feeRateBps = feeRateBps;
        intent.feeRateFetchedAtMs = Date.now();
        intent.tradingWalletAddress = clobAuthAddress ?? normalizedAgentAddress;
        intent.preOrderTokenHolderAddress = tokenHolderAddress ?? null;
        intent.preOrderTokenBalance =
            preOrderTokenBalance === null ? null : preOrderTokenBalance.toString();
        intent.reimbursementRecipientAddress = clobAuthAddress ?? normalizedAgentAddress;
        markStageDispatchStarted(intent, 'order');
        await maybePersistTradeIntentState();
        pendingOrderSubmission = {
            intentKey: intent.intentKey,
            startedAtMs: Date.now(),
        };
        console.log(`[agent] Preparing Polymarket BUY order for ${intent.intentKey}.`);
        return [buildOrderToolCall(intent, chainId, config)];
    }

    return [];
}

function takePendingSubmission(kind) {
    if (kind === 'order') {
        const pending = pendingOrderSubmission;
        pendingOrderSubmission = null;
        return pending;
    }
    if (kind === 'deposit') {
        const pending = pendingDepositSubmission;
        pendingDepositSubmission = null;
        return pending;
    }
    if (kind === 'reimbursement') {
        const pending = pendingProposalSubmission;
        pendingProposalSubmission = null;
        return pending;
    }
    throw new Error(`Unsupported pending submission kind: ${kind}`);
}

function takePendingIntent(kind) {
    const pending = takePendingSubmission(kind);
    if (!pending?.intentKey) {
        return { pending: null, intent: null };
    }
    return {
        pending,
        intent: tradeIntentState.intents[pending.intentKey] ?? null,
    };
}

async function handleArchiveToolOutput({ parsedOutput, policy }) {
    const pending = pendingArtifactPublish;
    pendingArtifactPublish = null;
    if (!pending?.intentKey) {
        return;
    }

    const intent = tradeIntentState.intents[pending.intentKey];
    if (!intent) {
        return;
    }

    const result = reduceArchiveToolOutput(intent, parsedOutput, {
        retryDelayMs: policy.archiveRetryDelayMs,
        markTerminalIntentFailure,
    });
    if (result.published) {
        console.log(
            `[agent] Signed trade intent archive published for ${pending.intentKey}: uri=${intent.artifactUri ?? 'missing'}.`
        );
    }
    await maybePersistTradeIntentState();
}

async function handleOrderToolOutput({ parsedOutput, policy }) {
    const { intent } = takePendingIntent('order');
    if (!intent) {
        return;
    }
    reduceOrderToolOutput(intent, parsedOutput, {
        retryDelayMs: policy.archiveRetryDelayMs,
        extractOrderIdFromSubmission,
        extractOrderStatusFromSubmission,
        markTerminalIntentFailure,
    });
    await maybePersistTradeIntentState();
}

async function handleDepositToolOutput({ parsedOutput, policy }) {
    const { intent } = takePendingIntent('deposit');
    if (!intent) {
        return;
    }
    reduceDepositToolOutput(intent, parsedOutput, {
        retryDelayMs: policy.archiveRetryDelayMs,
        normalizeHash,
        markTerminalIntentFailure,
    });
    await maybePersistTradeIntentState();
}

async function handleReimbursementToolOutput({ parsedOutput, policy }) {
    const { pending, intent } = takePendingIntent('reimbursement');
    if (!intent) {
        return;
    }
    reduceReimbursementToolOutput(intent, parsedOutput, {
        retryDelayMs: policy.archiveRetryDelayMs,
        pendingExplanation: pending?.explanation,
        normalizeHash,
        resolveOgProposalHashFromToolOutput,
        markTerminalIntentFailure,
    });
    await maybePersistTradeIntentState();
}

async function onToolOutput({ name, parsedOutput, config }) {
    await hydrateTradeIntentState();
    const policy = resolvePolicy(config);

    if (name === 'ipfs_publish') {
        await handleArchiveToolOutput({ parsedOutput, policy });
        return;
    }
    if (name === 'polymarket_clob_build_sign_and_place_order') {
        await handleOrderToolOutput({ parsedOutput, policy });
        return;
    }
    if (name === 'make_erc1155_deposit') {
        await handleDepositToolOutput({ parsedOutput, policy });
        return;
    }
    if (name === 'post_bond_and_propose' || name === 'auto_post_bond_and_propose') {
        await handleReimbursementToolOutput({ parsedOutput, policy });
    }
}

function onProposalEvents({
    executedProposals = [],
    deletedProposals = [],
}) {
    queuedProposalEventUpdates.push({
        executedProposals,
        deletedProposals,
    });
}

export {
    buildSignedTradeIntentArchiveArtifact,
    computeBuyOrderAmounts,
    createDepositRecord,
    enrichSignals,
    getDeterministicToolCalls,
    getPollingOptions,
    getSystemPrompt,
    getTradeIntentState,
    interpretSignedTradeIntentSignal,
    onProposalEvents,
    onToolOutput,
    resetTradeIntentState,
    setTradeIntentStatePathForTest,
};
