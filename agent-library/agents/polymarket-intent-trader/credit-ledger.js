import { getAddress, isAddressEqual } from 'viem';
import { normalizeHashOrNull } from '../../../agent/src/lib/utils.js';

function normalizeAddress(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('Address must be a non-empty string.');
    }
    return getAddress(value.trim()).toLowerCase();
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

export function createDepositRecord(signal, { collateralToken, nowMs = Date.now() } = {}) {
    if (signal?.kind !== 'erc20Deposit') {
        return null;
    }
    if (!signal.asset || !isAddressEqual(signal.asset, collateralToken)) {
        return null;
    }
    if (typeof signal.from !== 'string' || !signal.from.trim()) {
        return null;
    }

    const amountWei = normalizePositiveBigInt(signal.amount, 'collateral amount');
    const transactionHash = normalizeHashOrNull(signal.transactionHash);
    const logIndex =
        signal.logIndex === undefined || signal.logIndex === null ? null : String(signal.logIndex);
    const signalId =
        typeof signal.id === 'string' && signal.id.trim() ? signal.id.trim() : null;
    const depositKey =
        transactionHash && logIndex !== null
            ? `tx:${transactionHash}:${logIndex}`
            : signalId
                ? `signal:${signalId}`
                : null;
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
        createdAtMs: nowMs,
    };
}

export function createReimbursementCommitmentRecord(
    signal,
    { proposalHash, nowMs = Date.now() } = {}
) {
    if (typeof signal?.signer !== 'string' || !signal.signer.trim()) {
        return null;
    }

    const amountWei = normalizePositiveBigInt(signal.amountWei, 'reimbursement amount');
    const normalizedProposalHash = normalizeHashOrNull(signal.proposalHash ?? proposalHash);
    if (!normalizedProposalHash) {
        return null;
    }

    return {
        commitmentKey: `proposal:${normalizedProposalHash}`,
        proposalHash: normalizedProposalHash,
        intentKey:
            typeof signal.intentKey === 'string' && signal.intentKey.trim()
                ? signal.intentKey.trim()
                : null,
        signer: normalizeAddress(signal.signer),
        recipientAddress: normalizeAddress(signal.recipientAddress),
        amountWei: amountWei.toString(),
        status:
            typeof signal.status === 'string' && signal.status.trim()
                ? signal.status.trim()
                : 'proposed',
        createdAtMs: nowMs,
    };
}

export function getDepositedCreditWeiForAddress(state, address) {
    let total = 0n;
    for (const deposit of Object.values(state?.deposits ?? {})) {
        if (!deposit?.depositor || !isAddressEqual(deposit.depositor, address)) {
            continue;
        }
        total += BigInt(deposit.amountWei ?? 0);
    }
    return total;
}

export function getTotalDepositedCreditWei(state) {
    let total = 0n;
    for (const deposit of Object.values(state?.deposits ?? {})) {
        total += BigInt(deposit?.amountWei ?? 0);
    }
    return total;
}

function hasMatchingIntentReservation(state, commitment) {
    const normalizedIntentKey =
        typeof commitment?.intentKey === 'string' && commitment.intentKey.trim()
            ? commitment.intentKey.trim()
            : null;
    const normalizedProposalHash = normalizeHashOrNull(commitment?.proposalHash);

    for (const intent of Object.values(state?.intents ?? {})) {
        if (!intent || typeof intent !== 'object') {
            continue;
        }
        if (normalizedIntentKey && intent.intentKey === normalizedIntentKey) {
            return true;
        }
        if (
            normalizedProposalHash &&
            normalizeHashOrNull(intent.reimbursementProposalHash) === normalizedProposalHash
        ) {
            return true;
        }
    }

    return false;
}

export function getReservedCreditWeiForAddress(state, address) {
    let total = 0n;
    for (const intent of Object.values(state?.intents ?? {})) {
        if (!intent?.signer || !isAddressEqual(intent.signer, address) || intent?.creditReleasedAtMs) {
            continue;
        }
        total += BigInt(intent.reservedCreditAmountWei ?? 0);
    }
    for (const commitment of Object.values(state?.reimbursementCommitments ?? {})) {
        if (!commitment?.signer || !isAddressEqual(commitment.signer, address)) {
            continue;
        }
        if (commitment.status === 'deleted') {
            continue;
        }
        if (hasMatchingIntentReservation(state, commitment)) {
            continue;
        }
        total += BigInt(commitment.amountWei ?? 0);
    }
    return total;
}

export function getTotalReservedCreditWei(state) {
    let total = 0n;
    for (const intent of Object.values(state?.intents ?? {})) {
        if (!intent?.signer || intent?.creditReleasedAtMs) {
            continue;
        }
        total += BigInt(intent.reservedCreditAmountWei ?? 0);
    }
    for (const commitment of Object.values(state?.reimbursementCommitments ?? {})) {
        if (!commitment?.signer || commitment.status === 'deleted') {
            continue;
        }
        if (hasMatchingIntentReservation(state, commitment)) {
            continue;
        }
        total += BigInt(commitment.amountWei ?? 0);
    }
    return total;
}

export function getAvailableCreditWeiForAddress(state, address) {
    const available =
        getDepositedCreditWeiForAddress(state, address) -
        getReservedCreditWeiForAddress(state, address);
    return available > 0n ? available : 0n;
}

function collectTrackedCreditAddresses(state) {
    const addresses = new Set();
    for (const deposit of Object.values(state?.deposits ?? {})) {
        if (typeof deposit?.depositor === 'string' && deposit.depositor.trim()) {
            addresses.add(normalizeAddress(deposit.depositor));
        }
    }
    for (const intent of Object.values(state?.intents ?? {})) {
        if (typeof intent?.signer === 'string' && intent.signer.trim()) {
            addresses.add(normalizeAddress(intent.signer));
        }
    }
    for (const commitment of Object.values(state?.reimbursementCommitments ?? {})) {
        if (typeof commitment?.signer === 'string' && commitment.signer.trim()) {
            addresses.add(normalizeAddress(commitment.signer));
        }
    }
    return addresses;
}

export function buildCreditSnapshot(state) {
    const addresses = collectTrackedCreditAddresses(state);
    const snapshot = {};
    for (const address of addresses) {
        const depositedWei = getDepositedCreditWeiForAddress(state, address);
        const reservedWei = getReservedCreditWeiForAddress(state, address);
        const availableWei = depositedWei - reservedWei;
        snapshot[address] = {
            depositedWei: depositedWei.toString(),
            reservedWei: reservedWei.toString(),
            availableWei: (availableWei > 0n ? availableWei : 0n).toString(),
        };
    }
    return snapshot;
}

export function buildCollateralCreditSummary(
    state,
    { actualCollateralBalanceWei = null } = {}
) {
    const modeledDepositedWei = getTotalDepositedCreditWei(state);
    const modeledReservedWei = getTotalReservedCreditWei(state);
    const modeledAvailableWei =
        modeledDepositedWei > modeledReservedWei ? modeledDepositedWei - modeledReservedWei : 0n;
    const normalizedActualCollateralBalanceWei =
        actualCollateralBalanceWei === null || actualCollateralBalanceWei === undefined
            ? null
            : BigInt(actualCollateralBalanceWei);
    const actualAvailableWei =
        normalizedActualCollateralBalanceWei === null
            ? null
            : normalizedActualCollateralBalanceWei > modeledReservedWei
                ? normalizedActualCollateralBalanceWei - modeledReservedWei
                : 0n;
    const shortfallWei =
        actualAvailableWei === null
            ? null
            : modeledAvailableWei > actualAvailableWei
                ? modeledAvailableWei - actualAvailableWei
                : 0n;

    return {
        modeledDepositedWei: modeledDepositedWei.toString(),
        modeledReservedWei: modeledReservedWei.toString(),
        modeledAvailableWei: modeledAvailableWei.toString(),
        actualCollateralBalanceWei:
            normalizedActualCollateralBalanceWei === null
                ? null
                : normalizedActualCollateralBalanceWei.toString(),
        actualAvailableWei: actualAvailableWei === null ? null : actualAvailableWei.toString(),
        shortfallWei: shortfallWei === null ? null : shortfallWei.toString(),
    };
}
