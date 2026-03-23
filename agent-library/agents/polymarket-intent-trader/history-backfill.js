import { hexToString, isAddressEqual } from 'viem';
import { findContractDeploymentBlock, getLogsChunked } from '../../../agent/src/lib/chain-history.js';
import {
    proposalDeletedEvent,
    proposalExecutedEvent,
    transactionsProposedEvent,
    transferEvent,
} from '../../../agent/src/lib/og.js';
import {
    decodeErc20TransferCallData,
    normalizeAddressOrNull,
    normalizeHashOrNull,
} from '../../../agent/src/lib/utils.js';
import {
    createDepositRecord,
    createReimbursementCommitmentRecord,
} from './credit-ledger.js';

function normalizeWhitespace(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function parseOptionalNonNegativeIntegerString(value) {
    try {
        const normalized = BigInt(String(value));
        return normalized >= 0n ? normalized.toString() : null;
    } catch (error) {
        return null;
    }
}

function normalizeHash(value) {
    return normalizeHashOrNull(value) ?? null;
}

async function resolveInitialBackfillStartBlock({
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
            `[agent] Failed to auto-discover deployment block for ${address}; scanning from genesis.`,
            error?.message ?? error
        );
    }

    return 0n;
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
    const normalizedExplanationRecipient = normalizeAddressOrNull(fields.recipient ?? null);
    if (fields.recipient && (!normalizedExplanationRecipient || normalizedExplanationRecipient !== decoded.to)) {
        return null;
    }

    return createReimbursementCommitmentRecord(
        {
            signer: fields.signer,
            recipientAddress: decoded.to,
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

export async function backfillDeposits({
    state,
    publicClient,
    commitmentSafe,
    latestBlock,
    policy,
    config,
    statusLogged = false,
}) {
    const previousBackfilledThroughBlock =
        state.backfilledDepositsThroughBlock !== null
            ? BigInt(state.backfilledDepositsThroughBlock)
            : null;

    if (
        previousBackfilledThroughBlock !== null &&
        previousBackfilledThroughBlock >= latestBlock
    ) {
        if (!statusLogged) {
            console.log(
                `[agent] polymarket-intent-trader credit backfill already complete through block ${state.backfilledDepositsThroughBlock}.`
            );
        }
        return { changed: false, statusLogged: true };
    }

    const fromBlock =
        previousBackfilledThroughBlock !== null
            ? previousBackfilledThroughBlock + 1n
            : await resolveInitialBackfillStartBlock({
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
        if (!deposit || state.deposits[deposit.depositKey]) {
            continue;
        }
        state.deposits[deposit.depositKey] = deposit;
        changed = true;
    }

    const nextBackfilledThroughBlock = latestBlock.toString();
    const watermarkChanged = state.backfilledDepositsThroughBlock !== nextBackfilledThroughBlock;
    state.backfilledDepositsThroughBlock = nextBackfilledThroughBlock;
    if (logs.length > 0 && previousBackfilledThroughBlock === null) {
        console.log(
            `[agent] Rebuilt ${logs.length} historical ERC20 deposit credit records for ${commitmentSafe}.`
        );
    } else if (logs.length > 0) {
        console.log(
            `[agent] Recovered ${logs.length} incremental ERC20 deposit credit records for ${commitmentSafe} through block ${latestBlock.toString()}.`
        );
    }
    return { changed: changed || watermarkChanged, statusLogged: false };
}

export async function backfillReimbursementCommitments({
    state,
    publicClient,
    latestBlock,
    policy,
    config,
    statusLogged = false,
}) {
    if (!policy.ogModule) {
        return { changed: false, statusLogged };
    }

    const previousBackfilledThroughBlock =
        state.backfilledReimbursementCommitmentsThroughBlock !== null
            ? BigInt(state.backfilledReimbursementCommitmentsThroughBlock)
            : null;

    if (
        previousBackfilledThroughBlock !== null &&
        previousBackfilledThroughBlock >= latestBlock
    ) {
        if (!statusLogged) {
            console.log(
                `[agent] polymarket-intent-trader reimbursement backfill already complete through block ${state.backfilledReimbursementCommitmentsThroughBlock}.`
            );
        }
        return { changed: false, statusLogged: true };
    }

    const fromBlock =
        previousBackfilledThroughBlock !== null
            ? previousBackfilledThroughBlock + 1n
            : await resolveInitialBackfillStartBlock({
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
            const existing = state.reimbursementCommitments[record.commitmentKey];
            const nextRecord = existing
                ? {
                      ...existing,
                      ...record,
                      status: existing.status === 'executed' ? 'executed' : record.status,
                  }
                : record;
            if (JSON.stringify(existing) !== JSON.stringify(nextRecord)) {
                state.reimbursementCommitments[record.commitmentKey] = nextRecord;
                changed = true;
            }
            continue;
        }

        const commitmentKey = `proposal:${proposalHash}`;
        const existing = state.reimbursementCommitments[commitmentKey];
        if (!existing) {
            continue;
        }

        if (event.kind === 'executed') {
            if (existing.status !== 'executed') {
                state.reimbursementCommitments[commitmentKey] = {
                    ...existing,
                    status: 'executed',
                };
                changed = true;
            }
            continue;
        }

        if (existing.status !== 'deleted') {
            state.reimbursementCommitments[commitmentKey] = {
                ...existing,
                status: 'deleted',
            };
            changed = true;
        }
    }

    const nextBackfilledThroughBlock = latestBlock.toString();
    const watermarkChanged =
        state.backfilledReimbursementCommitmentsThroughBlock !== nextBackfilledThroughBlock;
    state.backfilledReimbursementCommitmentsThroughBlock = nextBackfilledThroughBlock;
    if (lifecycleEvents.length > 0 && previousBackfilledThroughBlock === null) {
        console.log(
            `[agent] Rebuilt ${lifecycleEvents.length} historical reimbursement lifecycle records for ${policy.ogModule}.`
        );
    } else if (lifecycleEvents.length > 0) {
        console.log(
            `[agent] Recovered ${lifecycleEvents.length} incremental reimbursement lifecycle records for ${policy.ogModule} through block ${latestBlock.toString()}.`
        );
    }
    return { changed: changed || watermarkChanged, statusLogged: false };
}
