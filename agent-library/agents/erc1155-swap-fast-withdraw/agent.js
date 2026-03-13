import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, erc20Abi, erc1155Abi, getAddress, isAddressEqual } from 'viem';
import { getAlwaysEmitBalanceSnapshotPollingOptions } from '../../../agent/src/lib/polling.js';
import { buildOgTransactions } from '../../../agent/src/lib/tx.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_VERSION = 1;
const DEFAULT_USDC_UNIT_AMOUNT_WEI = 1_000_000n;
const DEFAULT_FILL_CONFIRMATION_THRESHOLD = 1n;
const DEFAULT_SIGNED_COMMANDS = ['fast_withdraw', 'fast_withdraw_erc1155'];
const DEFAULT_PENDING_TX_TIMEOUT_MS = 900_000;

const swapState = {
    nextSequence: 1,
    orders: {},
};

let swapStateHydrated = false;
let swapStateDirty = false;
let statePathOverride = null;
let pendingDirectFill = null;
let pendingProposal = null;
const queuedProposalEventUpdates = [];

function getStatePath() {
    if (typeof statePathOverride === 'string' && statePathOverride.trim()) {
        return path.resolve(statePathOverride.trim());
    }
    return path.join(__dirname, '.swap-state.json');
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
            (order) => !order?.reimbursedAtMs && !order?.closedAtMs
        )
    );
}

function allocateSequence() {
    const nextSequence = Number(swapState.nextSequence ?? 1);
    swapState.nextSequence = nextSequence + 1;
    swapStateDirty = true;
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
        }
    } catch (error) {
        swapState.nextSequence = 1;
        swapState.orders = {};
    }
    swapStateDirty = false;
}

async function persistSwapState() {
    const payload = JSON.stringify(
        {
            version: STATE_VERSION,
            nextSequence: swapState.nextSequence,
            orders: swapState.orders,
        },
        null,
        2
    );
    await writeFile(getStatePath(), payload, 'utf8');
    swapStateDirty = false;
}

async function maybePersistSwapState() {
    if (!swapStateDirty) return;
    await persistSwapState();
}

function createPaymentOrder(signal, policy) {
    if (signal?.kind !== 'erc20Deposit') {
        return null;
    }
    if (!signal.asset || !isAddressEqual(signal.asset, policy.paymentToken)) {
        return null;
    }
    if (typeof signal.from !== 'string' || !signal.from.trim()) {
        return null;
    }

    const reimbursementAmountWei = normalizePositiveBigInt(signal.amount, 'payment amount');
    if (reimbursementAmountWei % policy.usdcUnitAmountWei !== 0n) {
        return null;
    }

    const tokenAmount = reimbursementAmountWei / policy.usdcUnitAmountWei;
    if (tokenAmount <= 0n) {
        return null;
    }

    return {
        orderId: `payment:${signal.id}`,
        sourceKind: 'payment',
        sourceId: signal.id,
        paymentTransactionHash: signal.transactionHash ?? null,
        paymentLogIndex: signal.logIndex ?? null,
        payer: normalizeAddress(signal.from),
        recipient: normalizeAddress(signal.from),
        tokenAmount: tokenAmount.toString(),
        reimbursementAmountWei: reimbursementAmountWei.toString(),
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

    const args = signal.args && typeof signal.args === 'object' && !Array.isArray(signal.args)
        ? signal.args
        : {};
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

    return {
        orderId: `request:${signal.requestId}`,
        sourceKind: 'signed_request',
        sourceId: signal.requestId,
        requestId: signal.requestId,
        messageId: signal.messageId ?? null,
        signer: normalizeAddress(signal.sender.address),
        signature: signal.sender.signature,
        signedAtMs: signal.sender.signedAtMs,
        command: signal.command ?? null,
        text: signal.text ?? null,
        recipient: normalizeAddress(recipientRaw),
        tokenAmount: tokenAmount.toString(),
        reimbursementAmountWei: reimbursementAmountWei.toString(),
        createdAtMs: signal.receivedAtMs ?? Date.now(),
    };
}

function ingestSignals(signals, policy) {
    let changed = false;

    for (const signal of Array.isArray(signals) ? signals : []) {
        let order = null;
        try {
            order = createPaymentOrder(signal, policy) ?? createSignedRequestOrder(signal, policy);
        } catch (error) {
            continue;
        }
        if (!order || swapState.orders[order.orderId]) {
            continue;
        }

        swapState.orders[order.orderId] = {
            ...order,
            sequence: allocateSequence(),
            lastUpdatedAtMs: Date.now(),
        };
        changed = true;
    }

    if (changed) {
        swapStateDirty = true;
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
        swapStateDirty = true;
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
        swapStateDirty = true;
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
        swapStateDirty = true;
    }
    return changed;
}

function buildReimbursementExplanation(order, policy) {
    return [
        'erc1155-swap-fast-withdraw reimbursement',
        `order=${order.orderId}`,
        `token=${policy.erc1155Token}`,
        `tokenId=${policy.erc1155TokenId}`,
        `amount=${order.tokenAmount}`,
        `recipient=${order.recipient}`,
        `directFillTx=${order.directFillTxHash ?? 'pending'}`,
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
            if (!matchesReimbursementProposalSignal({ signal, order, agentAddress, policy })) {
                continue;
            }
            order.reimbursementProposalHash = proposalHash;
            order.lastUpdatedAtMs = Date.now();
            changed = true;
        }
    }

    if (changed) {
        swapStateDirty = true;
    }
    return changed;
}

function getInventoryCandidateOrders() {
    return getOpenOrders().filter((order) => !order.directFillTxHash);
}

function getReimbursementCandidateOrders() {
    return getOpenOrders().filter(
        (order) =>
            order.directFillConfirmed &&
            !order.reimbursementProposalHash &&
            !order.reimbursementSubmissionTxHash
    );
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
    commitmentSafe,
    agentAddress,
    publicClient,
    config,
    onchainPendingProposal = false,
}) {
    await hydrateSwapState();

    const policy = resolvePolicy(config);
    const normalizedSafeAddress = normalizeAddress(commitmentSafe);
    const normalizedAgentAddress = normalizeAddress(agentAddress);
    const latestBlock = await publicClient.getBlockNumber();

    while (queuedProposalEventUpdates.length > 0) {
        applyProposalEventUpdate(queuedProposalEventUpdates.shift());
    }
    ingestSignals(signals, policy);
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

    const agentTokenBalance = await publicClient.readContract({
        address: policy.erc1155Token,
        abi: erc1155Abi,
        functionName: 'balanceOf',
        args: [normalizedAgentAddress, BigInt(policy.erc1155TokenId)],
    });

    for (const order of getInventoryCandidateOrders()) {
        if (BigInt(agentTokenBalance) < BigInt(order.tokenAmount)) {
            continue;
        }

        pendingDirectFill = {
            orderId: order.orderId,
            fillConfirmationThreshold: policy.fillConfirmationThreshold,
        };
        return [buildDirectFillToolCall(order, policy)];
    }

    if (onchainPendingProposal) {
        return [];
    }

    const safePaymentBalance = await publicClient.readContract({
        address: policy.paymentToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [normalizedSafeAddress],
    });

    for (const order of getReimbursementCandidateOrders()) {
        if (BigInt(safePaymentBalance) < BigInt(order.reimbursementAmountWei)) {
            continue;
        }

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
        swapStateDirty = true;
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
        swapStateDirty = true;
        await persistSwapState();
    }
}

function onProposalEvents({ executedProposals = [], deletedProposals = [] }) {
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
    applyProposalEventUpdate({ executedProposals, deletedProposals });
}

async function getSwapState() {
    await hydrateSwapState();
    return cloneJson({
        version: STATE_VERSION,
        nextSequence: swapState.nextSequence,
        orders: swapState.orders,
    });
}

async function resetSwapState() {
    swapState.nextSequence = 1;
    swapState.orders = {};
    swapStateHydrated = true;
    swapStateDirty = false;
    pendingDirectFill = null;
    pendingProposal = null;
    queuedProposalEventUpdates.length = 0;
    await unlink(getStatePath()).catch(() => {});
}

function setSwapStatePathForTest(nextPath) {
    statePathOverride = typeof nextPath === 'string' && nextPath.trim() ? nextPath : null;
    swapState.nextSequence = 1;
    swapState.orders = {};
    swapStateHydrated = false;
    swapStateDirty = false;
    pendingDirectFill = null;
    pendingProposal = null;
    queuedProposalEventUpdates.length = 0;
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
