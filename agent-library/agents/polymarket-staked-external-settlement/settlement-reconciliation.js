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

function findMarketByPendingReimbursementRequest(state, requestId) {
    return Object.values(state.markets ?? {}).find(
        (market) => market.reimbursement?.requestId === requestId
    );
}

function findMarketByPendingDeposit(state) {
    return Object.values(state.markets ?? {}).find(
        (market) =>
            Number.isInteger(market.settlement?.depositDispatchAtMs) &&
            !market.settlement?.depositTxHash
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
    if (market) {
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

    const reimbursementRequestMarket = findMarketByPendingReimbursementRequest(state, requestId.trim());
    if (!reimbursementRequestMarket) {
        return false;
    }
    reimbursementRequestMarket.reimbursement.requestDispatchAtMs = null;
    if (!isSuccessishToolStatus(parsedOutput)) {
        reimbursementRequestMarket.reimbursement.lastError =
            parsedOutput?.message ?? 'Reimbursement request publication failed.';
        return true;
    }
    reimbursementRequestMarket.reimbursement.requestCid =
        parsedOutput?.cid ?? reimbursementRequestMarket.reimbursement.requestCid;
    reimbursementRequestMarket.reimbursement.requestedAtMs = Date.now();
    reimbursementRequestMarket.reimbursement.requestedRevision = Number(
        reimbursementRequestMarket.revision ?? reimbursementRequestMarket.reimbursement.requestedRevision
    );
    reimbursementRequestMarket.reimbursement.pendingMessage = null;
    reimbursementRequestMarket.reimbursement.lastError = null;
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

export {
    applyDepositToolOutput,
    applyPublicationToolOutput,
    extractProposalHashFromReceipt,
    refreshPendingSettlementDeposits,
};
