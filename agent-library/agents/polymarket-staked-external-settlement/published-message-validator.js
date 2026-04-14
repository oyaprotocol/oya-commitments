import { getAddress, parseAbi } from 'viem';
import {
    MessagePublicationValidationError,
} from '../../../agent/src/lib/message-publication-validation.js';
import { canonicalizeJson, isPlainObject } from '../../../agent/src/lib/canonical-json.js';
import { createValidatedReadOnlyRuntime } from '../../../agent/src/lib/chain-runtime.js';
import { normalizeAddressOrNull, normalizeHashOrNull } from '../../../agent/src/lib/utils.js';

const POLYMARKET_TRADE_LOG_KIND = 'polymarketTradeLog';
const POLYMARKET_REIMBURSEMENT_REQUEST_KIND = 'polymarketReimbursementRequest';
const POLYMARKET_TRADE_LOG_VALIDATOR_ID = 'polymarket_trade_log_timeliness';
const POLYMARKET_REIMBURSEMENT_REQUEST_VALIDATOR_ID =
    'polymarket_reimbursement_request';
const TRADE_ENTRY_KINDS = new Set(['initiated', 'continuation']);
const optimisticGovernorRulesAbi = parseAbi(['function rules() view returns (string)']);
const loggingWindowPattern =
    /Trades must be logged within\s+(\d+)\s+minutes of trade execution to be considered valid for reimbursement\./i;

function buildValidationError(
    message,
    { code = 'message_payload_invalid', statusCode = 422, details = undefined } = {}
) {
    return new MessagePublicationValidationError(message, {
        code,
        statusCode,
        details: {
            validatorId: POLYMARKET_TRADE_LOG_VALIDATOR_ID,
            ...(isPlainObject(details) ? details : {}),
        },
    });
}

function parsePositiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function parseNonNegativeInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return parsed;
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

function normalizeNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}

function normalizeAddress(value, label) {
    const normalized = normalizeAddressOrNull(value);
    if (!normalized) {
        throw new Error(`${label} must be a valid address.`);
    }
    return normalized;
}

function normalizeOptionalCid(value, label) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    return normalizeNonEmptyString(value, label);
}

function resolveModuleConfig(config) {
    const moduleConfig = config?.agentConfig?.polymarketStakedExternalSettlement;
    if (isPlainObject(moduleConfig)) {
        return moduleConfig;
    }
    if (isPlainObject(config?.polymarketStakedExternalSettlement)) {
        return config.polymarketStakedExternalSettlement;
    }
    return {};
}

function assertConfiguredMarketId(marketId, config) {
    const moduleConfig = resolveModuleConfig(config);
    const marketsById =
        isPlainObject(moduleConfig.marketsById) ? moduleConfig.marketsById : null;
    if (!marketsById) {
        return;
    }
    if (!Object.prototype.hasOwnProperty.call(marketsById, marketId)) {
        throw new Error(
            `message.payload.stream.marketId "${marketId}" is not configured in polymarketStakedExternalSettlement.marketsById.`
        );
    }
}

function normalizeTradeEntry(entry, label) {
    if (!isPlainObject(entry)) {
        throw new Error(`${label} must be a JSON object.`);
    }

    const normalizedKind = normalizeNonEmptyString(entry.tradeEntryKind, `${label}.tradeEntryKind`);
    if (!TRADE_ENTRY_KINDS.has(normalizedKind)) {
        throw new Error(
            `${label}.tradeEntryKind must be one of: ${Array.from(TRADE_ENTRY_KINDS).join(', ')}.`
        );
    }

    return canonicalizeJson({
        ...canonicalizeJson(entry),
        tradeId: normalizeNonEmptyString(entry.tradeId, `${label}.tradeId`),
        tradeEntryKind: normalizedKind,
        executedAtMs: parseNonNegativeInteger(entry.executedAtMs, `${label}.executedAtMs`),
    });
}

function normalizeSettlementSummary(summary, label = 'message.payload.summary') {
    if (summary === undefined || summary === null) {
        return {
            finalSettlementValueWei: null,
            settledAtMs: null,
            settlementKind: null,
            settlementDepositTxHash: null,
            settlementDepositConfirmedAtMs: null,
        };
    }
    if (!isPlainObject(summary)) {
        throw new Error(`${label} must be a JSON object when provided.`);
    }

    const settledAtMs =
        summary.settledAtMs === undefined || summary.settledAtMs === null || summary.settledAtMs === ''
            ? null
            : parseNonNegativeInteger(summary.settledAtMs, `${label}.settledAtMs`);
    const settlementKind =
        summary.settlementKind === undefined ||
        summary.settlementKind === null ||
        summary.settlementKind === ''
            ? null
            : normalizeNonEmptyString(summary.settlementKind, `${label}.settlementKind`);
    const finalSettlementValueWei =
        summary.finalSettlementValueWei === undefined ||
        summary.finalSettlementValueWei === null ||
        summary.finalSettlementValueWei === ''
            ? null
            : parseNonNegativeBigIntString(
                  summary.finalSettlementValueWei,
                  `${label}.finalSettlementValueWei`
              );
    const settlementDepositTxHash =
        summary.settlementDepositTxHash === undefined ||
        summary.settlementDepositTxHash === null ||
        summary.settlementDepositTxHash === ''
            ? null
            : (() => {
                  const normalized = normalizeHashOrNull(summary.settlementDepositTxHash);
                  if (!normalized) {
                      throw new Error(
                          `${label}.settlementDepositTxHash must be a 32-byte hex string when provided.`
                      );
                  }
                  return normalized;
              })();
    const settlementDepositConfirmedAtMs =
        summary.settlementDepositConfirmedAtMs === undefined ||
        summary.settlementDepositConfirmedAtMs === null ||
        summary.settlementDepositConfirmedAtMs === ''
            ? null
            : parseNonNegativeInteger(
                  summary.settlementDepositConfirmedAtMs,
                  `${label}.settlementDepositConfirmedAtMs`
              );

    if (settledAtMs === null) {
        if (finalSettlementValueWei !== null || settlementKind !== null) {
            throw new Error(
                `${label} must include settledAtMs before finalSettlementValueWei or settlementKind may be set.`
            );
        }
        if (settlementDepositTxHash !== null || settlementDepositConfirmedAtMs !== null) {
            throw new Error(
                `${label} must include settledAtMs before settlement deposit fields may be set.`
            );
        }
    } else {
        if (finalSettlementValueWei === null) {
            throw new Error(
                `${label}.finalSettlementValueWei is required when settledAtMs is set.`
            );
        }
        if (settlementKind === null) {
            throw new Error(`${label}.settlementKind is required when settledAtMs is set.`);
        }
    }

    if (settlementDepositConfirmedAtMs !== null && settlementDepositTxHash === null) {
        throw new Error(
            `${label}.settlementDepositTxHash is required when settlementDepositConfirmedAtMs is set.`
        );
    }

    return canonicalizeJson({
        finalSettlementValueWei,
        settledAtMs,
        settlementKind,
        settlementDepositTxHash,
        settlementDepositConfirmedAtMs,
    });
}

function normalizeBasePolymarketMessage(
    message,
    { config = undefined, envelope = undefined, expectedKind } = {}
) {
    if (!isPlainObject(message)) {
        throw new Error('message must be a JSON object.');
    }
    if (message.kind !== expectedKind) {
        throw new Error(`message.kind must be "${expectedKind}".`);
    }
    if (!isPlainObject(message.payload)) {
        throw new Error('message.payload must be a JSON object.');
    }
    if (!isPlainObject(message.payload.stream)) {
        throw new Error('message.payload.stream must be a JSON object.');
    }
    if (!Array.isArray(message.commitmentAddresses)) {
        throw new Error('message.commitmentAddresses must be an array.');
    }

    const stream = canonicalizeJson({
        commitmentSafe: normalizeAddress(
            message.payload.stream.commitmentSafe,
            'message.payload.stream.commitmentSafe'
        ),
        ogModule: normalizeAddress(
            message.payload.stream.ogModule,
            'message.payload.stream.ogModule'
        ),
        user: normalizeAddress(message.payload.stream.user, 'message.payload.stream.user'),
        marketId: normalizeNonEmptyString(
            message.payload.stream.marketId,
            'message.payload.stream.marketId'
        ),
        tradingWallet: normalizeAddress(
            message.payload.stream.tradingWallet,
            'message.payload.stream.tradingWallet'
        ),
    });
    assertConfiguredMarketId(stream.marketId, config);

    const commitmentAddresses = message.commitmentAddresses.map((address, index) =>
        normalizeAddress(address, `message.commitmentAddresses[${index}]`)
    );
    const commitmentAddressSet = new Set(commitmentAddresses);
    if (!commitmentAddressSet.has(stream.commitmentSafe) || !commitmentAddressSet.has(stream.ogModule)) {
        throw new Error(
            'message.commitmentAddresses must include both payload.stream.commitmentSafe and payload.stream.ogModule.'
        );
    }

    if (
        config?.commitmentSafe &&
        stream.commitmentSafe !== normalizeAddress(config.commitmentSafe, 'config.commitmentSafe')
    ) {
        throw new Error(
            'message.payload.stream.commitmentSafe does not match config.commitmentSafe.'
        );
    }
    if (config?.ogModule && stream.ogModule !== normalizeAddress(config.ogModule, 'config.ogModule')) {
        throw new Error('message.payload.stream.ogModule does not match config.ogModule.');
    }

    const moduleConfig = resolveModuleConfig(config);
    const configuredAuthorizedAgent = normalizeAddressOrNull(moduleConfig.authorizedAgent);
    const configuredTradingWallet = normalizeAddressOrNull(moduleConfig.tradingWallet);
    const normalizedAgentAddress = normalizeAddress(message.agentAddress, 'message.agentAddress');
    const authenticatedSignerAddress =
        isPlainObject(envelope) && envelope.address !== undefined
            ? normalizeAddress(envelope.address, 'envelope.address')
            : null;
    if (authenticatedSignerAddress && normalizedAgentAddress !== authenticatedSignerAddress) {
        throw new Error('message.agentAddress must match the authenticated signing address.');
    }
    if (configuredAuthorizedAgent && normalizedAgentAddress !== configuredAuthorizedAgent) {
        throw new Error(
            'message.agentAddress does not match config.polymarketStakedExternalSettlement.authorizedAgent.'
        );
    }
    if (configuredTradingWallet && stream.tradingWallet !== configuredTradingWallet) {
        throw new Error(
            'message.payload.stream.tradingWallet does not match config.polymarketStakedExternalSettlement.tradingWallet.'
        );
    }

    return {
        chainId: parsePositiveInteger(message.chainId, 'message.chainId'),
        requestId: normalizeNonEmptyString(message.requestId, 'message.requestId'),
        commitmentAddresses,
        agentAddress: normalizedAgentAddress,
        kind: expectedKind,
        payload: {
            ...canonicalizeJson(message.payload),
            stream,
        },
    };
}

function normalizeTradeLogMessage(message, { config = undefined, envelope = undefined } = {}) {
    const normalizedBase = normalizeBasePolymarketMessage(message, {
        config,
        envelope,
        expectedKind: POLYMARKET_TRADE_LOG_KIND,
    });

    const trades = Array.isArray(normalizedBase.payload.trades)
        ? message.payload.trades.map((entry, index) =>
              normalizeTradeEntry(entry, `message.payload.trades[${index}]`)
          )
        : (() => {
              throw new Error('message.payload.trades must be an array.');
          })();

    const seenTradeIds = new Set();
    for (const trade of trades) {
        if (seenTradeIds.has(trade.tradeId)) {
            throw new Error(`message.payload.trades contains duplicate tradeId "${trade.tradeId}".`);
        }
        seenTradeIds.add(trade.tradeId);
    }

    return canonicalizeJson({
        chainId: normalizedBase.chainId,
        requestId: normalizedBase.requestId,
        commitmentAddresses: normalizedBase.commitmentAddresses,
        agentAddress: normalizedBase.agentAddress,
        kind: POLYMARKET_TRADE_LOG_KIND,
        payload: {
            stream: normalizedBase.payload.stream,
            sequence: parsePositiveInteger(
                normalizedBase.payload.sequence,
                'message.payload.sequence'
            ),
            previousCid: normalizeOptionalCid(
                normalizedBase.payload.previousCid,
                'message.payload.previousCid'
            ),
            trades,
            summary: normalizeSettlementSummary(message.payload.summary),
        },
    });
}

function normalizeReimbursementRequestMessage(
    message,
    { config = undefined, envelope = undefined } = {}
) {
    const normalizedBase = normalizeBasePolymarketMessage(message, {
        config,
        envelope,
        expectedKind: POLYMARKET_REIMBURSEMENT_REQUEST_KIND,
    });

    return canonicalizeJson({
        chainId: normalizedBase.chainId,
        requestId: normalizedBase.requestId,
        commitmentAddresses: normalizedBase.commitmentAddresses,
        agentAddress: normalizedBase.agentAddress,
        kind: POLYMARKET_REIMBURSEMENT_REQUEST_KIND,
        payload: {
            stream: normalizedBase.payload.stream,
            snapshotCid: normalizeNonEmptyString(
                normalizedBase.payload.snapshotCid,
                'message.payload.snapshotCid'
            ),
        },
    });
}

function buildStreamKey(message) {
    const stream = message.payload.stream;
    return [
        message.chainId,
        message.agentAddress,
        stream.commitmentSafe,
        stream.ogModule,
        stream.user,
        stream.marketId,
        stream.tradingWallet,
    ].join(':');
}

function derivePublishedMessageLockKeys({
    config,
    envelope,
    message,
} = {}) {
    if (!isPlainObject(message)) {
        return [];
    }
    try {
        const normalizedMessage =
            message.kind === POLYMARKET_TRADE_LOG_KIND
                ? normalizeTradeLogMessage(message, { config, envelope })
                : message.kind === POLYMARKET_REIMBURSEMENT_REQUEST_KIND
                    ? normalizeReimbursementRequestMessage(message, { config, envelope })
                    : null;
        if (!normalizedMessage) {
            return [];
        }
        return [`polymarket_stream:${buildStreamKey(normalizedMessage)}`];
    } catch {
        return [];
    }
}

function extractPublishedTradeLogRecord(record) {
    if (!record?.cid || !record?.artifact?.signedMessage?.envelope?.message) {
        return null;
    }

    const rawMessage = record.artifact.signedMessage.envelope.message;
    if (!isPlainObject(rawMessage) || rawMessage.kind !== POLYMARKET_TRADE_LOG_KIND) {
        return null;
    }

    try {
        const message = normalizeTradeLogMessage(rawMessage);
        return {
            record,
            message,
            streamKey: buildStreamKey(message),
        };
    } catch (error) {
        throw buildValidationError(
            `Published Polymarket trade-log history contains an unreadable snapshot: ${error?.message ?? error}`,
            {
                code: 'message_validation_unavailable',
                statusCode: 503,
                details: {
                    cid: record.cid,
                    requestId: record.requestId ?? null,
                },
            }
        );
    }
}

function extractPublishedReimbursementRequestRecord(record) {
    if (!record?.cid || !record?.artifact?.signedMessage?.envelope?.message) {
        return null;
    }

    const rawMessage = record.artifact.signedMessage.envelope.message;
    if (!isPlainObject(rawMessage) || rawMessage.kind !== POLYMARKET_REIMBURSEMENT_REQUEST_KIND) {
        return null;
    }

    try {
        const message = normalizeReimbursementRequestMessage(rawMessage);
        return {
            record,
            message,
            streamKey: buildStreamKey(message),
        };
    } catch (error) {
        throw buildValidationError(
            `Published Polymarket reimbursement-request history contains an unreadable message: ${error?.message ?? error}`,
            {
                code: 'message_validation_unavailable',
                statusCode: 503,
                details: {
                    cid: record.cid,
                    requestId: record.requestId ?? null,
                },
            }
        );
    }
}

function selectLatestPublishedSnapshot(records, currentStreamKey) {
    const matching = [];
    for (const record of records) {
        const extracted = extractPublishedTradeLogRecord(record);
        if (!extracted || extracted.streamKey !== currentStreamKey) {
            continue;
        }
        matching.push(extracted);
    }

    matching.sort((left, right) => left.message.payload.sequence - right.message.payload.sequence);
    for (let index = 1; index < matching.length; index += 1) {
        if (
            matching[index - 1].message.payload.sequence === matching[index].message.payload.sequence
        ) {
            throw buildValidationError(
                'Published Polymarket trade-log history contains duplicate sequence numbers for the same stream.',
                {
                    code: 'message_sequence_invalid',
                    details: {
                        sequence: matching[index].message.payload.sequence,
                    },
                }
            );
        }
    }

    return matching.at(-1) ?? null;
}

function loadNewTrades({ currentMessage, latestPublishedSnapshot }) {
    const currentTrades = currentMessage.payload.trades;
    if (!latestPublishedSnapshot) {
        if (currentMessage.payload.sequence !== 1) {
            throw buildValidationError('First Polymarket trade-log snapshot must use sequence 1.', {
                code: 'message_sequence_invalid',
                details: {
                    sequence: currentMessage.payload.sequence,
                },
            });
        }
        if (currentMessage.payload.previousCid !== null) {
            throw buildValidationError(
                'First Polymarket trade-log snapshot must not set previousCid.',
                {
                    code: 'message_sequence_invalid',
                }
            );
        }
        return currentTrades;
    }

    const previousMessage = latestPublishedSnapshot.message;
    if (currentMessage.payload.sequence !== previousMessage.payload.sequence + 1) {
        throw buildValidationError(
            'Polymarket trade-log sequence must increment by exactly one.',
            {
                code: 'message_sequence_invalid',
                details: {
                    previousSequence: previousMessage.payload.sequence,
                    currentSequence: currentMessage.payload.sequence,
                },
            }
        );
    }
    if (currentMessage.payload.previousCid !== latestPublishedSnapshot.record.cid) {
        throw buildValidationError(
            'Polymarket trade-log previousCid must match the latest accepted snapshot CID for the stream.',
            {
                code: 'message_sequence_invalid',
                details: {
                    expectedPreviousCid: latestPublishedSnapshot.record.cid,
                    previousCid: currentMessage.payload.previousCid,
                },
            }
        );
    }
    if (currentTrades.length < previousMessage.payload.trades.length) {
        throw buildValidationError(
            'Polymarket trade-log snapshots must be cumulative and may not remove prior trades.',
            {
                code: 'message_payload_invalid',
            }
        );
    }

    const previousTrades = previousMessage.payload.trades;
    for (let index = 0; index < previousTrades.length; index += 1) {
        if (JSON.stringify(previousTrades[index]) !== JSON.stringify(currentTrades[index])) {
            throw buildValidationError(
                'Previously published Polymarket trade-log entries must remain unchanged in later cumulative snapshots.',
                {
                    code: 'message_payload_invalid',
                    details: {
                        changedTradeId: previousTrades[index].tradeId,
                    },
                }
            );
        }
    }

    return currentTrades.slice(previousTrades.length);
}

async function loadLoggingWindowMinutes({ config, publicClient, ogModule, expectedChainId }) {
    let effectivePublicClient = publicClient;
    if (!effectivePublicClient) {
        const rpcUrl = config?.rpcUrl;
        if (typeof rpcUrl !== 'string' || !rpcUrl.trim()) {
            throw buildValidationError(
                'Polymarket trade-log validation requires config.rpcUrl to load onchain rules.',
                {
                    code: 'message_validation_unavailable',
                    statusCode: 503,
                }
            );
        }
        try {
            ({ publicClient: effectivePublicClient } = await createValidatedReadOnlyRuntime({
                rpcUrl,
                expectedChainId,
            }));
        } catch (error) {
            throw buildValidationError(
                `Unable to initialize read-only runtime for Polymarket trade-log validation: ${error?.message ?? error}`,
                {
                    code: 'message_validation_unavailable',
                    statusCode: 503,
                }
            );
        }
    }

    let rulesText;
    try {
        rulesText = await effectivePublicClient.readContract({
            address: getAddress(ogModule),
            abi: optimisticGovernorRulesAbi,
            functionName: 'rules',
        });
    } catch (error) {
        throw buildValidationError(
            `Unable to load onchain rules for Polymarket trade-log validation: ${error?.message ?? error}`,
            {
                code: 'message_validation_unavailable',
                statusCode: 503,
            }
        );
    }

    if (typeof rulesText !== 'string' || !rulesText.trim()) {
        throw buildValidationError(
            'Onchain rules text is empty; Polymarket trade-log validation cannot determine the logging window.',
            {
                code: 'message_validation_unavailable',
                statusCode: 503,
            }
        );
    }

    const match = rulesText.match(loggingWindowPattern);
    if (!match) {
        throw buildValidationError(
            'Onchain rules do not include a supported Polymarket logging window clause.',
            {
                code: 'message_validation_unavailable',
                statusCode: 503,
            }
        );
    }

    return parseNonNegativeInteger(match[1], 'logging window minutes');
}

async function validatePublishedMessage({
    config,
    envelope,
    message,
    receivedAtMs,
    publishedAtMs,
    listRecords,
    publicClient,
} = {}) {
    if (!isPlainObject(message)) {
        return null;
    }

    if (message.kind === POLYMARKET_REIMBURSEMENT_REQUEST_KIND) {
        let normalizedMessage;
        try {
            normalizedMessage = normalizeReimbursementRequestMessage(message, { config, envelope });
        } catch (error) {
            throw buildValidationError(error?.message ?? String(error), {
                code: 'message_payload_invalid',
            });
        }

        if (typeof listRecords !== 'function') {
            throw buildValidationError(
                'Polymarket reimbursement-request validation requires listRecords() history access.',
                {
                    code: 'message_validation_unavailable',
                    statusCode: 503,
                }
            );
        }
        const records = await listRecords();
        if (!Array.isArray(records)) {
            throw buildValidationError(
                'Polymarket reimbursement-request validation requires listRecords() to return an array.',
                {
                    code: 'message_validation_unavailable',
                    statusCode: 503,
                }
            );
        }
        const latestPublishedSnapshot = selectLatestPublishedSnapshot(
            records,
            buildStreamKey(normalizedMessage)
        );
        if (!latestPublishedSnapshot) {
            throw buildValidationError(
                'Polymarket reimbursement requests require at least one published trade-log snapshot for the same stream.',
                {
                    code: 'message_sequence_invalid',
                }
            );
        }
        if (normalizedMessage.payload.snapshotCid !== latestPublishedSnapshot.record.cid) {
            throw buildValidationError(
                'Polymarket reimbursement requests must reference the latest accepted trade-log snapshot CID for the stream.',
                {
                    code: 'message_sequence_invalid',
                    details: {
                        expectedSnapshotCid: latestPublishedSnapshot.record.cid,
                        snapshotCid: normalizedMessage.payload.snapshotCid,
                    },
                }
            );
        }
        return {
            validatorId: POLYMARKET_REIMBURSEMENT_REQUEST_VALIDATOR_ID,
            status: 'accepted',
            summary: {
                stream: normalizedMessage.payload.stream,
                snapshotCid: normalizedMessage.payload.snapshotCid,
                previousPublishedCid: latestPublishedSnapshot.record.cid,
            },
        };
    }

    if (message.kind !== POLYMARKET_TRADE_LOG_KIND) {
        return null;
    }

    let currentMessage;
    try {
        currentMessage = normalizeTradeLogMessage(message, { config, envelope });
    } catch (error) {
        throw buildValidationError(error?.message ?? String(error), {
            code: 'message_payload_invalid',
        });
    }

    if (typeof listRecords !== 'function') {
        throw buildValidationError(
            'Polymarket trade-log validation requires listRecords() history access.',
            {
                code: 'message_validation_unavailable',
                statusCode: 503,
            }
        );
    }

    const records = await listRecords();
    if (!Array.isArray(records)) {
        throw buildValidationError(
            'Polymarket trade-log validation requires listRecords() to return an array.',
            {
                code: 'message_validation_unavailable',
                statusCode: 503,
            }
        );
    }

    const latestPublishedSnapshot = selectLatestPublishedSnapshot(
        records,
        buildStreamKey(currentMessage)
    );
    const newTrades = loadNewTrades({ currentMessage, latestPublishedSnapshot });
    const loggingWindowMinutes = await loadLoggingWindowMinutes({
        config,
        publicClient,
        ogModule: currentMessage.payload.stream.ogModule,
        expectedChainId: currentMessage.chainId,
    });
    const loggingWindowMs = loggingWindowMinutes * 60_000;
    const firstSeenAtMs = parsePositiveInteger(receivedAtMs, 'receivedAtMs');
    const normalizedPublishedAtMs = parsePositiveInteger(publishedAtMs, 'publishedAtMs');

    const classifications = newTrades.map((trade) => {
        if (trade.executedAtMs > firstSeenAtMs) {
            throw buildValidationError(
                `Trade "${trade.tradeId}" has executedAtMs after the node first received the snapshot.`,
                {
                    code: 'message_payload_invalid',
                    details: {
                        tradeId: trade.tradeId,
                        executedAtMs: trade.executedAtMs,
                        receivedAtMs: firstSeenAtMs,
                    },
                }
            );
        }

        const deltaMs = firstSeenAtMs - trade.executedAtMs;
        if (deltaMs <= loggingWindowMs) {
            return {
                id: trade.tradeId,
                classification: 'reimbursable',
                firstSeenAtMs,
            };
        }
        return {
            id: trade.tradeId,
            classification: 'non_reimbursable_late',
            firstSeenAtMs,
            reason: `trade first reached the node ${Math.floor(deltaMs / 60_000)} minute(s) after execution; limit is ${loggingWindowMinutes} minute(s)`,
        };
    });

    return {
        validatorId: POLYMARKET_TRADE_LOG_VALIDATOR_ID,
        status: 'accepted',
        classifications,
        summary: {
            stream: currentMessage.payload.stream,
            sequence: currentMessage.payload.sequence,
            previousCid: currentMessage.payload.previousCid,
            settlement: currentMessage.payload.summary,
            loggingWindowMinutes,
            evaluationBasis: 'receivedAtMs',
            previousPublishedCid: latestPublishedSnapshot?.record?.cid ?? null,
            publishedAtMs: normalizedPublishedAtMs,
            newTradeCount: newTrades.length,
            lateTradeCount: classifications.filter(
                (entry) => entry.classification === 'non_reimbursable_late'
            ).length,
        },
    };
}

export {
    derivePublishedMessageLockKeys,
    extractPublishedReimbursementRequestRecord,
    extractPublishedTradeLogRecord,
    POLYMARKET_TRADE_LOG_KIND,
    POLYMARKET_TRADE_LOG_VALIDATOR_ID,
    POLYMARKET_REIMBURSEMENT_REQUEST_KIND,
    POLYMARKET_REIMBURSEMENT_REQUEST_VALIDATOR_ID,
    normalizeReimbursementRequestMessage,
    normalizeTradeLogMessage,
    buildStreamKey,
    validatePublishedMessage,
};
