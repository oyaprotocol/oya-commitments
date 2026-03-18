import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, erc20Abi, erc1155Abi, getAddress, hexToString, isAddressEqual } from 'viem';
import { findContractDeploymentBlock, getLogsChunked } from '../../../agent/src/lib/chain-history.js';
import { extractFirstText } from '../../../agent/src/lib/llm.js';
import { buildSignedMessagePayload } from '../../../agent/src/lib/message-signing.js';
import { proposalExecutedEvent, transactionsProposedEvent, transferEvent } from '../../../agent/src/lib/og.js';
import { getAlwaysEmitBalanceSnapshotPollingOptions } from '../../../agent/src/lib/polling.js';
import { buildOgTransactions } from '../../../agent/src/lib/tx.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_VERSION = 5;
const DEFAULT_USDC_UNIT_AMOUNT_WEI = 1_000_000n;
const DEFAULT_FILL_CONFIRMATION_THRESHOLD = 1n;
const DEFAULT_SIGNED_COMMANDS = ['fast_withdraw', 'fast_withdraw_erc1155'];
const DEFAULT_PENDING_TX_TIMEOUT_MS = 900_000;
const DEFAULT_ARCHIVE_RETRY_DELAY_MS = 30_000;
const DEFAULT_LOG_CHUNK_SIZE = 5_000n;
const ARTIFACT_VERSION = 'oya-signed-request-archive-v1';
const FILENAME_PREFIX = 'signed-request-';
const FILENAME_SUFFIX = '.json';

const swapState = {
    nextSequence: 1,
    orders: {},
    deposits: {},
    backfilledDepositsThroughBlock: null,
    interpretedRequests: {},
};

let swapStateHydrated = false;
let swapStateDirty = false;
let swapStateRevision = 0;
let lastPersistedSwapStateRevision = 0;
let statePathOverride = null;
let runtimeStatePath = null;
let runtimeStateNamespaceKey = null;
let pendingArtifactPublish = null;
let pendingDirectFill = null;
let pendingProposal = null;
let persistSwapStateQueue = Promise.resolve();
let depositBackfillStatusLogged = false;
const queuedProposalEventUpdates = [];

function markSwapStateDirty() {
    swapStateDirty = true;
    swapStateRevision += 1;
}

function resetInMemoryState({ hydrated = false, preserveQueuedProposalEventUpdates = false } = {}) {
    swapState.nextSequence = 1;
    swapState.orders = {};
    swapState.deposits = {};
    swapState.backfilledDepositsThroughBlock = null;
    swapState.interpretedRequests = {};
    swapStateHydrated = hydrated;
    swapStateDirty = false;
    swapStateRevision = 0;
    lastPersistedSwapStateRevision = 0;
    pendingArtifactPublish = null;
    pendingDirectFill = null;
    pendingProposal = null;
    depositBackfillStatusLogged = false;
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
    return path.join(__dirname, '.swap-state.json');
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
            `.swap-state-${sanitizeStatePathSegment(namespaceKey)}.json`
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

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function normalizeAddress(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('Address must be a non-empty string.');
    }
    return getAddress(value.trim());
}

function normalizeHashOrNull(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    return value.trim().toLowerCase();
}

function normalizePositiveBigInt(value, fieldName) {
    try {
        const normalized = BigInt(String(value));
        if (normalized <= 0n) {
            throw new Error(`${fieldName} must be positive.`);
        }
        return normalized;
    } catch (error) {
        throw new Error(`${fieldName} must be a positive integer string.`);
    }
}

function normalizeNonNegativeBigInt(value, fieldName) {
    try {
        const normalized = BigInt(String(value));
        if (normalized < 0n) {
            throw new Error(`${fieldName} must be non-negative.`);
        }
        return normalized;
    } catch (error) {
        throw new Error(`${fieldName} must be a non-negative integer string.`);
    }
}

function normalizePositiveInteger(value, fieldName) {
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized <= 0) {
        throw new Error(`${fieldName} must be a positive integer.`);
    }
    return normalized;
}

function isReceiptUnavailableError(error) {
    const name = String(error?.name ?? '');
    if (name.includes('TransactionReceiptNotFoundError') || name.includes('TransactionNotFoundError')) {
        return true;
    }

    const message = String(error?.shortMessage ?? error?.message ?? '').toLowerCase();
    return message.includes('transaction receipt') && message.includes('not found');
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

function getSignedRequestCommands(config) {
    const configured = Array.isArray(config?.agentConfig?.signedCommands)
        ? config.agentConfig.signedCommands
        : DEFAULT_SIGNED_COMMANDS;
    return new Set(
        configured
            .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
            .filter(Boolean)
    );
}

function resolvePolicy(config) {
    const agentConfig = config?.agentConfig ?? {};
    const authorizedAgent =
        typeof agentConfig.authorizedAgent === 'string' && agentConfig.authorizedAgent.trim()
            ? normalizeAddress(agentConfig.authorizedAgent)
            : null;
    if (!authorizedAgent) {
        throw new Error(
            'erc1155-swap-fast-withdraw requires agentConfig.authorizedAgent.'
        );
    }

    const paymentToken =
        typeof agentConfig.paymentToken === 'string' && agentConfig.paymentToken.trim()
            ? normalizeAddress(agentConfig.paymentToken)
            : Array.isArray(config?.watchAssets) && config.watchAssets.length === 1
                ? normalizeAddress(config.watchAssets[0])
                : null;
    if (!paymentToken) {
        throw new Error(
            'erc1155-swap-fast-withdraw requires exactly one payment token in watchAssets or agentConfig.paymentToken.'
        );
    }

    if (!Array.isArray(config?.watchErc1155Assets) || config.watchErc1155Assets.length !== 1) {
        throw new Error(
            'erc1155-swap-fast-withdraw requires exactly one tracked ERC1155 asset in watchErc1155Assets.'
        );
    }

    const trackedToken = config.watchErc1155Assets[0];
    const erc1155Token = normalizeAddress(trackedToken.token);
    const erc1155TokenId = normalizeNonNegativeBigInt(
        trackedToken.tokenId,
        'watchErc1155Assets[0].tokenId'
    ).toString();

    const usdcUnitAmountWei =
        agentConfig.usdcUnitAmountWei !== undefined
            ? normalizePositiveBigInt(agentConfig.usdcUnitAmountWei, 'agentConfig.usdcUnitAmountWei')
            : DEFAULT_USDC_UNIT_AMOUNT_WEI;
    const fillConfirmationThreshold =
        agentConfig.fillConfirmationThreshold !== undefined
            ? normalizePositiveBigInt(
                  agentConfig.fillConfirmationThreshold,
                  'agentConfig.fillConfirmationThreshold'
              )
            : DEFAULT_FILL_CONFIRMATION_THRESHOLD;

    return {
        authorizedAgent,
        paymentToken,
        paymentTokenSymbol:
            typeof agentConfig.paymentTokenSymbol === 'string' && agentConfig.paymentTokenSymbol.trim()
                ? agentConfig.paymentTokenSymbol.trim()
                : 'USDC',
        erc1155Token,
        erc1155TokenId,
        erc1155Symbol:
            typeof trackedToken.symbol === 'string' && trackedToken.symbol.trim()
                ? trackedToken.symbol.trim()
                : `ERC1155-${erc1155TokenId}`,
        usdcUnitAmountWei,
        fillConfirmationThreshold,
        signedCommands: getSignedRequestCommands(config),
        pendingTxTimeoutMs:
            agentConfig.pendingTxTimeoutMs !== undefined
                ? normalizePositiveInteger(
                      agentConfig.pendingTxTimeoutMs,
                      'agentConfig.pendingTxTimeoutMs'
                  )
                : DEFAULT_PENDING_TX_TIMEOUT_MS,
        archiveRetryDelayMs:
            agentConfig.archiveRetryDelayMs !== undefined
                ? normalizePositiveInteger(
                      agentConfig.archiveRetryDelayMs,
                      'agentConfig.archiveRetryDelayMs'
                  )
                : DEFAULT_ARCHIVE_RETRY_DELAY_MS,
        logChunkSize:
            config?.logChunkSize !== undefined && config?.logChunkSize !== null
                ? BigInt(config.logChunkSize)
                : DEFAULT_LOG_CHUNK_SIZE,
    };
}

function sortOrders(records) {
    return records.sort((left, right) => {
        const leftSequence = Number(left?.sequence ?? 0);
        const rightSequence = Number(right?.sequence ?? 0);
        if (leftSequence !== rightSequence) {
            return leftSequence - rightSequence;
        }
        return String(left?.orderId ?? '').localeCompare(String(right?.orderId ?? ''));
    });
}

function getOpenOrders() {
    return sortOrders(
        Object.values(swapState.orders).filter(
            (order) =>
                order?.sourceKind === 'signed_request' &&
                typeof order?.reservedCreditAmountWei === 'string' &&
                !order?.reimbursedAtMs &&
                !order?.closedAtMs &&
                !order?.creditReleasedAtMs
        )
    );
}

function allocateSequence() {
    const nextSequence = Number(swapState.nextSequence ?? 1);
    swapState.nextSequence = nextSequence + 1;
    markSwapStateDirty();
    return nextSequence;
}

async function hydrateSwapState() {
    if (swapStateHydrated) return;
    swapStateHydrated = true;
    try {
        const raw = await readFile(getStatePath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            swapState.nextSequence =
                Number.isInteger(parsed.nextSequence) && parsed.nextSequence > 0
                    ? parsed.nextSequence
                    : 1;
            swapState.orders =
                parsed.orders && typeof parsed.orders === 'object' && !Array.isArray(parsed.orders)
                    ? parsed.orders
                    : {};
            swapState.deposits =
                parsed.deposits && typeof parsed.deposits === 'object' && !Array.isArray(parsed.deposits)
                    ? parsed.deposits
                    : {};
            swapState.backfilledDepositsThroughBlock =
                typeof parsed.backfilledDepositsThroughBlock === 'string' &&
                parsed.backfilledDepositsThroughBlock.trim()
                    ? parsed.backfilledDepositsThroughBlock.trim()
                    : null;
            swapState.interpretedRequests =
                parsed.interpretedRequests &&
                typeof parsed.interpretedRequests === 'object' &&
                !Array.isArray(parsed.interpretedRequests)
                    ? parsed.interpretedRequests
                    : {};
        }
    } catch (error) {
        resetInMemoryState({ hydrated: true });
        return;
    }
    swapStateDirty = false;
    swapStateRevision = 0;
    lastPersistedSwapStateRevision = 0;
}

async function persistSwapState() {
    const statePath = getStatePath();
    const namespaceKey = runtimeStateNamespaceKey;
    const writeRevision = swapStateRevision;
    const payload = JSON.stringify(
        {
            version: STATE_VERSION,
            nextSequence: swapState.nextSequence,
            orders: swapState.orders,
            deposits: swapState.deposits,
            backfilledDepositsThroughBlock: swapState.backfilledDepositsThroughBlock,
            interpretedRequests: swapState.interpretedRequests,
        },
        null,
        2
    );
    const writeTask = persistSwapStateQueue.catch(() => {}).then(async () => {
        await writeFile(statePath, payload, 'utf8');
        const sameRuntimeContext =
            runtimeStateNamespaceKey === namespaceKey && getStatePath() === statePath;
        if (!sameRuntimeContext) {
            return;
        }
        lastPersistedSwapStateRevision = Math.max(lastPersistedSwapStateRevision, writeRevision);
        swapStateDirty = swapStateRevision > lastPersistedSwapStateRevision;
    });
    persistSwapStateQueue = writeTask;
    await writeTask;
}

async function maybePersistSwapState() {
    if (!swapStateDirty) return;
    await persistSwapState();
}

function createDepositRecord(signal, policy) {
    if (signal?.kind !== 'erc20Deposit') {
        return null;
    }
    if (!signal.asset || !isAddressEqual(signal.asset, policy.paymentToken)) {
        return null;
    }
    if (typeof signal.from !== 'string' || !signal.from.trim()) {
        return null;
    }

    const amountWei = normalizePositiveBigInt(signal.amount, 'payment amount');
    const transactionHash = normalizeHashOrNull(signal.transactionHash);
    const logIndex =
        signal.logIndex === undefined || signal.logIndex === null ? null : String(signal.logIndex);
    const signalId =
        typeof signal.id === 'string' && signal.id.trim() ? signal.id.trim() : null;
    const depositKey =
        transactionHash && logIndex !== null ? `tx:${transactionHash}:${logIndex}` : signalId ? `signal:${signalId}` : null;
    if (!depositKey) {
        return null;
    }

    return {
        depositKey,
        depositId: signalId,
        depositor: normalizeAddress(signal.from),
        amountWei: amountWei.toString(),
        transactionHash,
        logIndex,
        blockNumber:
            signal.blockNumber !== undefined && signal.blockNumber !== null
                ? BigInt(signal.blockNumber).toString()
                : null,
        createdAtMs: Date.now(),
    };
}

function parseSignedRequestAmount(args) {
    const raw =
        args?.amount ??
        args?.tokenAmount ??
        args?.quantity ??
        1;
    return normalizePositiveBigInt(raw, 'signed request amount');
}

function buildSignedRequestOrderId(signer, requestId) {
    return `request:${normalizeAddress(signer)}:${String(requestId).trim()}`;
}

function encodeRequestIdForFilename(requestId) {
    return Buffer.from(String(requestId), 'utf8').toString('hex');
}

function buildArtifactFilename(requestId) {
    return `${FILENAME_PREFIX}${encodeRequestIdForFilename(requestId)}${FILENAME_SUFFIX}`;
}

function buildSignedRequestArchiveArtifact({ order, commitmentSafe, agentAddress }) {
    if (order?.sourceKind !== 'signed_request' || !order?.requestId || !order?.signer) {
        throw new Error('buildSignedRequestArchiveArtifact requires a signed request order.');
    }

    const canonicalSignedMessage = buildSignedMessagePayload({
        address: order.signer,
        timestampMs: order.signedAtMs,
        text: order.text ?? null,
        command: order.command ?? null,
        args: cloneJson(order.originalArgs ?? null),
        metadata: cloneJson(order.metadata ?? null),
        requestId: order.requestId,
        deadline: order.deadline ?? null,
    });

    return {
        version: ARTIFACT_VERSION,
        requestId: order.requestId,
        messageId: order.messageId ?? null,
        signedRequest: {
            authType: 'eip191',
            signer: order.signer,
            signature: order.signature,
            signedAtMs: order.signedAtMs,
            canonicalMessage: canonicalSignedMessage,
            envelope: {
                requestId: order.requestId,
                deadline: order.deadline ?? null,
                text: order.text ?? null,
                command: order.command ?? null,
                args: cloneJson(order.originalArgs ?? null),
                metadata: cloneJson(order.metadata ?? null),
            },
        },
        agentContext: {
            commitmentSafe: commitmentSafe ?? null,
            agentAddress: agentAddress ?? null,
            orderId: order.orderId,
            receivedAtMs: order.createdAtMs ?? null,
        },
    };
}

function getSignedRequestStateKey(signal) {
    if (!isSignedUserMessage(signal)) {
        return null;
    }
    return buildSignedRequestOrderId(signal.sender.address, signal.requestId);
}

function getStructuredArgs(signal) {
    return signal?.args && typeof signal.args === 'object' && !Array.isArray(signal.args)
        ? signal.args
        : {};
}

function getResolvedSignedRequestArgs(signal) {
    const structuredArgs = getStructuredArgs(signal);
    if (structuredArgs.recipient !== undefined || structuredArgs.to !== undefined) {
        return structuredArgs;
    }

    const requestKey = getSignedRequestStateKey(signal);
    if (!requestKey) {
        return structuredArgs;
    }

    const cachedArgs =
        swapState.interpretedRequests?.[requestKey]?.args &&
        typeof swapState.interpretedRequests[requestKey].args === 'object' &&
        !Array.isArray(swapState.interpretedRequests[requestKey].args)
            ? swapState.interpretedRequests[requestKey].args
            : null;
    return cachedArgs ?? structuredArgs;
}

function needsFreeTextInterpretation(signal, policy) {
    if (!isSignedUserMessage(signal)) {
        return false;
    }

    const command =
        typeof signal.command === 'string' && signal.command.trim()
            ? signal.command.trim().toLowerCase()
            : '';
    if (command && !policy.signedCommands.has(command)) {
        return false;
    }

    const args = getStructuredArgs(signal);
    if (args.recipient !== undefined || args.to !== undefined) {
        return false;
    }

    if (typeof signal.text !== 'string' || !signal.text.trim()) {
        return false;
    }

    return !swapState.interpretedRequests?.[getSignedRequestStateKey(signal)];
}

function createOpenAiHttpError(statusCode, responseText) {
    const error = new Error(`OpenAI API error while interpreting free-text request: ${statusCode} ${responseText}`);
    error.statusCode = statusCode;
    error.responseBody = responseText;
    if (statusCode === 429) {
        error.name = 'RateLimitError';
    } else if (statusCode >= 500) {
        error.name = 'HttpRequestError';
    }
    return error;
}

function createRetryableInterpretationError(message) {
    const error = new Error(message);
    error.name = 'HttpRequestError';
    return error;
}

async function interpretFreeTextRequestSignal({
    signal,
    commitmentText,
    config,
    policy,
}) {
    if (!config?.openAiApiKey) {
        throw new Error(
            'erc1155-swap-fast-withdraw requires OPENAI_API_KEY to interpret free-text signed requests.'
        );
    }

    const payload = {
        model: config.openAiModel,
        input: [
            {
                role: 'system',
                content: [
                    'Interpret signed free-text user requests for the erc1155-swap-fast-withdraw commitment.',
                    'The only executable action is a fast withdrawal of the configured ERC1155 asset using the signer’s deposited USDC credit.',
                    `Configured ERC1155 token: ${policy.erc1155Token}.`,
                    `Configured ERC1155 tokenId: ${policy.erc1155TokenId}.`,
                    'Return strict JSON only.',
                    'If the text clearly requests a withdrawal and includes a recipient address, return {"action":"fast_withdraw_erc1155","recipient":"0x...","amount":"<positive integer string>"}.',
                    'If amount is omitted but the request is otherwise clear, default amount to "1".',
                    'If the request is not clearly a withdrawal instruction, or recipient/amount cannot be inferred confidently, return {"action":"ignore","reason":"..."}.',
                    'Never invent addresses. Never return anything except valid JSON.',
                ].join(' '),
            },
            {
                role: 'user',
                content: JSON.stringify({
                    commitment: commitmentText ?? '',
                    message: {
                        text: signal.text,
                        command: signal.command ?? null,
                        sender: signal.sender?.address ?? null,
                        requestId: signal.requestId,
                    },
                }),
            },
        ],
        text: { format: { type: 'json_object' } },
    };

    const response = await fetch(`${config.openAiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.openAiApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(
            Number.isFinite(Number(config?.openAiRequestTimeoutMs)) && Number(config.openAiRequestTimeoutMs) > 0
                ? Number(config.openAiRequestTimeoutMs)
                : 60_000
        ),
    });

    if (!response.ok) {
        const text = await response.text();
        throw createOpenAiHttpError(response.status, text);
    }

    const json = await response.json();
    const raw = extractFirstText(json);
    if (!raw) {
        throw createRetryableInterpretationError(
            'OpenAI returned an empty response while interpreting a free-text signed request.'
        );
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw createRetryableInterpretationError(
            `Failed to parse free-text interpretation JSON: ${raw}`
        );
    }

    const action =
        typeof parsed?.action === 'string' && parsed.action.trim()
            ? parsed.action.trim().toLowerCase()
            : '';
    if (action === 'ignore' || !action) {
        return null;
    }
    if (action !== 'fast_withdraw_erc1155') {
        throw createRetryableInterpretationError(
            `Unexpected free-text interpretation action: ${action}`
        );
    }

    let recipient;
    let amount;
    try {
        recipient = normalizeAddress(parsed.recipient);
        amount = normalizePositiveBigInt(parsed.amount ?? '1', 'interpreted signed request amount');
    } catch (error) {
        throw createRetryableInterpretationError(
            `Invalid free-text interpretation payload: ${error?.message ?? error}`
        );
    }

    return {
        action,
        args: {
            recipient,
            amount: amount.toString(),
            token: policy.erc1155Token,
            tokenId: policy.erc1155TokenId,
        },
        interpretedAtMs: Date.now(),
        text: signal.text,
    };
}

async function maybeInterpretFreeTextSignals({ signals, commitmentText, config, policy }) {
    let changed = false;
    for (const signal of Array.isArray(signals) ? signals : []) {
        if (!needsFreeTextInterpretation(signal, policy)) {
            continue;
        }

        const requestKey = getSignedRequestStateKey(signal);
        console.log(
            `[agent] Interpreting free-text signed request ${requestKey ?? signal.requestId ?? 'unknown'} via OpenAI.`
        );
        let interpreted;
        try {
            interpreted = await interpretFreeTextRequestSignal({
                signal,
                commitmentText,
                config,
                policy,
            });
        } catch (error) {
            console.warn(
                `[agent] Free-text interpretation failed for ${requestKey ?? signal.requestId ?? 'unknown'}: ${error?.message ?? error}`
            );
            throw error;
        }
        if (!interpreted || !requestKey) {
            console.warn(
                `[agent] Free-text signed request ${requestKey ?? signal.requestId ?? 'unknown'} was not interpreted as an executable ERC1155 withdrawal.`
            );
            continue;
        }

        swapState.interpretedRequests[requestKey] = interpreted;
        console.log(
            `[agent] Free-text signed request ${requestKey} interpreted: recipient=${interpreted.args.recipient} amount=${interpreted.args.amount}.`
        );
        changed = true;
    }

    if (changed) {
        markSwapStateDirty();
    }
    return changed;
}

function createSignedRequestOrder(signal, policy) {
    if (!isSignedUserMessage(signal)) {
        return null;
    }

    const command =
        typeof signal.command === 'string' && signal.command.trim()
            ? signal.command.trim().toLowerCase()
            : '';
    if (command && !policy.signedCommands.has(command)) {
        return null;
    }

    const originalArgs = getStructuredArgs(signal);
    const args = getResolvedSignedRequestArgs(signal);
    if (args.token !== undefined && !isAddressEqual(args.token, policy.erc1155Token)) {
        return null;
    }
    if (
        args.tokenId !== undefined &&
        normalizeNonNegativeBigInt(args.tokenId, 'signed request tokenId').toString() !==
            policy.erc1155TokenId
    ) {
        return null;
    }

    const recipientRaw = args.recipient ?? args.to;
    if (typeof recipientRaw !== 'string' || !recipientRaw.trim()) {
        return null;
    }

    const tokenAmount = parseSignedRequestAmount(args);
    const reimbursementAmountWei = tokenAmount * policy.usdcUnitAmountWei;
    const signer = normalizeAddress(signal.sender.address);

    return {
        orderId: buildSignedRequestOrderId(signer, signal.requestId),
        sourceKind: 'signed_request',
        sourceId: signal.requestId,
        requestId: signal.requestId,
        messageId: signal.messageId ?? null,
        signer,
        signature: signal.sender.signature,
        signedAtMs: signal.sender.signedAtMs,
        command: signal.command ?? null,
        text: signal.text ?? null,
        originalArgs: cloneJson(originalArgs),
        metadata: cloneJson(signal.metadata ?? null),
        deadline: signal.deadline ?? null,
        recipient: normalizeAddress(recipientRaw),
        tokenAmount: tokenAmount.toString(),
        reimbursementAmountWei: reimbursementAmountWei.toString(),
        archiveFilename: buildArtifactFilename(signal.requestId),
        createdAtMs: signal.receivedAtMs ?? Date.now(),
    };
}

function getDepositedCreditWeiForAddress(address) {
    let total = 0n;
    for (const deposit of Object.values(swapState.deposits)) {
        if (!deposit?.depositor || !isAddressEqual(deposit.depositor, address)) {
            continue;
        }
        total += BigInt(deposit.amountWei ?? 0);
    }
    return total;
}

function getReservedCreditWeiForAddress(address) {
    let total = 0n;
    for (const order of Object.values(swapState.orders)) {
        if (!order?.signer || !isAddressEqual(order.signer, address) || order?.creditReleasedAtMs) {
            continue;
        }
        total += BigInt(order.reservedCreditAmountWei ?? 0);
    }
    return total;
}

function getAvailableCreditWeiForAddress(address) {
    const available = getDepositedCreditWeiForAddress(address) - getReservedCreditWeiForAddress(address);
    return available > 0n ? available : 0n;
}

function buildCreditSnapshot() {
    const addresses = new Set();
    for (const deposit of Object.values(swapState.deposits)) {
        if (typeof deposit?.depositor === 'string' && deposit.depositor.trim()) {
            addresses.add(normalizeAddress(deposit.depositor));
        }
    }
    for (const order of Object.values(swapState.orders)) {
        if (typeof order?.signer === 'string' && order.signer.trim()) {
            addresses.add(normalizeAddress(order.signer));
        }
    }

    const snapshot = {};
    for (const address of addresses) {
        const depositedWei = getDepositedCreditWeiForAddress(address);
        const reservedWei = getReservedCreditWeiForAddress(address);
        const availableWei = depositedWei - reservedWei;
        snapshot[address] = {
            depositedWei: depositedWei.toString(),
            reservedWei: reservedWei.toString(),
            availableWei: (availableWei > 0n ? availableWei : 0n).toString(),
        };
    }
    return snapshot;
}

async function resolveInitialDepositBackfillStartBlock({
    publicClient,
    commitmentSafe,
    startBlock,
    latestBlock,
}) {
    if (startBlock !== undefined && startBlock !== null) {
        console.log(
            `[agent] Backfilling ERC20 deposit history from configured start block ${BigInt(startBlock).toString()}.`
        );
        return BigInt(startBlock);
    }

    try {
        const discovered = await findContractDeploymentBlock({
            publicClient,
            address: commitmentSafe,
            latestBlock,
        });
        if (discovered !== null) {
            console.log(
                `[agent] Backfilling ERC20 deposit history from Safe deployment block ${discovered.toString()}.`
            );
            return discovered;
        }
    } catch (error) {
        console.warn(
            '[agent] Failed to auto-discover Safe deployment block for deposit backfill; scanning from genesis.',
            error?.message ?? error
        );
    }

    return 0n;
}

function decodeProposalExplanationText(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    if (!value.startsWith('0x')) {
        return value.trim();
    }
    try {
        return hexToString(value).trim();
    } catch (error) {
        return null;
    }
}

function encodeExplanationFieldValue(value) {
    return encodeURIComponent(String(value ?? ''));
}

function decodeExplanationFieldValue(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }
    try {
        return decodeURIComponent(trimmed);
    } catch (error) {
        return trimmed;
    }
}

function parseReimbursementExplanationFields(explanation) {
    if (typeof explanation !== 'string' || !explanation.trim()) {
        return null;
    }

    const segments = explanation
        .split('|')
        .map((segment) => segment.trim())
        .filter(Boolean);
    if (segments[0] !== 'erc1155-swap-fast-withdraw reimbursement') {
        return null;
    }

    const fields = {};
    for (const segment of segments.slice(1)) {
        const separatorIndex = segment.indexOf('=');
        if (separatorIndex <= 0) {
            continue;
        }
        const key = segment.slice(0, separatorIndex).trim();
        const value = decodeExplanationFieldValue(segment.slice(separatorIndex + 1).trim());
        if (key) {
            fields[key] = value;
        }
    }
    return fields;
}

function buildHistoricalReimbursedOrder({ proposalHash, explanation, policy }) {
    const fields = parseReimbursementExplanationFields(explanation);
    if (!fields) {
        return null;
    }

    try {
        const signer = normalizeAddress(fields.signer);
        const reservedCreditWei = normalizePositiveBigInt(
            fields.reservedCreditWei ?? fields.reimbursementAmountWei,
            'historical reserved credit'
        );
        const tokenAmount = fields.amount
            ? normalizePositiveBigInt(fields.amount, 'historical token amount').toString()
            : '1';

        if (fields.token && !isAddressEqual(fields.token, policy.erc1155Token)) {
            return null;
        }
        if (fields.tokenId && String(fields.tokenId).trim() !== String(policy.erc1155TokenId).trim()) {
            return null;
        }

        let recipient = null;
        if (typeof fields.recipient === 'string' && fields.recipient.trim() && fields.recipient !== 'unknown') {
            recipient = normalizeAddress(fields.recipient);
        }
        const artifactUri =
            typeof fields.signedRequestCid === 'string' && fields.signedRequestCid.trim()
                ? fields.signedRequestCid.trim()
                : null;

        const orderId =
            typeof fields.order === 'string' && fields.order.trim()
                ? fields.order.trim()
                : `historical:${proposalHash}`;
        const requestId =
            typeof fields.requestId === 'string' &&
            fields.requestId.trim() &&
            fields.requestId.trim() !== 'n/a'
                ? fields.requestId.trim()
                : null;
        const nowMs = Date.now();

        return {
            orderId,
            requestId,
            signer,
            recipient,
            tokenAmount,
            reimbursementAmountWei: reservedCreditWei.toString(),
            reservedCreditAmountWei: reservedCreditWei.toString(),
            reimbursementProposalHash: proposalHash,
            reimbursementExplanation: explanation.trim(),
            artifactUri,
            sourceKind: 'historical_reimbursement',
            createdAtMs: nowMs,
            creditReservedAtMs: nowMs,
            directFillConfirmed: true,
            reimbursedAtMs: nowMs,
            lastUpdatedAtMs: nowMs,
            sequence: allocateSequence(),
        };
    } catch (error) {
        return null;
    }
}

async function backfillHistoricalReimbursements({
    publicClient,
    ogModule,
    commitmentSafe,
    fromBlock,
    latestBlock,
    policy,
}) {
    if (typeof ogModule !== 'string' || !ogModule.trim()) {
        return false;
    }

    const [proposalLogs, executedLogs] = await Promise.all([
        getLogsChunked({
            publicClient,
            address: ogModule,
            event: transactionsProposedEvent,
            fromBlock,
            toBlock: latestBlock,
            chunkSize: policy.logChunkSize,
        }),
        getLogsChunked({
            publicClient,
            address: ogModule,
            event: proposalExecutedEvent,
            fromBlock,
            toBlock: latestBlock,
            chunkSize: policy.logChunkSize,
        }),
    ]);

    const executedProposalHashes = new Set(
        executedLogs.map((log) => normalizeHashOrNull(log?.args?.proposalHash)).filter(Boolean)
    );
    if (executedProposalHashes.size === 0) {
        return false;
    }

    let rebuiltCount = 0;
    let changed = false;
    for (const log of proposalLogs) {
        const proposalHash = normalizeHashOrNull(log?.args?.proposalHash);
        if (!proposalHash || !executedProposalHashes.has(proposalHash)) {
            continue;
        }
        if (log?.args?.proposer && !isAddressEqual(log.args.proposer, policy.authorizedAgent)) {
            continue;
        }

        const explanation = decodeProposalExplanationText(log?.args?.explanation);
        const historicalOrder = buildHistoricalReimbursedOrder({
            proposalHash,
            explanation,
            policy,
        });
        if (!historicalOrder || swapState.orders[historicalOrder.orderId]) {
            continue;
        }

        swapState.orders[historicalOrder.orderId] = historicalOrder;
        rebuiltCount += 1;
        changed = true;
    }

    if (rebuiltCount > 0) {
        console.log(
            `[agent] Rebuilt ${rebuiltCount} historical reimbursed credit records for ${commitmentSafe}.`
        );
    }
    return changed;
}

async function maybeBackfillDeposits({
    publicClient,
    commitmentSafe,
    latestBlock,
    policy,
    config,
}) {
    if (swapState.backfilledDepositsThroughBlock !== null) {
        if (!depositBackfillStatusLogged) {
            console.log(
                `[agent] erc1155-swap-fast-withdraw credit backfill already complete through block ${swapState.backfilledDepositsThroughBlock}.`
            );
            depositBackfillStatusLogged = true;
        }
        return false;
    }

    const fromBlock = await resolveInitialDepositBackfillStartBlock({
        publicClient,
        commitmentSafe,
        startBlock: config?.startBlock,
        latestBlock,
    });
    console.log(
        `[agent] Starting erc1155-swap-fast-withdraw credit backfill for ${commitmentSafe} from block ${fromBlock.toString()} through ${latestBlock.toString()}.`
    );

    const logs = await getLogsChunked({
        publicClient,
        address: policy.paymentToken,
        event: transferEvent,
        args: { to: commitmentSafe },
        fromBlock,
        toBlock: latestBlock,
        chunkSize: policy.logChunkSize,
    });

    let changed = false;
    for (const log of logs) {
        let deposit = null;
        try {
            deposit = createDepositRecord(
                {
                    kind: 'erc20Deposit',
                    asset: policy.paymentToken,
                    from: log.args?.from,
                    amount: log.args?.value,
                    blockNumber: log.blockNumber,
                    transactionHash: log.transactionHash,
                    logIndex: log.logIndex,
                    id: log.transactionHash
                        ? `${log.transactionHash}:${log.logIndex ?? '0'}`
                        : `${log.blockNumber?.toString?.() ?? '0'}:${log.logIndex ?? '0'}`,
                },
                policy
            );
        } catch (error) {
            continue;
        }
        if (!deposit || swapState.deposits[deposit.depositKey]) {
            continue;
        }
        swapState.deposits[deposit.depositKey] = deposit;
        changed = true;
    }

    const rebuiltHistoricalReimbursements = await backfillHistoricalReimbursements({
        publicClient,
        ogModule: config?.ogModule,
        commitmentSafe,
        fromBlock,
        latestBlock,
        policy,
    });
    changed = rebuiltHistoricalReimbursements || changed;

    swapState.backfilledDepositsThroughBlock = latestBlock.toString();
    markSwapStateDirty();
    if (logs.length > 0) {
        console.log(
            `[agent] Rebuilt ${logs.length} historical ERC20 deposit credit records for ${commitmentSafe}.`
        );
    }
    console.log(
        `[agent] erc1155-swap-fast-withdraw credit backfill complete through block ${latestBlock.toString()}.`
    );
    depositBackfillStatusLogged = true;
    return changed;
}

function ingestSignals(signals, policy, config) {
    let changed = false;

    for (const signal of Array.isArray(signals) ? signals : []) {
        try {
            const deposit = createDepositRecord(signal, policy);
            if (deposit && !swapState.deposits[deposit.depositKey]) {
                swapState.deposits[deposit.depositKey] = deposit;
                console.log(
                    `[agent] Recorded ERC20 deposit credit for ${deposit.depositor}: amountWei=${deposit.amountWei} depositKey=${deposit.depositKey}.`
                );
                changed = true;
            }
        } catch (error) {
            continue;
        }
    }

    for (const signal of Array.isArray(signals) ? signals : []) {
        let order = null;
        try {
            order = createSignedRequestOrder(signal, policy);
        } catch (error) {
            continue;
        }
        if (!order || swapState.orders[order.orderId]) {
            continue;
        }
        const availableCreditWei = getAvailableCreditWeiForAddress(order.signer);
        if (availableCreditWei < BigInt(order.reimbursementAmountWei)) {
            console.warn(
                `[agent] Ignoring signed ERC1155 withdrawal request ${order.orderId}: insufficient deposited USDC credit for signer ${order.signer} (availableWei=${availableCreditWei.toString()} requiredWei=${order.reimbursementAmountWei}).`
            );
            continue;
        }
        if (!config?.ipfsEnabled) {
            throw new Error(
                'erc1155-swap-fast-withdraw requires IPFS_ENABLED=true to archive signed withdrawal requests before reserving deposited credit.'
            );
        }

        swapState.orders[order.orderId] = {
            ...order,
            reservedCreditAmountWei: order.reimbursementAmountWei,
            creditReservedAtMs: Date.now(),
            sequence: allocateSequence(),
            lastUpdatedAtMs: Date.now(),
        };
        console.log(
            `[agent] Accepted signed ERC1155 withdrawal request ${order.orderId}: reservedCreditWei=${order.reimbursementAmountWei} recipient=${order.recipient} amount=${order.tokenAmount}.`
        );
        changed = true;
    }

    if (changed) {
        markSwapStateDirty();
    }
    return changed;
}

function applyProposalEventUpdate({ executedProposals = [], deletedProposals = [] }) {
    const executedHashes = new Set(
        Array.isArray(executedProposals)
            ? executedProposals.map((value) => normalizeHashOrNull(value)).filter(Boolean)
            : []
    );
    const deletedHashes = new Set(
        Array.isArray(deletedProposals)
            ? deletedProposals.map((value) => normalizeHashOrNull(value)).filter(Boolean)
            : []
    );
    let changed = false;

    for (const order of Object.values(swapState.orders)) {
        const proposalHash = normalizeHashOrNull(order?.reimbursementProposalHash);
        if (!proposalHash) {
            continue;
        }

        if (executedHashes.has(proposalHash)) {
            order.reimbursedAtMs = Date.now();
            order.lastUpdatedAtMs = Date.now();
            changed = true;
            continue;
        }

        if (deletedHashes.has(proposalHash)) {
            delete order.reimbursementProposalHash;
            delete order.reimbursementSubmissionTxHash;
            delete order.reimbursementSubmittedAtMs;
            delete order.reimbursementExplanation;
            order.lastUpdatedAtMs = Date.now();
            changed = true;
        }
    }

    if (changed) {
        markSwapStateDirty();
    }
    return changed;
}

async function refreshDirectFillStatus({ publicClient, latestBlock, policy }) {
    let changed = false;
    const nowMs = Date.now();

    for (const order of Object.values(swapState.orders)) {
        if (!order?.directFillTxHash || order?.directFillConfirmed) {
            continue;
        }

        try {
            const receipt = await publicClient.getTransactionReceipt({
                hash: order.directFillTxHash,
            });
            const status = receipt?.status;
            const reverted = status === 0n || status === 0 || status === 'reverted';
            if (reverted) {
                delete order.directFillTxHash;
                delete order.directFillSubmittedAtMs;
                delete order.directFillBlockNumber;
                order.directFillConfirmations = 0;
                order.directFillConfirmed = false;
                order.lastUpdatedAtMs = Date.now();
                changed = true;
                continue;
            }

            const blockNumber = BigInt(receipt?.blockNumber ?? latestBlock);
            const confirmations =
                latestBlock >= blockNumber ? latestBlock - blockNumber + 1n : 1n;
            order.directFillBlockNumber = blockNumber.toString();
            order.directFillConfirmations = Number(confirmations);
            order.directFillConfirmed = confirmations >= policy.fillConfirmationThreshold;
            order.lastUpdatedAtMs = nowMs;
            changed = true;
        } catch (error) {
            if (!isReceiptUnavailableError(error)) {
                continue;
            }

            const submittedAtMs = Number(order.directFillSubmittedAtMs ?? 0);
            const pendingForMs = Math.max(0, nowMs - submittedAtMs);
            if (!Number.isFinite(submittedAtMs) || submittedAtMs <= 0 || pendingForMs < policy.pendingTxTimeoutMs) {
                continue;
            }

            delete order.directFillTxHash;
            delete order.directFillSubmittedAtMs;
            delete order.directFillBlockNumber;
            order.directFillConfirmations = 0;
            order.directFillConfirmed = false;
            order.lastUpdatedAtMs = nowMs;
            changed = true;
        }
    }

    if (changed) {
        markSwapStateDirty();
    }
    return changed;
}

async function refreshProposalSubmissionStatus({ publicClient, policy }) {
    let changed = false;
    const nowMs = Date.now();

    for (const order of Object.values(swapState.orders)) {
        if (!order?.reimbursementSubmissionTxHash || order?.reimbursementProposalHash) {
            continue;
        }

        try {
            const receipt = await publicClient.getTransactionReceipt({
                hash: order.reimbursementSubmissionTxHash,
            });
            const status = receipt?.status;
            const reverted = status === 0n || status === 0 || status === 'reverted';
            if (!reverted) {
                continue;
            }

            delete order.reimbursementSubmissionTxHash;
            delete order.reimbursementSubmittedAtMs;
            delete order.reimbursementExplanation;
            order.lastUpdatedAtMs = nowMs;
            changed = true;
        } catch (error) {
            if (!isReceiptUnavailableError(error)) {
                continue;
            }

            const submittedAtMs = Number(order.reimbursementSubmittedAtMs ?? 0);
            const pendingForMs = Math.max(0, nowMs - submittedAtMs);
            if (!Number.isFinite(submittedAtMs) || submittedAtMs <= 0 || pendingForMs < policy.pendingTxTimeoutMs) {
                continue;
            }

            delete order.reimbursementSubmissionTxHash;
            delete order.reimbursementSubmittedAtMs;
            delete order.reimbursementExplanation;
            order.lastUpdatedAtMs = nowMs;
            changed = true;
        }
    }

    if (changed) {
        markSwapStateDirty();
    }
    return changed;
}

function buildReimbursementExplanation(order, policy) {
    return [
        'erc1155-swap-fast-withdraw reimbursement',
        `order=${encodeExplanationFieldValue(order.orderId)}`,
        `requestId=${encodeExplanationFieldValue(order.requestId ?? 'n/a')}`,
        `signer=${encodeExplanationFieldValue(order.signer ?? 'unknown')}`,
        `signedRequestCid=${encodeExplanationFieldValue(order.artifactUri ?? 'missing')}`,
        `token=${encodeExplanationFieldValue(policy.erc1155Token)}`,
        `tokenId=${encodeExplanationFieldValue(policy.erc1155TokenId)}`,
        `amount=${encodeExplanationFieldValue(order.tokenAmount)}`,
        `reservedCreditWei=${encodeExplanationFieldValue(
            order.reservedCreditAmountWei ?? order.reimbursementAmountWei
        )}`,
        `recipient=${encodeExplanationFieldValue(order.recipient)}`,
        `directFillTx=${encodeExplanationFieldValue(order.directFillTxHash ?? 'pending')}`,
    ].join(' | ');
}

function matchesReimbursementProposalSignal({ signal, order, agentAddress, policy }) {
    if (signal?.kind !== 'proposal' || !Array.isArray(signal.transactions) || signal.transactions.length !== 1) {
        return false;
    }
    if (signal.proposer && !isAddressEqual(signal.proposer, agentAddress)) {
        return false;
    }
    // Once we have recorded a submitted proposal explanation, require an exact match.
    // Falling back to amount-only matching can alias same-sized reimbursements.
    if (order.reimbursementExplanation) {
        if (typeof signal.explanation !== 'string') {
            return false;
        }
        return signal.explanation.trim() === order.reimbursementExplanation;
    }

    const [transaction] = signal.transactions;
    if (!transaction?.to || !isAddressEqual(transaction.to, policy.paymentToken)) {
        return false;
    }
    if (BigInt(transaction.value ?? 0) !== 0n) {
        return false;
    }

    try {
        const decoded = decodeFunctionData({
            abi: erc20Abi,
            data: transaction.data,
        });
        if (decoded.functionName !== 'transfer') {
            return false;
        }
        const recipient = decoded.args?.[0];
        const amount = decoded.args?.[1];
        return (
            typeof recipient === 'string' &&
            isAddressEqual(recipient, agentAddress) &&
            BigInt(amount) === BigInt(order.reimbursementAmountWei)
        );
    } catch (error) {
        return false;
    }
}

function recoverProposalHashesFromSignals({ signals, agentAddress, policy }) {
    let changed = false;
    const pendingOrders = getOpenOrders().filter(
        (order) =>
            order.directFillConfirmed &&
            order.reimbursementSubmissionTxHash &&
            !order.reimbursementProposalHash
    );
    if (pendingOrders.length === 0) {
        return false;
    }

    for (const signal of Array.isArray(signals) ? signals : []) {
        const proposalHash = normalizeHashOrNull(signal?.proposalHash);
        if (!proposalHash) {
            continue;
        }
        for (const order of pendingOrders) {
            if (order.reimbursementProposalHash) {
                continue;
            }
            if (!matchesReimbursementProposalSignal({ signal, order, agentAddress, policy })) {
                continue;
            }
            order.reimbursementProposalHash = proposalHash;
            order.lastUpdatedAtMs = Date.now();
            changed = true;
        }
    }

    if (changed) {
        markSwapStateDirty();
    }
    return changed;
}

function getInventoryCandidateOrders() {
    return getOpenOrders().filter((order) => order.artifactUri && !order.directFillTxHash);
}

function getPendingDirectFillReservedTokenAmount() {
    let total = 0n;
    for (const order of getOpenOrders()) {
        if (!order?.directFillTxHash || order?.directFillConfirmed) {
            continue;
        }
        // Once a receipt has anchored the transfer to a block, the on-chain balance already
        // reflects the outgoing inventory. Reserve only fills that are still unanchored.
        if (order.directFillBlockNumber !== undefined && order.directFillBlockNumber !== null) {
            continue;
        }
        total += BigInt(order.tokenAmount ?? 0);
    }
    return total;
}

function getPendingSafeReimbursementReservedWei(excludeOrderId = null) {
    let total = 0n;
    for (const order of getOpenOrders()) {
        if (!order?.directFillTxHash) {
            continue;
        }
        if (excludeOrderId && order.orderId === excludeOrderId) {
            continue;
        }
        total += BigInt(order.reimbursementAmountWei ?? 0);
    }
    return total;
}

function getReimbursementCandidateOrders() {
    return getOpenOrders().filter(
        (order) =>
            order.artifactUri &&
            order.directFillConfirmed &&
            !order.reimbursementProposalHash &&
            !order.reimbursementSubmissionTxHash
    );
}

function getOrdersAwaitingArchive() {
    return getOpenOrders().filter(
        (order) =>
            !order.artifactUri &&
            !order.reimbursementProposalHash &&
            !order.reimbursementSubmissionTxHash
    );
}

function getArchiveCandidateOrders(policy) {
    const nowMs = Date.now();
    return getOrdersAwaitingArchive().filter(
        (order) =>
            (!order.nextArchiveAttemptAtMs ||
                Number(order.nextArchiveAttemptAtMs) <= nowMs ||
                !Number.isFinite(Number(order.nextArchiveAttemptAtMs)))
    );
}

function buildArchiveToolCall(order, commitmentSafe, agentAddress) {
    return {
        callId: `archive-${order.sequence}`,
        name: 'ipfs_publish',
        arguments: JSON.stringify({
            json: buildSignedRequestArchiveArtifact({
                order,
                commitmentSafe,
                agentAddress,
            }),
            filename: order.archiveFilename,
            pin: true,
        }),
    };
}

function buildDirectFillToolCall(order, policy) {
    return {
        callId: `erc1155-transfer-${order.sequence}`,
        name: 'make_erc1155_transfer',
        arguments: JSON.stringify({
            token: policy.erc1155Token,
            recipient: order.recipient,
            tokenId: policy.erc1155TokenId,
            amount: order.tokenAmount,
            data: '0x',
        }),
    };
}

function buildReimbursementToolCall(order, policy, agentAddress) {
    const explanation = buildReimbursementExplanation(order, policy);
    const transactions = buildOgTransactions([
        {
            kind: 'erc20_transfer',
            token: policy.paymentToken,
            to: agentAddress,
            amountWei: order.reimbursementAmountWei,
        },
    ]);

    return {
        callId: `reimburse-${order.sequence}`,
        name: 'post_bond_and_propose',
        arguments: {
            transactions,
            explanation,
        },
        explanation,
    };
}

async function getDeterministicToolCalls({
    signals,
    commitmentText,
    commitmentSafe,
    agentAddress,
    publicClient,
    config,
    onchainPendingProposal = false,
}) {
    await configureRuntimeStateContext({ publicClient, commitmentSafe, config });
    await hydrateSwapState();

    const policy = resolvePolicy(config);
    const normalizedSafeAddress = normalizeAddress(commitmentSafe);
    const normalizedAgentAddress = normalizeAddress(agentAddress);
    if (!isAddressEqual(normalizedAgentAddress, policy.authorizedAgent)) {
        throw new Error(
            `erc1155-swap-fast-withdraw may only be served by authorized agent ${policy.authorizedAgent}.`
        );
    }
    const latestBlock = await publicClient.getBlockNumber();

    while (queuedProposalEventUpdates.length > 0) {
        applyProposalEventUpdate(queuedProposalEventUpdates.shift());
    }
    await maybeBackfillDeposits({
        publicClient,
        commitmentSafe: normalizedSafeAddress,
        latestBlock,
        policy,
        config,
    });
    await maybeInterpretFreeTextSignals({
        signals,
        commitmentText,
        config,
        policy,
    });
    ingestSignals(signals, policy, config);
    await refreshDirectFillStatus({
        publicClient,
        latestBlock,
        policy,
    });
    await refreshProposalSubmissionStatus({ publicClient, policy });
    recoverProposalHashesFromSignals({
        signals,
        agentAddress: normalizedAgentAddress,
        policy,
    });
    await maybePersistSwapState();

    if (!config?.ipfsEnabled && getOrdersAwaitingArchive().length > 0) {
        throw new Error(
            'erc1155-swap-fast-withdraw requires IPFS_ENABLED=true to continue signed withdrawal orders awaiting IPFS archival.'
        );
    }

    for (const order of getArchiveCandidateOrders(policy)) {
        if (!config?.ipfsEnabled) {
            continue;
        }

        const nowMs = Date.now();
        order.archiveAttemptCount = Number(order.archiveAttemptCount ?? 0) + 1;
        order.lastArchiveAttemptAtMs = nowMs;
        order.nextArchiveAttemptAtMs = nowMs + policy.archiveRetryDelayMs;
        order.lastUpdatedAtMs = nowMs;
        markSwapStateDirty();
        await maybePersistSwapState();
        console.log(
            `[agent] Preparing signed request archive for order ${order.orderId} (attempt=${order.archiveAttemptCount} retryDelayMs=${policy.archiveRetryDelayMs}).`
        );
        pendingArtifactPublish = {
            orderId: order.orderId,
            filename: order.archiveFilename,
        };
        return [buildArchiveToolCall(order, normalizedSafeAddress, normalizedAgentAddress)];
    }

    const [agentTokenBalance, safePaymentBalance] = await Promise.all([
        publicClient.readContract({
            address: policy.erc1155Token,
            abi: erc1155Abi,
            functionName: 'balanceOf',
            args: [normalizedAgentAddress, BigInt(policy.erc1155TokenId)],
        }),
        publicClient.readContract({
            address: policy.paymentToken,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [normalizedSafeAddress],
        }),
    ]);
    let availableAgentTokenBalance =
        BigInt(agentTokenBalance) - getPendingDirectFillReservedTokenAmount();
    if (availableAgentTokenBalance < 0n) {
        availableAgentTokenBalance = 0n;
    }
    let availableSafePaymentBalance =
        BigInt(safePaymentBalance) - getPendingSafeReimbursementReservedWei();
    if (availableSafePaymentBalance < 0n) {
        availableSafePaymentBalance = 0n;
    }

    for (const order of getInventoryCandidateOrders()) {
        if (availableAgentTokenBalance < BigInt(order.tokenAmount)) {
            continue;
        }
        if (availableSafePaymentBalance < BigInt(order.reimbursementAmountWei)) {
            continue;
        }

        console.log(
            `[agent] Preparing direct ERC1155 fill for order ${order.orderId}.`
        );
        pendingDirectFill = {
            orderId: order.orderId,
            fillConfirmationThreshold: policy.fillConfirmationThreshold,
        };
        return [buildDirectFillToolCall(order, policy)];
    }

    if (onchainPendingProposal) {
        return [];
    }

    for (const order of getReimbursementCandidateOrders()) {
        let availableSafePaymentBalanceForOrder =
            BigInt(safePaymentBalance) -
            getPendingSafeReimbursementReservedWei(order.orderId);
        if (availableSafePaymentBalanceForOrder < 0n) {
            availableSafePaymentBalanceForOrder = 0n;
        }
        if (availableSafePaymentBalanceForOrder < BigInt(order.reimbursementAmountWei)) {
            continue;
        }

        console.log(
            `[agent] Preparing reimbursement proposal for order ${order.orderId}.`
        );
        const reimbursementCall = buildReimbursementToolCall(
            order,
            policy,
            normalizedAgentAddress
        );
        pendingProposal = {
            orderId: order.orderId,
            explanation: reimbursementCall.explanation,
        };
        return [
            {
                callId: reimbursementCall.callId,
                name: reimbursementCall.name,
                arguments: JSON.stringify(reimbursementCall.arguments),
            },
        ];
    }

    return [];
}

async function onToolOutput({ name, parsedOutput }) {
    await hydrateSwapState();

    if (name === 'ipfs_publish') {
        const pending = pendingArtifactPublish;
        pendingArtifactPublish = null;
        if (!pending) {
            console.warn('[agent] Received ipfs_publish tool output with no pending archive request.');
            return;
        }

        const order = swapState.orders[pending.orderId];
        if (!order) {
            console.warn(
                `[agent] Received ipfs_publish tool output for unknown order ${pending.orderId}.`
            );
            return;
        }

        if (!parsedOutput || parsedOutput.status !== 'published') {
            const status =
                typeof parsedOutput?.status === 'string' && parsedOutput.status.trim()
                    ? parsedOutput.status.trim()
                    : 'unknown';
            const detail =
                typeof parsedOutput?.message === 'string' && parsedOutput.message.trim()
                    ? parsedOutput.message.trim()
                    : typeof parsedOutput?.reason === 'string' && parsedOutput.reason.trim()
                        ? parsedOutput.reason.trim()
                        : `tool returned status=${status}`;
            order.lastArchiveError = detail;
            order.lastArchiveErrorStatus = status;
            order.lastArchiveErrorRetryable = parsedOutput?.retryable === true;
            order.lastArchiveErrorAtMs = Date.now();
            order.lastUpdatedAtMs = Date.now();
            markSwapStateDirty();
            await persistSwapState();
            console.warn(
                `[agent] Signed request archive failed for order ${pending.orderId}: status=${status} retryable=${parsedOutput?.retryable === true} detail=${detail}.`
            );
            if (typeof order.nextArchiveAttemptAtMs === 'number') {
                console.warn(
                    `[agent] Archive retry for ${pending.orderId} deferred until ${order.nextArchiveAttemptAtMs}.`
                );
            }
            return;
        }

        const cid =
            typeof parsedOutput.cid === 'string' && parsedOutput.cid.trim()
                ? parsedOutput.cid.trim()
                : null;
        const uri =
            typeof parsedOutput.uri === 'string' && parsedOutput.uri.trim()
                ? parsedOutput.uri.trim()
                : cid
                    ? `ipfs://${cid}`
                    : null;

        order.archiveFilename = pending.filename ?? order.archiveFilename ?? null;
        order.artifactCid = cid ?? order.artifactCid ?? null;
        order.artifactUri = uri ?? order.artifactUri ?? null;
        order.artifactPublishedAtMs = Date.now();
        order.lastArchiveError = null;
        order.lastArchiveErrorStatus = null;
        order.lastArchiveErrorRetryable = null;
        order.lastArchiveErrorAtMs = null;
        order.nextArchiveAttemptAtMs = null;
        order.lastUpdatedAtMs = Date.now();
        markSwapStateDirty();
        await persistSwapState();
        console.log(
            `[agent] Signed request archive published for order ${pending.orderId}: uri=${order.artifactUri}.`
        );
        return;
    }

    if (name === 'make_erc1155_transfer') {
        const pending = pendingDirectFill;
        pendingDirectFill = null;
        if (!pending) return;
        if (!parsedOutput || (parsedOutput.status !== 'confirmed' && parsedOutput.status !== 'submitted')) {
            return;
        }

        const order = swapState.orders[pending.orderId];
        if (!order) {
            return;
        }

        order.directFillTxHash = parsedOutput.transactionHash ?? order.directFillTxHash ?? null;
        order.directFillSubmittedAtMs = Date.now();
        order.directFillConfirmations = parsedOutput.status === 'confirmed' ? 1 : 0;
        order.directFillConfirmed =
            parsedOutput.status === 'confirmed' && pending.fillConfirmationThreshold <= 1n;
        order.lastUpdatedAtMs = Date.now();
        markSwapStateDirty();
        await persistSwapState();
        return;
    }

    if (name === 'post_bond_and_propose' || name === 'auto_post_bond_and_propose') {
        const pending = pendingProposal;
        pendingProposal = null;
        if (!pending) return;
        if (!parsedOutput || parsedOutput.status !== 'submitted') {
            return;
        }

        const order = swapState.orders[pending.orderId];
        if (!order) {
            return;
        }

        order.reimbursementExplanation = pending.explanation;
        order.reimbursementSubmissionTxHash =
            parsedOutput.transactionHash ?? order.reimbursementSubmissionTxHash ?? null;
        order.reimbursementProposalHash =
            normalizeHashOrNull(parsedOutput.ogProposalHash) ??
            normalizeHashOrNull(order.reimbursementProposalHash);
        order.reimbursementSubmittedAtMs = Date.now();
        order.lastUpdatedAtMs = Date.now();
        markSwapStateDirty();
        await persistSwapState();
    }
}

async function onProposalEvents({ executedProposals = [], deletedProposals = [] }) {
    const hasExecuted = Array.isArray(executedProposals) && executedProposals.length > 0;
    const hasDeleted = Array.isArray(deletedProposals) && deletedProposals.length > 0;
    if (!hasExecuted && !hasDeleted) {
        return;
    }
    if (!swapStateHydrated) {
        queuedProposalEventUpdates.push({
            executedProposals: cloneJson(executedProposals),
            deletedProposals: cloneJson(deletedProposals),
        });
        return;
    }
    const changed = applyProposalEventUpdate({ executedProposals, deletedProposals });
    if (!changed) {
        return;
    }
    try {
        await persistSwapState();
    } catch (error) {
        console.warn(
            '[erc1155-swap-fast-withdraw] Failed to persist proposal event update:',
            error?.message ?? error
        );
    }
}

async function getSwapState() {
    await hydrateSwapState();
    return cloneJson({
        version: STATE_VERSION,
        nextSequence: swapState.nextSequence,
        orders: swapState.orders,
        deposits: swapState.deposits,
        backfilledDepositsThroughBlock: swapState.backfilledDepositsThroughBlock,
        interpretedRequests: swapState.interpretedRequests,
        credits: buildCreditSnapshot(),
    });
}

async function resetSwapState() {
    const shouldDeleteStateFile =
        (typeof statePathOverride === 'string' && statePathOverride.trim()) ||
        (typeof runtimeStatePath === 'string' && runtimeStatePath.trim());
    const statePath = shouldDeleteStateFile ? getStatePath() : null;
    resetInMemoryState({ hydrated: true });
    if (statePath) {
        await unlink(statePath).catch(() => {});
    }
}

function setSwapStatePathForTest(nextPath) {
    statePathOverride = typeof nextPath === 'string' && nextPath.trim() ? nextPath : null;
    runtimeStatePath = null;
    runtimeStateNamespaceKey = null;
    resetInMemoryState();
}

const getPollingOptions = getAlwaysEmitBalanceSnapshotPollingOptions;

export {
    getDeterministicToolCalls,
    getPollingOptions,
    getSwapState,
    onProposalEvents,
    onToolOutput,
    resetSwapState,
    setSwapStatePathForTest,
};
