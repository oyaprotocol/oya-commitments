import { decodeEventLog } from 'viem';
import { transactionsProposedEvent } from '../../../agent/src/lib/og.js';
import { normalizeHashOrNull } from '../../../agent/src/lib/utils.js';
import { markMarketDirty, mergeTradeClassifications } from './trade-ledger.js';

function isSuccessishToolStatus(parsedOutput) {
    const status = String(parsedOutput?.status ?? '').trim().toLowerCase();
    return (
        status === 'published' ||
        status === 'duplicate' ||
        status === 'submitted' ||
        status === 'confirmed' ||
        status === 'pending'
    );
}

function findMarketByPendingPublication(state, requestId) {
    return Object.values(state.markets ?? {}).find(
        (market) => market.pendingPublication?.requestId === requestId
    );
}

function findMarketByPendingDeposit(state) {
    return Object.values(state.markets ?? {}).find(
        (market) =>
            Number.isInteger(market.settlement?.depositDispatchAtMs) &&
            !market.settlement?.depositTxHash
    );
}

function findMarketByPendingReimbursement(state) {
    return Object.values(state.markets ?? {}).find(
        (market) =>
            Number.isInteger(market.reimbursement?.dispatchAtMs) &&
            !market.reimbursement?.submissionTxHash &&
            !market.reimbursement?.proposalHash
    );
}

function extractProposalHashFromReceipt(receipt, ogModule) {
    if (!receipt?.logs || !ogModule) {
        return null;
    }
    for (const log of receipt.logs) {
        if (String(log?.address ?? '').toLowerCase() !== String(ogModule).toLowerCase()) {
            continue;
        }
        const directHash = normalizeHashOrNull(log?.args?.proposalHash);
        if (directHash) {
            return directHash;
        }
        try {
            const decoded = decodeEventLog({
                abi: [transactionsProposedEvent],
                data: log.data,
                topics: log.topics,
            });
            const decodedHash = normalizeHashOrNull(decoded?.args?.proposalHash);
            if (decodedHash) {
                return decodedHash;
            }
        } catch {
            continue;
        }
    }
    return null;
}

function applyPublicationToolOutput(state, parsedOutput) {
    const requestId = parsedOutput?.requestId ?? parsedOutput?.message?.requestId;
    if (typeof requestId !== 'string' || !requestId.trim()) {
        return false;
    }
    const market = findMarketByPendingPublication(state, requestId.trim());
    if (!market) {
        return false;
    }

    const successish = isSuccessishToolStatus(parsedOutput);
    if (!successish) {
        market.pendingPublication = null;
        market.latestValidation = null;
        return true;
    }

    const pending = market.pendingPublication;
    market.lastPublishedCid = parsedOutput?.cid ?? market.lastPublishedCid;
    market.lastPublishedSequence = Number(pending.sequence ?? market.lastPublishedSequence);
    market.publishedRevision = Number(pending.revision ?? market.publishedRevision);
    market.latestValidation = parsedOutput?.validation ?? null;
    mergeTradeClassifications(
        market,
        parsedOutput?.validation?.classifications,
        parsedOutput?.cid ?? null
    );
    market.pendingPublication = null;
    return true;
}

function applyDepositToolOutput(state, parsedOutput) {
    const market = findMarketByPendingDeposit(state);
    if (!market) {
        return false;
    }
    market.settlement.depositDispatchAtMs = null;

    if (!isSuccessishToolStatus(parsedOutput)) {
        market.settlement.depositError = parsedOutput?.message ?? 'Settlement deposit failed.';
        markMarketDirty(market);
        return true;
    }

    const transactionHash = normalizeHashOrNull(parsedOutput?.transactionHash);
    market.settlement.depositTxHash = transactionHash;
    market.settlement.depositError = null;
    if (String(parsedOutput?.status ?? '').trim().toLowerCase() === 'confirmed') {
        market.settlement.depositConfirmedAtMs = Date.now();
    }
    markMarketDirty(market);
    return true;
}

function applyReimbursementToolOutput(state, parsedOutput) {
    const market = findMarketByPendingReimbursement(state);
    if (!market) {
        return false;
    }
    market.reimbursement.dispatchAtMs = null;

    if (!isSuccessishToolStatus(parsedOutput)) {
        market.reimbursement.lastError =
            parsedOutput?.message ?? 'Reimbursement proposal submission failed.';
        markMarketDirty(market);
        return true;
    }

    market.reimbursement.lastError = null;
    market.reimbursement.submissionTxHash =
        normalizeHashOrNull(parsedOutput?.transactionHash) ?? market.reimbursement.submissionTxHash;
    market.reimbursement.proposalHash =
        normalizeHashOrNull(parsedOutput?.ogProposalHash) ??
        normalizeHashOrNull(parsedOutput?.proposalHash) ??
        market.reimbursement.proposalHash;
    market.reimbursement.submittedAtMs = Date.now();
    markMarketDirty(market);
    return true;
}

function applyDisputeToolOutput(state, parsedOutput) {
    if (!state.pendingDispute?.assertionId) {
        return false;
    }
    if (!isSuccessishToolStatus(parsedOutput)) {
        return false;
    }
    if (!state.disputedAssertionIds.includes(state.pendingDispute.assertionId)) {
        state.disputedAssertionIds.push(state.pendingDispute.assertionId);
    }
    state.pendingDispute = null;
    return true;
}

async function refreshPendingSettlementDeposits(state, { publicClient }) {
    if (!publicClient || typeof publicClient.getTransactionReceipt !== 'function') {
        return false;
    }
    let changed = false;
    for (const market of Object.values(state.markets ?? {})) {
        const txHash = normalizeHashOrNull(market.settlement?.depositTxHash);
        if (!txHash || market.settlement.depositConfirmedAtMs) {
            continue;
        }
        try {
            const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
            if (receipt?.status === 0n || receipt?.status === 0 || receipt?.status === 'reverted') {
                market.settlement.depositTxHash = null;
                market.settlement.depositConfirmedAtMs = null;
                market.settlement.depositError = 'Settlement deposit transaction reverted.';
                markMarketDirty(market);
                changed = true;
                continue;
            }
            market.settlement.depositConfirmedAtMs = Date.now();
            market.settlement.depositError = null;
            markMarketDirty(market);
            changed = true;
        } catch {
            continue;
        }
    }
    return changed;
}

async function refreshPendingReimbursements(state, { publicClient, ogModule }) {
    if (!publicClient || typeof publicClient.getTransactionReceipt !== 'function') {
        return false;
    }
    let changed = false;
    for (const market of Object.values(state.markets ?? {})) {
        if (market.reimbursement.proposalHash || market.reimbursement.reimbursedAtMs) {
            continue;
        }
        const txHash = normalizeHashOrNull(market.reimbursement.submissionTxHash);
        if (!txHash) {
            continue;
        }
        try {
            const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
            if (receipt?.status === 0n || receipt?.status === 0 || receipt?.status === 'reverted') {
                market.reimbursement.submissionTxHash = null;
                market.reimbursement.submittedAtMs = null;
                market.reimbursement.lastError = 'Reimbursement proposal transaction reverted.';
                markMarketDirty(market);
                changed = true;
                continue;
            }
            const proposalHash = extractProposalHashFromReceipt(receipt, ogModule);
            if (proposalHash) {
                market.reimbursement.proposalHash = proposalHash;
                market.reimbursement.lastError = null;
                markMarketDirty(market);
                changed = true;
            }
        } catch {
            continue;
        }
    }
    return changed;
}

function applyProposalLifecycleEvents(state, { executedProposals = [], deletedProposals = [] }) {
    const executed = new Set((executedProposals ?? []).map((value) => normalizeHashOrNull(value)).filter(Boolean));
    const deleted = new Set((deletedProposals ?? []).map((value) => normalizeHashOrNull(value)).filter(Boolean));
    let changed = false;

    for (const market of Object.values(state.markets ?? {})) {
        const proposalHash = normalizeHashOrNull(market.reimbursement?.proposalHash);
        if (!proposalHash) {
            continue;
        }
        if (executed.has(proposalHash)) {
            market.reimbursement.reimbursedAtMs = Date.now();
            markMarketDirty(market);
            changed = true;
            continue;
        }
        if (deleted.has(proposalHash)) {
            market.reimbursement.proposalHash = null;
            market.reimbursement.submissionTxHash = null;
            market.reimbursement.submittedAtMs = null;
            market.reimbursement.reimbursedAtMs = null;
            market.reimbursement.lastError = null;
            markMarketDirty(market);
            changed = true;
        }
    }

    return changed;
}

export {
    applyDepositToolOutput,
    applyDisputeToolOutput,
    applyProposalLifecycleEvents,
    applyPublicationToolOutput,
    applyReimbursementToolOutput,
    extractProposalHashFromReceipt,
    refreshPendingReimbursements,
    refreshPendingSettlementDeposits,
};
