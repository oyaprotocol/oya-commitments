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

function buildStreamKey(stream) {
    if (!stream || typeof stream !== 'object') {
        return null;
    }
    const marketId = typeof stream.marketId === 'string' ? stream.marketId.trim() : '';
    if (!marketId) {
        return null;
    }
    return [
        String(stream.commitmentSafe ?? '').trim().toLowerCase(),
        String(stream.ogModule ?? '').trim().toLowerCase(),
        String(stream.user ?? '').trim().toLowerCase(),
        marketId,
        String(stream.tradingWallet ?? '').trim().toLowerCase(),
    ].join('|');
}

function findMarketByPublishedTradeLogMessage(state, parsedOutput) {
    const message = parsedOutput?.message;
    if (message?.kind !== 'polymarketTradeLog') {
        return null;
    }
    const publishedStreamKey = buildStreamKey(message?.payload?.stream);
    if (!publishedStreamKey) {
        return null;
    }
    return Object.values(state.markets ?? {}).find(
        (market) => buildStreamKey(market?.stream) === publishedStreamKey
    );
}

function applyTradeLogPublicationSuccess(market, parsedOutput, pending = null) {
    const sequence = Number(parsedOutput?.message?.payload?.sequence ?? pending?.sequence ?? 0);
    if (!Number.isInteger(sequence) || sequence < 1) {
        return false;
    }
    const revision = Number(parsedOutput?.message?.payload?.revision ?? pending?.revision ?? 0);
    market.lastPublishedCid = parsedOutput?.cid ?? market.lastPublishedCid;
    market.lastPublishedSequence = Math.max(Number(market.lastPublishedSequence ?? 0), sequence);
    if (Number.isInteger(revision) && revision >= 0) {
        market.publishedRevision = Math.max(Number(market.publishedRevision ?? 0), revision);
    }
    market.latestValidation = parsedOutput?.validation ?? null;
    mergeTradeClassifications(
        market,
        parsedOutput?.validation?.classifications,
        parsedOutput?.cid ?? null
    );
    const pendingSequence = Number(market.pendingPublication?.sequence ?? 0);
    if (
        market.pendingPublication &&
        Number.isInteger(pendingSequence) &&
        pendingSequence <= sequence
    ) {
        market.pendingPublication = null;
    }
    return true;
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

        return applyTradeLogPublicationSuccess(market, parsedOutput, market.pendingPublication);
    }

    if (isSuccessishToolStatus(parsedOutput)) {
        const lateTradeLogMarket = findMarketByPublishedTradeLogMessage(state, parsedOutput);
        if (lateTradeLogMarket) {
            return applyTradeLogPublicationSuccess(lateTradeLogMarket, parsedOutput);
        }
    }

    const reimbursementRequestMarket = findMarketByPendingReimbursementRequest(state, requestId.trim());
    if (!reimbursementRequestMarket) {
        return false;
    }
    reimbursementRequestMarket.reimbursement.requestDispatchAtMs = null;
    if (!isSuccessishToolStatus(parsedOutput)) {
        reimbursementRequestMarket.reimbursement.pendingRevision = null;
        reimbursementRequestMarket.reimbursement.lastError =
            parsedOutput?.message ?? 'Reimbursement request publication failed.';
        return true;
    }
    reimbursementRequestMarket.reimbursement.requestCid =
        parsedOutput?.cid ?? reimbursementRequestMarket.reimbursement.requestCid;
    reimbursementRequestMarket.reimbursement.requestedAtMs = Date.now();
    reimbursementRequestMarket.reimbursement.requestedRevision = Number(
        reimbursementRequestMarket.reimbursement.pendingRevision ??
            reimbursementRequestMarket.reimbursement.requestedRevision ??
            reimbursementRequestMarket.revision
    );
    reimbursementRequestMarket.reimbursement.pendingRevision = null;
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
        market.settlement.depositSubmittedAtMs = null;
        market.settlement.depositError = parsedOutput?.message ?? 'Settlement deposit failed.';
        markMarketDirty(market);
        return true;
    }

    const transactionHash = normalizeHashOrNull(parsedOutput?.transactionHash);
    market.settlement.depositTxHash = transactionHash;
    market.settlement.depositSubmittedAtMs = transactionHash ? Date.now() : null;
    market.settlement.depositError = null;
    if (String(parsedOutput?.status ?? '').trim().toLowerCase() === 'confirmed') {
        market.settlement.depositSubmittedAtMs = null;
        market.settlement.depositConfirmedAtMs = Date.now();
    }
    markMarketDirty(market);
    return true;
}

async function refreshPendingSettlementDeposits(state, { publicClient, pendingTxTimeoutMs }) {
    if (!publicClient || typeof publicClient.getTransactionReceipt !== 'function') {
        return false;
    }
    let changed = false;
    const nowMs = Date.now();
    for (const market of Object.values(state.markets ?? {})) {
        const txHash = normalizeHashOrNull(market.settlement?.depositTxHash);
        if (!txHash || market.settlement.depositConfirmedAtMs) {
            continue;
        }
        try {
            const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
            if (receipt?.status === 0n || receipt?.status === 0 || receipt?.status === 'reverted') {
                market.settlement.depositTxHash = null;
                market.settlement.depositSubmittedAtMs = null;
                market.settlement.depositConfirmedAtMs = null;
                market.settlement.depositError = 'Settlement deposit transaction reverted.';
                markMarketDirty(market);
                changed = true;
                continue;
            }
            market.settlement.depositSubmittedAtMs = null;
            market.settlement.depositConfirmedAtMs = Date.now();
            market.settlement.depositError = null;
            markMarketDirty(market);
            changed = true;
        } catch {
            const submittedAtMs = Number(market.settlement.depositSubmittedAtMs ?? 0);
            if (
                submittedAtMs > 0 &&
                nowMs - submittedAtMs > Number(pendingTxTimeoutMs ?? 0)
            ) {
                market.settlement.depositSubmittedAtMs = null;
                market.settlement.depositConfirmedAtMs = null;
                market.settlement.depositError =
                    'Settlement deposit transaction could not be reconciled before timeout; automatic retry is blocked until the original tx hash is reconciled.';
                markMarketDirty(market);
                changed = true;
            }
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
