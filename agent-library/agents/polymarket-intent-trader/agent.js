import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEventLog, erc1155Abi, getAddress, hexToString, isAddressEqual, parseUnits } from 'viem';
import { findContractDeploymentBlock, getLogsChunked } from '../../../agent/src/lib/chain-history.js';
import { buildSignedMessagePayload } from '../../../agent/src/lib/message-signing.js';
import {
    proposalDeletedEvent,
    proposalExecutedEvent,
    transactionsProposedEvent,
    transferEvent,
} from '../../../agent/src/lib/og.js';
import { getAlwaysEmitBalanceSnapshotPollingOptions } from '../../../agent/src/lib/polling.js';
import {
    CLOB_FAILURE_TERMINAL_STATUS,
    CLOB_ORDER_FAILURE_STATUSES,
    CLOB_ORDER_FILLED_STATUSES,
    CLOB_SUCCESS_TERMINAL_STATUS,
    DEFAULT_COLLATERAL_TOKEN,
    getClobOrder,
    getClobTrades,
} from '../../../agent/src/lib/polymarket.js';
import { resolveRelayerProxyWallet } from '../../../agent/src/lib/polymarket-relayer.js';
import { buildOgTransactions } from '../../../agent/src/lib/tx.js';
import {
    decodeErc20TransferCallData,
    normalizeAddressOrNull,
    normalizeHashOrNull,
    normalizeTokenId,
    parseFiniteNumber,
} from '../../../agent/src/lib/utils.js';
import {
    buildCreditSnapshot,
    createDepositRecord,
    createReimbursementCommitmentRecord,
    getAvailableCreditWeiForAddress,
    getDepositedCreditWeiForAddress,
    getReservedCreditWeiForAddress,
} from './credit-ledger.js';
import { planNextActionCandidates } from './planner.js';

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
const DEFAULT_CLOB_HOST = 'https://clob.polymarket.com';
const DEFAULT_CLOB_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SIGNED_COMMANDS = [
    'buy',
    'trade',
    'intent',
    'polymarket_buy',
    'polymarket_trade',
    'polymarket_intent',
];

const tradeIntentState = {
    nextSequence: 1,
    intents: {},
    deposits: {},
    reimbursementCommitments: {},
    pendingExecutedProposalHashes: [],
    pendingDeletedProposalHashes: [],
    backfilledDepositsThroughBlock: null,
    backfilledReimbursementCommitmentsThroughBlock: null,
};

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

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function markStateDirty() {
    // State writes are infrequent and the runtime is single-threaded enough for direct writes.
}

function resetInMemoryState({ hydrated = false, preserveQueuedProposalEventUpdates = false } = {}) {
    tradeIntentState.nextSequence = 1;
    tradeIntentState.intents = {};
    tradeIntentState.deposits = {};
    tradeIntentState.reimbursementCommitments = {};
    tradeIntentState.pendingExecutedProposalHashes = [];
    tradeIntentState.pendingDeletedProposalHashes = [];
    tradeIntentState.backfilledDepositsThroughBlock = null;
    tradeIntentState.backfilledReimbursementCommitmentsThroughBlock = null;
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

function parseOptionalShareAmountString(value) {
    const normalized = normalizeDecimalText(value);
    if (!normalized) {
        return null;
    }

    try {
        const parsed = parseUnits(normalized, SHARE_DECIMALS);
        if (parsed < 0n) {
            return null;
        }
        return parsed.toString();
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

function normalizeOrderId(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function normalizeClobStatus(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    return normalized.length > 0 ? normalized : null;
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

function markDispatchStarted(intent, kind, nowMs = Date.now()) {
    if (!intent) {
        return;
    }
    if (kind === 'order') {
        intent.orderDispatchAtMs = nowMs;
    } else if (kind === 'deposit') {
        intent.depositDispatchAtMs = nowMs;
    } else if (kind === 'reimbursement') {
        intent.reimbursementDispatchAtMs = nowMs;
    } else {
        throw new Error(`Unsupported dispatch kind: ${kind}`);
    }
    intent.updatedAtMs = nowMs;
}

function clearDispatchStarted(intent, kind) {
    if (!intent) {
        return;
    }
    if (kind === 'order') {
        delete intent.orderDispatchAtMs;
        return;
    }
    if (kind === 'deposit') {
        delete intent.depositDispatchAtMs;
        return;
    }
    if (kind === 'reimbursement') {
        delete intent.reimbursementDispatchAtMs;
        return;
    }
    throw new Error(`Unsupported dispatch kind: ${kind}`);
}

function reconcileDurableDispatchState(nowMs = Date.now()) {
    let changed = false;

    for (const intent of getOpenIntents()) {
        if (
            Number.isInteger(intent.orderDispatchAtMs) &&
            !intent.orderId &&
            !intent.orderSubmittedAtMs &&
            hasTimedOut(intent.orderDispatchAtMs, PENDING_ORDER_DISPATCH_GRACE_MS, nowMs)
        ) {
            intent.orderSubmittedAtMs = intent.orderDispatchAtMs;
            intent.lastOrderSubmissionStatus = intent.lastOrderSubmissionStatus ?? 'dispatch_pending';
            intent.lastOrderSubmissionError =
                intent.lastOrderSubmissionError ??
                'Polymarket order tool output was lost after dispatch; treating submission as ambiguous and refusing automatic retry.';
            delete intent.nextOrderAttemptAtMs;
            delete intent.orderDispatchAtMs;
            intent.updatedAtMs = nowMs;
            changed = true;
        }

        if (
            Number.isInteger(intent.depositDispatchAtMs) &&
            !intent.depositTxHash &&
            !intent.depositSubmittedAtMs &&
            hasTimedOut(intent.depositDispatchAtMs, PENDING_DEPOSIT_DISPATCH_GRACE_MS, nowMs)
        ) {
            intent.depositSubmittedAtMs = intent.depositDispatchAtMs;
            delete intent.nextDepositAttemptAtMs;
            delete intent.depositDispatchAtMs;
            markAmbiguousDepositSubmission(
                intent,
                'ERC1155 deposit tool output was lost after dispatch; treating submission as ambiguous and refusing automatic retry.',
                nowMs
            );
            changed = true;
        }

        if (
            Number.isInteger(intent.reimbursementDispatchAtMs) &&
            !intent.reimbursementProposalHash &&
            !intent.reimbursementSubmissionTxHash &&
            !intent.reimbursementSubmittedAtMs &&
            hasTimedOut(intent.reimbursementDispatchAtMs, PENDING_PROPOSAL_DISPATCH_GRACE_MS, nowMs)
        ) {
            intent.reimbursementSubmittedAtMs = intent.reimbursementDispatchAtMs;
            intent.lastReimbursementSubmissionStatus =
                intent.lastReimbursementSubmissionStatus ?? 'dispatch_pending';
            delete intent.reimbursementDispatchAtMs;
            markAmbiguousReimbursementSubmission(
                intent,
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

const DEPOSIT_SUBMISSION_FIELDS = Object.freeze({
    submittedAt: 'depositSubmittedAtMs',
    txHash: 'depositTxHash',
    dispatchAt: 'depositDispatchAtMs',
    ambiguous: 'depositSubmissionAmbiguous',
    ambiguousAt: 'depositSubmissionAmbiguousAtMs',
    ambiguityDetail: 'lastDepositReceiptError',
    clearAmbiguityDetail: true,
});

const REIMBURSEMENT_SUBMISSION_FIELDS = Object.freeze({
    submittedAt: 'reimbursementSubmittedAtMs',
    txHash: 'reimbursementSubmissionTxHash',
    dispatchAt: 'reimbursementDispatchAtMs',
    ambiguous: 'reimbursementSubmissionAmbiguous',
    ambiguousAt: 'reimbursementSubmissionAmbiguousAtMs',
    ambiguityDetail: 'lastReimbursementSubmissionError',
    clearAmbiguityDetail: false,
});

function clearTrackedSubmissionAmbiguity(intent, fields) {
    delete intent[fields.ambiguous];
    delete intent[fields.ambiguousAt];
    if (fields.clearAmbiguityDetail && fields.ambiguityDetail) {
        delete intent[fields.ambiguityDetail];
    }
}

function markTrackedSubmissionAmbiguity(intent, fields, detail, nowMs = Date.now()) {
    intent[fields.ambiguous] = true;
    if (!Number.isInteger(intent[fields.ambiguousAt])) {
        intent[fields.ambiguousAt] = nowMs;
    }
    if (fields.ambiguityDetail) {
        intent[fields.ambiguityDetail] = detail ?? null;
    }
    intent.updatedAtMs = nowMs;
}

function noteTrackedSubmissionTimeoutAmbiguity(intent, fields, nowMs = Date.now()) {
    if (Number.isInteger(intent[fields.ambiguousAt])) {
        return false;
    }
    intent[fields.ambiguousAt] = nowMs;
    intent.updatedAtMs = nowMs;
    return true;
}

function clearDepositSubmissionAmbiguity(intent) {
    clearTrackedSubmissionAmbiguity(intent, DEPOSIT_SUBMISSION_FIELDS);
}

function markAmbiguousDepositSubmission(intent, detail, nowMs = Date.now()) {
    markTrackedSubmissionAmbiguity(intent, DEPOSIT_SUBMISSION_FIELDS, detail, nowMs);
}

function clearReimbursementSubmissionAmbiguity(intent) {
    clearTrackedSubmissionAmbiguity(intent, REIMBURSEMENT_SUBMISSION_FIELDS);
}

function markAmbiguousReimbursementSubmission(intent, detail, nowMs = Date.now()) {
    markTrackedSubmissionAmbiguity(intent, REIMBURSEMENT_SUBMISSION_FIELDS, detail, nowMs);
}

function clearReimbursementSubmissionTracking(intent) {
    delete intent.reimbursementDispatchAtMs;
    delete intent.reimbursementSubmittedAtMs;
    delete intent.reimbursementSubmissionTxHash;
    clearReimbursementSubmissionAmbiguity(intent);
    delete intent.lastReimbursementSubmissionStatus;
    delete intent.lastReimbursementSubmissionError;
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
        const raw = await readFile(getStatePath(), 'utf8');
        const parsed = JSON.parse(raw);
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
    }
}

async function persistTradeIntentState() {
    await writeFile(
        getStatePath(),
        JSON.stringify(
            {
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
            },
            null,
            2
        ),
        'utf8'
    );
}

async function maybePersistTradeIntentState() {
    await persistTradeIntentState();
}

async function resetTradeIntentState() {
    resetInMemoryState({ hydrated: true });
    try {
        await unlink(getStatePath());
    } catch (error) {
        // Ignore missing state files during tests.
    }
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

function getClobAuthAddress({ config, accountAddress }) {
    return (
        normalizeAddressOrNull(config?.polymarketClobAddress) ??
        normalizeAddressOrNull(accountAddress)
    );
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

async function resolveInitialDepositBackfillStartBlock({
    publicClient,
    address,
    startBlock,
    latestBlock,
}) {
    if (startBlock !== undefined && startBlock !== null) {
        return BigInt(startBlock);
    }

    try {
        const discovered = await findContractDeploymentBlock({
            publicClient,
            address,
            latestBlock,
        });
        if (discovered !== null) {
            return discovered;
        }
    } catch (error) {
        console.warn(
            '[agent] Failed to auto-discover Safe deployment block for Polymarket deposit backfill; scanning from genesis.',
            error?.message ?? error
        );
    }

    return 0n;
}

async function maybeBackfillDeposits({
    publicClient,
    commitmentSafe,
    latestBlock,
    policy,
    config,
}) {
    const previousBackfilledThroughBlock =
        tradeIntentState.backfilledDepositsThroughBlock !== null
            ? BigInt(tradeIntentState.backfilledDepositsThroughBlock)
            : null;

    if (
        previousBackfilledThroughBlock !== null &&
        previousBackfilledThroughBlock >= latestBlock
    ) {
        if (!depositBackfillStatusLogged) {
            console.log(
                `[agent] polymarket-intent-trader credit backfill already complete through block ${tradeIntentState.backfilledDepositsThroughBlock}.`
            );
            depositBackfillStatusLogged = true;
        }
        return false;
    }

    const fromBlock =
        previousBackfilledThroughBlock !== null
            ? previousBackfilledThroughBlock + 1n
            : await resolveInitialDepositBackfillStartBlock({
                  publicClient,
                  address: commitmentSafe,
                  startBlock: config?.startBlock,
                  latestBlock,
              });

    const logs = await getLogsChunked({
        publicClient,
        address: policy.collateralToken,
        event: transferEvent,
        args: { to: commitmentSafe },
        fromBlock,
        toBlock: latestBlock,
        chunkSize: policy.logChunkSize,
    });

    let changed = false;
    for (const log of logs) {
        const deposit = createDepositRecord(
            {
                kind: 'erc20Deposit',
                asset: policy.collateralToken,
                from: log.args?.from,
                amount: log.args?.value,
                blockNumber: log.blockNumber,
                transactionHash: log.transactionHash,
                logIndex: log.logIndex,
                id: log.transactionHash
                    ? `${log.transactionHash}:${log.logIndex ?? '0'}`
                    : `${log.blockNumber?.toString?.() ?? '0'}:${log.logIndex ?? '0'}`,
            },
            {
                collateralToken: policy.collateralToken,
            }
        );
        if (!deposit || tradeIntentState.deposits[deposit.depositKey]) {
            continue;
        }
        tradeIntentState.deposits[deposit.depositKey] = deposit;
        changed = true;
    }

    const nextBackfilledThroughBlock = latestBlock.toString();
    const watermarkChanged =
        tradeIntentState.backfilledDepositsThroughBlock !== nextBackfilledThroughBlock;
    tradeIntentState.backfilledDepositsThroughBlock = nextBackfilledThroughBlock;
    depositBackfillStatusLogged = false;
    if (logs.length > 0 && previousBackfilledThroughBlock === null) {
        console.log(
            `[agent] Rebuilt ${logs.length} historical ERC20 deposit credit records for ${commitmentSafe}.`
        );
    } else if (logs.length > 0) {
        console.log(
            `[agent] Recovered ${logs.length} incremental ERC20 deposit credit records for ${commitmentSafe} through block ${latestBlock.toString()}.`
        );
    }
    markStateDirty();
    return changed || watermarkChanged;
}

function decodeOgExplanationText(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    if (!value.startsWith('0x')) {
        return value.trim();
    }
    try {
        return hexToString(value).trim() || null;
    } catch (error) {
        return null;
    }
}

function parseReimbursementExplanationFields(explanation) {
    const normalized = normalizeWhitespace(explanation);
    if (!normalized.startsWith('polymarket-intent-trader reimbursement')) {
        return null;
    }

    const fields = {};
    for (const segment of normalized.split('|').slice(1)) {
        const trimmed = segment.trim();
        if (!trimmed) {
            continue;
        }
        const separator = trimmed.indexOf('=');
        if (separator <= 0) {
            continue;
        }
        const key = trimmed.slice(0, separator).trim();
        const rawValue = trimmed.slice(separator + 1).trim();
        if (!key) {
            continue;
        }
        try {
            fields[key] = decodeURIComponent(rawValue);
        } catch (error) {
            fields[key] = rawValue;
        }
    }

    return fields;
}

function buildBackfilledReimbursementCommitmentRecord({
    proposalHash,
    proposer,
    transactions,
    explanation,
    policy,
}) {
    if (!policy.authorizedAgent || !proposer || !isAddressEqual(proposer, policy.authorizedAgent)) {
        return null;
    }
    const fields = parseReimbursementExplanationFields(explanation);
    if (!fields) {
        return null;
    }
    if (!Array.isArray(transactions) || transactions.length !== 1) {
        return null;
    }

    const [transaction] = transactions;
    if (!transaction?.to || !isAddressEqual(transaction.to, policy.collateralToken)) {
        return null;
    }

    const decoded = decodeErc20TransferCallData(transaction.data);
    if (!decoded || BigInt(decoded.amount ?? 0) <= 0n) {
        return null;
    }

    const explanationSpendWei = parseOptionalNonNegativeIntegerString(fields.spentWei);
    const amountWei = String(decoded.amount);
    if (explanationSpendWei && explanationSpendWei !== amountWei) {
        return null;
    }

    return createReimbursementCommitmentRecord(
        {
            signer: fields.signer,
            amountWei,
            proposalHash,
            intentKey: fields.intent ?? null,
            status: 'proposed',
        },
        {
            proposalHash,
        }
    );
}

function compareLogOrder(left, right) {
    const leftBlock = BigInt(left?.log?.blockNumber ?? 0n);
    const rightBlock = BigInt(right?.log?.blockNumber ?? 0n);
    if (leftBlock !== rightBlock) {
        return leftBlock < rightBlock ? -1 : 1;
    }
    const leftIndex = Number(left?.log?.logIndex ?? 0);
    const rightIndex = Number(right?.log?.logIndex ?? 0);
    return leftIndex - rightIndex;
}

async function maybeBackfillReimbursementCommitments({
    publicClient,
    latestBlock,
    policy,
    config,
}) {
    if (!policy.ogModule) {
        return false;
    }

    const previousBackfilledThroughBlock =
        tradeIntentState.backfilledReimbursementCommitmentsThroughBlock !== null
            ? BigInt(tradeIntentState.backfilledReimbursementCommitmentsThroughBlock)
            : null;

    if (
        previousBackfilledThroughBlock !== null &&
        previousBackfilledThroughBlock >= latestBlock
    ) {
        if (!reimbursementBackfillStatusLogged) {
            console.log(
                `[agent] polymarket-intent-trader reimbursement backfill already complete through block ${tradeIntentState.backfilledReimbursementCommitmentsThroughBlock}.`
            );
            reimbursementBackfillStatusLogged = true;
        }
        return false;
    }

    const fromBlock =
        previousBackfilledThroughBlock !== null
            ? previousBackfilledThroughBlock + 1n
            : await resolveInitialDepositBackfillStartBlock({
                  publicClient,
                  address: policy.ogModule,
                  startBlock: config?.startBlock,
                  latestBlock,
              });

    const [proposedLogs, executedLogs, deletedLogs] = await Promise.all([
        getLogsChunked({
            publicClient,
            address: policy.ogModule,
            event: transactionsProposedEvent,
            fromBlock,
            toBlock: latestBlock,
            chunkSize: policy.logChunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: policy.ogModule,
            event: proposalExecutedEvent,
            fromBlock,
            toBlock: latestBlock,
            chunkSize: policy.logChunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: policy.ogModule,
            event: proposalDeletedEvent,
            fromBlock,
            toBlock: latestBlock,
            chunkSize: policy.logChunkSize,
        }),
    ]);

    const lifecycleEvents = [
        ...proposedLogs.map((log) => ({ kind: 'proposed', log })),
        ...executedLogs.map((log) => ({ kind: 'executed', log })),
        ...deletedLogs.map((log) => ({ kind: 'deleted', log })),
    ].sort(compareLogOrder);

    let changed = false;
    for (const event of lifecycleEvents) {
        const proposalHash = normalizeHash(event.log?.args?.proposalHash);
        if (!proposalHash) {
            continue;
        }

        if (event.kind === 'proposed') {
            const explanation = decodeOgExplanationText(event.log?.args?.explanation);
            const transactions = Array.isArray(event.log?.args?.proposal?.transactions)
                ? event.log.args.proposal.transactions
                : [];
            const record = buildBackfilledReimbursementCommitmentRecord({
                proposalHash,
                proposer: event.log?.args?.proposer,
                transactions,
                explanation,
                policy,
            });
            if (!record) {
                continue;
            }
            const existing = tradeIntentState.reimbursementCommitments[record.commitmentKey];
            const nextRecord = existing
                ? {
                      ...existing,
                      ...record,
                      status: existing.status === 'executed' ? 'executed' : record.status,
                  }
                : record;
            if (JSON.stringify(existing) !== JSON.stringify(nextRecord)) {
                tradeIntentState.reimbursementCommitments[record.commitmentKey] = nextRecord;
                changed = true;
            }
            continue;
        }

        const commitmentKey = `proposal:${proposalHash}`;
        const existing = tradeIntentState.reimbursementCommitments[commitmentKey];
        if (!existing) {
            continue;
        }

        if (event.kind === 'executed') {
            if (existing.status !== 'executed') {
                tradeIntentState.reimbursementCommitments[commitmentKey] = {
                    ...existing,
                    status: 'executed',
                };
                changed = true;
            }
            continue;
        }

        if (existing.status !== 'deleted') {
            tradeIntentState.reimbursementCommitments[commitmentKey] = {
                ...existing,
                status: 'deleted',
            };
            changed = true;
        }
    }

    const nextBackfilledThroughBlock = latestBlock.toString();
    const watermarkChanged =
        tradeIntentState.backfilledReimbursementCommitmentsThroughBlock !==
        nextBackfilledThroughBlock;
    tradeIntentState.backfilledReimbursementCommitmentsThroughBlock = nextBackfilledThroughBlock;
    reimbursementBackfillStatusLogged = false;
    if (lifecycleEvents.length > 0 && previousBackfilledThroughBlock === null) {
        console.log(
            `[agent] Rebuilt ${lifecycleEvents.length} historical reimbursement lifecycle records for ${policy.ogModule}.`
        );
    } else if (lifecycleEvents.length > 0) {
        console.log(
            `[agent] Recovered ${lifecycleEvents.length} incremental reimbursement lifecycle records for ${policy.ogModule} through block ${latestBlock.toString()}.`
        );
    }
    return changed || watermarkChanged;
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

function extractOrderSummary(payload) {
    const order =
        payload?.order && typeof payload.order === 'object'
            ? payload.order
            : payload && typeof payload === 'object'
                ? payload
                : null;
    if (!order) return null;

    return {
        id: normalizeOrderId(order.id ?? order.orderId ?? order.order_id),
        status: normalizeClobStatus(order.status),
        originalSize: parseFiniteNumber(order.original_size ?? order.originalSize),
        sizeMatched: parseFiniteNumber(order.size_matched ?? order.sizeMatched),
        makerAmountFilled: parseOptionalNonNegativeIntegerString(
            order.maker_amount_filled ??
                order.makerAmountFilled ??
                order.making_amount_filled ??
                order.makingAmountFilled
        ),
        takerAmountFilled: parseOptionalNonNegativeIntegerString(
            order.taker_amount_filled ??
                order.takerAmountFilled ??
                order.taking_amount_filled ??
                order.takingAmountFilled
        ),
        feeAmount: parseOptionalNonNegativeIntegerString(
            order.fee ?? order.fee_amount ?? order.feeAmount
        ),
    };
}

function isOrderFullyMatched(order) {
    if (!order) return false;
    if (order.originalSize === null || order.sizeMatched === null) return false;
    if (order.originalSize <= 0) return false;
    return order.sizeMatched + 1e-12 >= order.originalSize;
}

function tradeIncludesOrderId(trade, orderId) {
    const normalizedOrderId = String(orderId).trim().toLowerCase();
    if (!normalizedOrderId) return false;

    const takerOrderId = normalizeOrderId(trade?.taker_order_id ?? trade?.takerOrderId);
    if (takerOrderId && takerOrderId.toLowerCase() === normalizedOrderId) {
        return true;
    }

    const makerOrders = Array.isArray(trade?.maker_orders)
        ? trade.maker_orders
        : Array.isArray(trade?.makerOrders)
            ? trade.makerOrders
            : [];
    for (const makerOrder of makerOrders) {
        const makerOrderId = normalizeOrderId(makerOrder?.order_id ?? makerOrder?.orderId);
        if (makerOrderId && makerOrderId.toLowerCase() === normalizedOrderId) {
            return true;
        }
    }

    return false;
}

function dedupeTrades(trades) {
    const seen = new Set();
    const unique = [];
    for (const trade of trades) {
        const id = normalizeOrderId(trade?.id);
        const key = id ?? JSON.stringify(trade);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(trade);
    }
    return unique;
}

function resolveFilledBuySpendWei({ orderSummary, relatedTrades }) {
    const orderSummarySpend = parseOptionalNonNegativeIntegerString(
        orderSummary?.makerAmountFilled ?? orderSummary?.makingAmountFilled
    );
    if (orderSummarySpend) {
        return orderSummarySpend;
    }

    const confirmedTradeSpend = sumConfirmedTradeSpendWei({ relatedTrades });
    if (confirmedTradeSpend) {
        return confirmedTradeSpend;
    }

    return null;
}

function resolveConfirmedTradeSpendWei(trade) {
    const price = normalizeDecimalText(trade?.price ?? trade?.match_price ?? trade?.matchPrice);
    const shareAmount = parseOptionalShareAmountString(
        trade?.size ??
            trade?.matched_size ??
            trade?.matchedSize ??
            trade?.size_matched ??
            trade?.sizeMatched
    );
    if (!price || !shareAmount) {
        return null;
    }

    try {
        const priceScaled = parseUnits(price, USDC_DECIMALS);
        const product = priceScaled * BigInt(shareAmount);
        if (product % PRICE_SCALE !== 0n) {
            return null;
        }
        return (product / PRICE_SCALE).toString();
    } catch (error) {
        return null;
    }
}

function sumConfirmedTradeSpendWei({ relatedTrades }) {
    let total = 0n;
    let sawConfirmedTrade = false;

    for (const trade of Array.isArray(relatedTrades) ? relatedTrades : []) {
        if (normalizeClobStatus(trade?.status) !== CLOB_SUCCESS_TERMINAL_STATUS) {
            continue;
        }

        const spendWei = resolveConfirmedTradeSpendWei(trade);
        if (!spendWei) {
            return null;
        }

        total += BigInt(spendWei);
        sawConfirmedTrade = true;
    }

    return sawConfirmedTrade ? total.toString() : null;
}

function sumConfirmedTradeShareAmount({ relatedTrades }) {
    let total = 0n;
    let sawConfirmedTrade = false;

    for (const trade of Array.isArray(relatedTrades) ? relatedTrades : []) {
        if (normalizeClobStatus(trade?.status) !== CLOB_SUCCESS_TERMINAL_STATUS) {
            continue;
        }

        const shareAmount = resolveConfirmedTradeShareAmount(trade);
        if (!shareAmount) {
            return null;
        }

        total += BigInt(shareAmount);
        sawConfirmedTrade = true;
    }

    return sawConfirmedTrade ? total.toString() : null;
}

function subtractFilledShareFee(grossShareAmount, feeShareAmount) {
    const normalizedGrossShareAmount = parseOptionalNonNegativeIntegerString(grossShareAmount);
    if (!normalizedGrossShareAmount || BigInt(normalizedGrossShareAmount) <= 0n) {
        return null;
    }

    const normalizedFeeShareAmount = parseOptionalNonNegativeIntegerString(feeShareAmount);
    if (!normalizedFeeShareAmount || BigInt(normalizedFeeShareAmount) <= 0n) {
        return normalizedGrossShareAmount;
    }
    if (BigInt(normalizedFeeShareAmount) > BigInt(normalizedGrossShareAmount)) {
        return null;
    }

    return (BigInt(normalizedGrossShareAmount) - BigInt(normalizedFeeShareAmount)).toString();
}

function resolveConfirmedTradeShareAmount(trade) {
    const grossShareAmount = parseOptionalShareAmountString(
        trade?.size ??
            trade?.matched_size ??
            trade?.matchedSize ??
            trade?.size_matched ??
            trade?.sizeMatched
    );
    if (!grossShareAmount) {
        return null;
    }

    const feeShareAmount = parseOptionalShareAmountString(
        trade?.fee ??
            trade?.fee_amount ??
            trade?.feeAmount ??
            trade?.fee_paid ??
            trade?.feePaid
    );
    return subtractFilledShareFee(grossShareAmount, feeShareAmount);
}

function resolveFilledBuyShareAmount({ intent, orderSummary, relatedTrades }) {
    const netTakerAmountFilled = subtractFilledShareFee(
        orderSummary?.takerAmountFilled,
        orderSummary?.feeAmount
    );
    if (netTakerAmountFilled && BigInt(netTakerAmountFilled) > 0n) {
        return netTakerAmountFilled;
    }

    const confirmedTradeShares = sumConfirmedTradeShareAmount({ relatedTrades });
    if (confirmedTradeShares && BigInt(confirmedTradeShares) > 0n) {
        return confirmedTradeShares;
    }

    const sizeMatchedShares = parseOptionalShareAmountString(orderSummary?.sizeMatched);
    const minimumShareAmount = parseOptionalNonNegativeIntegerString(intent?.orderTakerAmount);
    if (
        sizeMatchedShares &&
        BigInt(sizeMatchedShares) > 0n &&
        (!minimumShareAmount || BigInt(sizeMatchedShares) >= BigInt(minimumShareAmount))
    ) {
        return sizeMatchedShares;
    }

    return null;
}

function normalizeClobHost(host) {
    return (normalizeNonEmptyString(host) ?? DEFAULT_CLOB_HOST).replace(/\/+$/, '');
}

async function fetchClobFeeRateBps({ config, tokenId }) {
    const timeoutMs =
        parseOptionalPositiveInteger(config?.polymarketClobRequestTimeoutMs) ??
        DEFAULT_CLOB_REQUEST_TIMEOUT_MS;
    const url = new URL('/fee-rate', `${normalizeClobHost(config?.polymarketClobHost)}/`);
    url.searchParams.set('token_id', String(tokenId));

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `Failed to fetch Polymarket fee rate for token ${tokenId} (${response.status} ${response.statusText}): ${body}`
        );
    }

    const payload = await response.json();
    const feeRateBps = Number(payload?.base_fee ?? payload?.baseFee);
    if (!Number.isInteger(feeRateBps) || feeRateBps < 0) {
        throw new Error(
            `Polymarket fee-rate response missing non-negative integer base_fee for token ${tokenId}.`
        );
    }

    return String(feeRateBps);
}

async function fetchRelatedClobTrades({
    config,
    signingAddress,
    orderId,
    market,
    clobAuthAddress,
    submittedMs,
}) {
    const afterSeconds = Math.max(
        0,
        Math.floor((Number(submittedMs ?? Date.now()) - 60_000) / 1000)
    );
    const all = [];
    const makerTrades = await getClobTrades({
        config,
        signingAddress,
        maker: clobAuthAddress,
        market,
        after: afterSeconds,
    });
    if (Array.isArray(makerTrades)) {
        all.push(...makerTrades);
    }

    const takerTrades = await getClobTrades({
        config,
        signingAddress,
        taker: clobAuthAddress,
        market,
        after: afterSeconds,
    });
    if (Array.isArray(takerTrades)) {
        all.push(...takerTrades);
    }

    return dedupeTrades(all).filter((trade) => tradeIncludesOrderId(trade, orderId));
}

function extractOrderIdFromSubmission(parsedOutput) {
    return normalizeOrderId(
        parsedOutput?.result?.order?.id ??
            parsedOutput?.result?.id ??
            parsedOutput?.result?.orderID ??
            parsedOutput?.result?.orderId ??
            parsedOutput?.order?.id ??
            parsedOutput?.id ??
            parsedOutput?.orderID ??
            parsedOutput?.orderId
    );
}

function extractOrderStatusFromSubmission(parsedOutput) {
    return normalizeClobStatus(
        parsedOutput?.result?.order?.status ??
            parsedOutput?.result?.status ??
            parsedOutput?.order?.status
    );
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

    for (const intent of getOpenIntents()) {
        if (intent.reimbursementProposalHash || !intent.reimbursementExplanation) {
            continue;
        }

        const matchingCommitments = Object.values(tradeIntentState.reimbursementCommitments).filter(
            (commitment) =>
                commitment?.proposalHash &&
                commitment?.status !== 'deleted' &&
                commitment?.intentKey &&
                commitment.intentKey === intent.intentKey
        );
        const matchingProposalHashes = Array.from(
            new Set(
                matchingCommitments
                    .map((commitment) => normalizeHash(commitment?.proposalHash))
                    .filter(Boolean)
            )
        );
        if (matchingProposalHashes.length !== 1) {
            continue;
        }

        intent.reimbursementProposalHash = matchingProposalHashes[0];
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

async function refreshOrderStatus({
    publicClient,
    account,
    config,
    policy,
    tokenHolderAddress,
}) {
    const clobAuthAddress = getClobAuthAddress({
        config,
        accountAddress: account?.address,
    });
    if (!clobAuthAddress) {
        return false;
    }

    let changed = false;
    const nowMs = Date.now();
    for (const intent of getOpenIntents()) {
        if (intent.orderFilled) {
            continue;
        }
        if (!intent.orderId) {
            if (hasTimedOut(intent.orderSubmittedAtMs, policy.pendingTxTimeoutMs, nowMs)) {
                const detail =
                    intent.lastOrderSubmissionStatus === 'missing_order_id'
                        ? 'Polymarket order submission returned submitted without an order id; refusing automatic retry and waiting for manual reconciliation.'
                        : intent.lastOrderSubmissionError ??
                          'Polymarket order submission outcome remained ambiguous until timeout; refusing automatic retry.';
                if (
                    intent.lastOrderStatusRefreshError !== detail ||
                    !Number.isInteger(intent.orderStatusRefreshFailedAtMs)
                ) {
                    intent.lastOrderStatusRefreshError = detail;
                    intent.orderStatusRefreshFailedAtMs = nowMs;
                    intent.updatedAtMs = nowMs;
                    changed = true;
                }
                changed = true;
            }
            continue;
        }

        try {
            const orderPayload = await getClobOrder({
                config,
                signingAddress: clobAuthAddress,
                orderId: intent.orderId,
            });
            const orderSummary = extractOrderSummary(orderPayload);
            if (orderSummary?.status && orderSummary.status !== intent.orderStatus) {
                intent.orderStatus = orderSummary.status;
                intent.updatedAtMs = nowMs;
                changed = true;
            }
            const orderFailed = CLOB_ORDER_FAILURE_STATUSES.has(orderSummary?.status ?? '');
            if (orderFailed) {
                markTerminalIntentFailure(intent, {
                    stage: 'order',
                    status: orderSummary?.status ?? 'failed',
                    detail: 'Polymarket order failed or was rejected.',
                    releaseCredit: true,
                });
                changed = true;
                continue;
            }

            const relatedTrades = await fetchRelatedClobTrades({
                config,
                signingAddress: clobAuthAddress,
                orderId: intent.orderId,
                market: policy.marketId,
                clobAuthAddress,
                submittedMs: intent.orderSubmittedAtMs,
            });
            if (intent.lastOrderStatusRefreshError || intent.orderStatusRefreshFailedAtMs) {
                delete intent.lastOrderStatusRefreshError;
                delete intent.orderStatusRefreshFailedAtMs;
                intent.updatedAtMs = nowMs;
                changed = true;
            }
            const relatedStatuses = relatedTrades
                .map((trade) => normalizeClobStatus(trade?.status))
                .filter(Boolean);
            const anyFailedTrade = relatedStatuses.some(
                (status) => status === CLOB_FAILURE_TERMINAL_STATUS
            );
            const allConfirmedTrades =
                relatedStatuses.length > 0 &&
                relatedStatuses.every((status) => status === CLOB_SUCCESS_TERMINAL_STATUS);
            const orderFilled =
                isOrderFullyMatched(orderSummary) ||
                CLOB_ORDER_FILLED_STATUSES.has(orderSummary?.status ?? '');

            if (anyFailedTrade) {
                markTerminalIntentFailure(intent, {
                    stage: 'order',
                    status: orderSummary?.status ?? 'failed',
                    detail: 'Polymarket order failed or was rejected.',
                    releaseCredit: true,
                });
                changed = true;
                continue;
            }

            const reimbursementAmountWei = resolveFilledBuySpendWei({
                orderSummary,
                relatedTrades,
            });
            let filledShareAmount = resolveFilledBuyShareAmount({
                intent,
                orderSummary,
                relatedTrades,
            });
            const observedFilledShareAmount = await observeFilledTokenInventoryDelta({
                publicClient,
                policy,
                tokenHolderAddress,
                intent,
            });
            const configuredFeeRateBps = parseOptionalNonNegativeIntegerString(intent.feeRateBps);
            const feeEnabledBuy =
                (configuredFeeRateBps && BigInt(configuredFeeRateBps) > 0n) ||
                Boolean(orderSummary?.feeAmount);
            if (
                feeEnabledBuy &&
                observedFilledShareAmount &&
                filledShareAmount &&
                BigInt(observedFilledShareAmount) > 0n &&
                BigInt(observedFilledShareAmount) < BigInt(filledShareAmount)
            ) {
                filledShareAmount = observedFilledShareAmount;
            }
            const tokenBalanceSettlementReady =
                orderFilled &&
                relatedStatuses.length === 0 &&
                Boolean(reimbursementAmountWei) &&
                Boolean(filledShareAmount) &&
                Boolean(observedFilledShareAmount) &&
                BigInt(observedFilledShareAmount) >= BigInt(filledShareAmount);

            if ((allConfirmedTrades && orderFilled) || tokenBalanceSettlementReady) {
                if (!reimbursementAmountWei) {
                    throw new Error(
                        `Unable to determine actual USDC spent for filled Polymarket BUY order ${intent.orderId}.`
                    );
                }
                if (!filledShareAmount) {
                    throw new Error(
                        `Unable to determine acquired share amount for filled Polymarket BUY order ${intent.orderId}.`
                    );
                }
                intent.orderFilled = true;
                intent.orderFilledAtMs = nowMs;
                intent.reimbursementAmountWei = reimbursementAmountWei;
                intent.reservedCreditAmountWei = reimbursementAmountWei;
                intent.filledShareAmount = filledShareAmount;
                intent.orderSettlementEvidence = tokenBalanceSettlementReady
                    ? 'token_balance'
                    : 'confirmed_trades';
                intent.updatedAtMs = nowMs;
                changed = true;
            }
        } catch (error) {
            if (!hasTimedOut(intent.orderSubmittedAtMs, policy.pendingTxTimeoutMs, nowMs)) {
                continue;
            }
            const detail = error?.message ?? String(error);
            if (
                intent.lastOrderStatusRefreshError !== detail ||
                !Number.isInteger(intent.orderStatusRefreshFailedAtMs)
            ) {
                intent.lastOrderStatusRefreshError = detail;
                intent.orderStatusRefreshFailedAtMs = nowMs;
                intent.updatedAtMs = nowMs;
                changed = true;
            }
        }
    }

    return changed;
}

async function refreshTrackedTxSubmissionStatus({
    publicClient,
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
                changed = noteTrackedSubmissionTimeoutAmbiguity(intent, fields, nowMs) || changed;
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
        pendingTxTimeoutMs: policy.pendingTxTimeoutMs,
        fields: DEPOSIT_SUBMISSION_FIELDS,
        isComplete: (intent) => intent.tokenDeposited,
        onMissingTxTimeout: (intent, { nowMs }) => {
            delete intent.depositSubmittedAtMs;
            intent.updatedAtMs = nowMs;
            return true;
        },
        onConfirmedReceipt: (intent, { nowMs, receipt }) => {
            const blockNumber = BigInt(receipt?.blockNumber ?? latestBlock);
            intent.depositBlockNumber = blockNumber.toString();
            intent.tokenDeposited = true;
            intent.tokenDepositedAtMs = nowMs;
            delete intent.depositDispatchAtMs;
            clearDepositSubmissionAmbiguity(intent);
            intent.updatedAtMs = nowMs;
            return true;
        },
        onRevertedReceipt: (intent, { nowMs }) => {
            delete intent.depositTxHash;
            delete intent.depositSubmittedAtMs;
            delete intent.depositDispatchAtMs;
            clearDepositSubmissionAmbiguity(intent);
            intent.updatedAtMs = nowMs;
            return true;
        },
        onReceiptUnavailableAfterTimeout: (intent, { nowMs, error }) => {
            const detail = error?.message ?? String(error);
            if (
                intent.lastDepositReceiptError === detail &&
                Number.isInteger(intent.depositSubmissionAmbiguousAtMs)
            ) {
                return false;
            }
            markAmbiguousDepositSubmission(intent, detail, nowMs);
            return true;
        },
    });
}

async function refreshProposalSubmissionStatus({ publicClient, policy }) {
    return refreshTrackedTxSubmissionStatus({
        publicClient,
        pendingTxTimeoutMs: policy.pendingTxTimeoutMs,
        fields: REIMBURSEMENT_SUBMISSION_FIELDS,
        isComplete: (intent) => Boolean(intent.reimbursementProposalHash),
        onMissingTxTimeout: (intent, { nowMs }) => {
            delete intent.reimbursementSubmittedAtMs;
            delete intent.lastReimbursementSubmissionStatus;
            delete intent.lastReimbursementSubmissionError;
            intent.updatedAtMs = nowMs;
            return true;
        },
        onConfirmedReceipt: (intent, { nowMs, receipt }) => {
            const recoveredProposalHash = extractProposalHashFromReceipt({
                receipt,
                ogModule: policy.ogModule,
            });
            if (recoveredProposalHash && recoveredProposalHash !== intent.reimbursementProposalHash) {
                intent.reimbursementProposalHash = recoveredProposalHash;
                delete intent.reimbursementSubmittedAtMs;
                if (pendingProposalSubmission?.intentKey === intent.intentKey) {
                    pendingProposalSubmission = null;
                }
                clearReimbursementSubmissionAmbiguity(intent);
                delete intent.lastReimbursementSubmissionStatus;
                delete intent.lastReimbursementSubmissionError;
                intent.updatedAtMs = nowMs;
                return true;
            }
            if (
                intent.reimbursementSubmissionAmbiguous &&
                intent.lastReimbursementSubmissionStatus === 'confirmed_missing_hash'
            ) {
                return false;
            }
            intent.lastReimbursementSubmissionStatus = 'confirmed_missing_hash';
            markAmbiguousReimbursementSubmission(
                intent,
                'Reimbursement proposal transaction confirmed but proposal hash could not be recovered from receipt; waiting for proposal signal recovery.',
                nowMs
            );
            return true;
        },
        onRevertedReceipt: (intent, { nowMs }) => {
            delete intent.reimbursementSubmissionTxHash;
            delete intent.reimbursementSubmittedAtMs;
            delete intent.reimbursementDispatchAtMs;
            if (pendingProposalSubmission?.intentKey === intent.intentKey) {
                pendingProposalSubmission = null;
            }
            delete intent.reimbursementSubmissionAmbiguous;
            delete intent.reimbursementSubmissionAmbiguousAtMs;
            delete intent.lastReimbursementSubmissionStatus;
            delete intent.lastReimbursementSubmissionError;
            intent.updatedAtMs = nowMs;
            return true;
        },
        onReceiptUnavailableAfterTimeout: (intent, { nowMs, error }) => {
            const detail = error?.message ?? String(error);
            if (
                intent.lastReimbursementSubmissionError === detail &&
                Number.isInteger(intent.reimbursementSubmissionAmbiguousAtMs)
            ) {
                return false;
            }
            markAmbiguousReimbursementSubmission(intent, detail, nowMs);
            return true;
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
    const policy = resolvePolicy(config);
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

    const policy = resolvePolicy(config);
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
            publicClient,
            account: { address: normalizedAgentAddress },
            config,
            policy,
            tokenHolderAddress,
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

            markDispatchStarted(intent, 'deposit');
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
            markDispatchStarted(intent, 'reimbursement');
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
        markDispatchStarted(intent, 'order');
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

function getParsedToolOutputStatus(parsedOutput) {
    return typeof parsedOutput?.status === 'string' && parsedOutput.status.trim()
        ? parsedOutput.status.trim()
        : 'unknown';
}

function getParsedToolOutputDetail(parsedOutput, status) {
    if (typeof parsedOutput?.message === 'string' && parsedOutput.message.trim()) {
        return parsedOutput.message.trim();
    }
    if (typeof parsedOutput?.reason === 'string' && parsedOutput.reason.trim()) {
        return parsedOutput.reason.trim();
    }
    return `tool returned status=${status}`;
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

    const status = getParsedToolOutputStatus(parsedOutput);
    if (status !== 'published') {
        intent.lastArchiveError = getParsedToolOutputDetail(parsedOutput, status);
        intent.lastArchiveStatus = status;
        intent.nextArchiveAttemptAtMs = Date.now() + policy.archiveRetryDelayMs;
        intent.updatedAtMs = Date.now();
        if (parsedOutput?.retryable === false && parsedOutput?.sideEffectsLikelyCommitted !== true) {
            markTerminalIntentFailure(intent, {
                stage: 'archive',
                status,
                detail: intent.lastArchiveError,
                releaseCredit: true,
            });
        }
        await maybePersistTradeIntentState();
        return;
    }

    const cid =
        typeof parsedOutput?.cid === 'string' && parsedOutput.cid.trim()
            ? parsedOutput.cid.trim()
            : null;
    const uri =
        typeof parsedOutput?.uri === 'string' && parsedOutput.uri.trim()
            ? parsedOutput.uri.trim()
            : cid
                ? `ipfs://${cid}`
                : null;
    intent.artifactCid = cid;
    intent.artifactUri = uri;
    intent.pinned = parsedOutput?.pinned ?? parsedOutput?.pin ?? null;
    intent.archivedAtMs = Date.now();
    intent.nextArchiveAttemptAtMs = null;
    intent.lastArchiveError = null;
    intent.lastArchiveStatus = 'published';
    intent.updatedAtMs = Date.now();
    console.log(
        `[agent] Signed trade intent archive published for ${pending.intentKey}: uri=${intent.artifactUri ?? 'missing'}.`
    );
    await maybePersistTradeIntentState();
}

async function handleOrderToolOutput({ parsedOutput, policy }) {
    const { intent } = takePendingIntent('order');
    if (!intent) {
        return;
    }
    clearDispatchStarted(intent, 'order');

    const status = getParsedToolOutputStatus(parsedOutput);
    if (status !== 'submitted') {
        const detail = getParsedToolOutputDetail(parsedOutput, status);
        const sideEffectsLikelyCommitted = parsedOutput?.sideEffectsLikelyCommitted === true;
        if (parsedOutput?.retryable === false && !sideEffectsLikelyCommitted) {
            markTerminalIntentFailure(intent, {
                stage: 'order_submission',
                status,
                detail,
                releaseCredit: true,
            });
        } else {
            intent.lastOrderSubmissionStatus = status;
            intent.lastOrderSubmissionError = detail;
            intent.nextOrderAttemptAtMs = Date.now() + policy.archiveRetryDelayMs;
            if (sideEffectsLikelyCommitted) {
                intent.orderSubmittedAtMs = Date.now();
                delete intent.nextOrderAttemptAtMs;
            }
            intent.updatedAtMs = Date.now();
        }
        await maybePersistTradeIntentState();
        return;
    }

    intent.orderId = extractOrderIdFromSubmission(parsedOutput);
    intent.orderStatus = extractOrderStatusFromSubmission(parsedOutput);
    if (!intent.orderId) {
        intent.lastOrderSubmissionStatus = 'missing_order_id';
        intent.lastOrderSubmissionError =
            'Polymarket order submission returned submitted without an order id; refusing automatic retry until reconciled.';
        intent.orderSubmittedAtMs = Date.now();
        delete intent.nextOrderAttemptAtMs;
        intent.updatedAtMs = Date.now();
        await maybePersistTradeIntentState();
        return;
    }
    delete intent.lastOrderSubmissionStatus;
    delete intent.lastOrderSubmissionError;
    delete intent.nextOrderAttemptAtMs;
    intent.orderSubmittedAtMs = Date.now();
    intent.updatedAtMs = Date.now();
    await maybePersistTradeIntentState();
}

async function handleDepositToolOutput({ parsedOutput, policy }) {
    const { intent } = takePendingIntent('deposit');
    if (!intent) {
        return;
    }
    clearDispatchStarted(intent, 'deposit');

    const status = getParsedToolOutputStatus(parsedOutput);
    if (status === 'confirmed' || status === 'submitted') {
        const txHash = normalizeHash(parsedOutput?.transactionHash);
        intent.depositTxHash = txHash;
        intent.depositSubmittedAtMs = Date.now();
        delete intent.lastDepositStatus;
        delete intent.lastDepositError;
        delete intent.nextDepositAttemptAtMs;
        clearDepositSubmissionAmbiguity(intent);
        if (status === 'submitted' && parsedOutput?.pendingConfirmation === true) {
            markAmbiguousDepositSubmission(intent, parsedOutput?.warning ?? null, Date.now());
        }
        if (status === 'confirmed') {
            intent.tokenDeposited = true;
            intent.tokenDepositedAtMs = Date.now();
            clearDepositSubmissionAmbiguity(intent);
        }
        intent.updatedAtMs = Date.now();
        await maybePersistTradeIntentState();
        return;
    }

    const detail = getParsedToolOutputDetail(parsedOutput, status);
    intent.lastDepositStatus = status;
    intent.lastDepositError = detail;
    if (parsedOutput?.sideEffectsLikelyCommitted === true) {
        intent.depositTxHash = normalizeHash(parsedOutput?.transactionHash) ?? intent.depositTxHash;
        intent.depositSubmittedAtMs = Date.now();
        delete intent.nextDepositAttemptAtMs;
        markAmbiguousDepositSubmission(intent, detail, Date.now());
        await maybePersistTradeIntentState();
        return;
    }
    if (status === 'skipped' || parsedOutput?.retryable === false) {
        markTerminalIntentFailure(intent, {
            stage: 'deposit',
            status,
            detail,
            releaseCredit: false,
        });
        await maybePersistTradeIntentState();
        return;
    }

    delete intent.depositSubmittedAtMs;
    clearDepositSubmissionAmbiguity(intent);
    intent.nextDepositAttemptAtMs = Date.now() + policy.archiveRetryDelayMs;
    intent.updatedAtMs = Date.now();
    await maybePersistTradeIntentState();
}

async function handleReimbursementToolOutput({ parsedOutput, policy }) {
    const { pending, intent } = takePendingIntent('reimbursement');
    if (!intent) {
        return;
    }
    clearDispatchStarted(intent, 'reimbursement');

    const status = getParsedToolOutputStatus(parsedOutput);
    if (status !== 'submitted') {
        const detail = getParsedToolOutputDetail(parsedOutput, status);
        const ambiguousSubmission =
            status === 'pending' || parsedOutput?.sideEffectsLikelyCommitted === true;
        intent.lastReimbursementSubmissionStatus = status;
        intent.lastReimbursementSubmissionError = detail;
        if (ambiguousSubmission) {
            intent.reimbursementSubmittedAtMs = Date.now();
            intent.reimbursementSubmissionAmbiguous = true;
            intent.updatedAtMs = Date.now();
            await maybePersistTradeIntentState();
            return;
        }

        if (status === 'skipped' || parsedOutput?.retryable === false) {
            markTerminalIntentFailure(intent, {
                stage: 'reimbursement_submission',
                status,
                detail,
                releaseCredit: false,
            });
            await maybePersistTradeIntentState();
            return;
        }

        delete intent.reimbursementSubmittedAtMs;
        delete intent.reimbursementDispatchAtMs;
        delete intent.reimbursementSubmissionAmbiguous;
        delete intent.reimbursementSubmissionAmbiguousAtMs;
        intent.nextReimbursementAttemptAtMs = Date.now() + policy.archiveRetryDelayMs;
        intent.updatedAtMs = Date.now();
        await maybePersistTradeIntentState();
        return;
    }

    const proposalHash = resolveOgProposalHashFromToolOutput(parsedOutput);
    const txHash = normalizeHash(parsedOutput?.transactionHash);
    intent.reimbursementExplanation = pending?.explanation ?? intent.reimbursementExplanation;
    delete intent.lastReimbursementSubmissionStatus;
    delete intent.lastReimbursementSubmissionError;
    clearReimbursementSubmissionAmbiguity(intent);
    if (proposalHash) {
        intent.reimbursementProposalHash = proposalHash;
        intent.reimbursementSubmissionTxHash = txHash;
        delete intent.reimbursementSubmittedAtMs;
    } else if (txHash) {
        intent.reimbursementSubmissionTxHash = txHash;
        intent.reimbursementSubmittedAtMs = Date.now();
    } else {
        intent.reimbursementSubmittedAtMs = Date.now();
        markAmbiguousReimbursementSubmission(
            intent,
            'Reimbursement proposal returned submitted without proposal hash or transaction hash.',
            Date.now()
        );
    }
    intent.updatedAtMs = Date.now();
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
