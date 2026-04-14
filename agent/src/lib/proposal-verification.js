import {
    decodeEventLog,
    erc20Abi,
    getAddress,
    hexToString,
    keccak256,
    stringToHex,
} from 'viem';
import { isPlainObject } from './canonical-json.js';
import { findContractDeploymentBlock, getLogsChunked } from './chain-history.js';
import {
    optimisticGovernorAbi,
    proposalDeletedEvent,
    proposalExecutedEvent,
    transactionsProposedEvent,
} from './og.js';
import { parseStructuredProposalExplanation } from './proposal-explanation.js';
import { buildSignedProposalEnvelope } from './signed-proposal.js';
import { normalizeHashOrNull, decodeErc20TransferCallData } from './utils.js';

const PROPOSAL_KIND_IDS = Object.freeze({
    AGENT_PROXY_REIMBURSEMENT: 1,
});
const PROPOSAL_KIND_NAME_BY_ID = Object.freeze({
    [PROPOSAL_KIND_IDS.AGENT_PROXY_REIMBURSEMENT]: 'agent_proxy_reimbursement',
});
const PROPOSAL_KIND_ID_BY_NAME = new Map(
    Object.entries(PROPOSAL_KIND_NAME_BY_ID).map(([proposalKindId, proposalKind]) => [
        proposalKind,
        Number(proposalKindId),
    ])
);
const SUPPORTED_PROPOSAL_KINDS = new Set(Object.values(PROPOSAL_KIND_NAME_BY_ID));
const KNOWN_TEMPLATE_IDS_BY_TITLE = new Map(
    [
        ['Agent Proxy', 'agent_proxy'],
        ['Proposal Delegation', 'proposal_delegation'],
        ['Solo User', 'solo_user'],
        ['Recurring Fee', 'recurring_fee'],
        ['Performance Fee', 'performance_fee'],
        ['Standard Period', 'standard_period'],
        ['Day Definition', 'day_definition'],
        ['Time Period Start', 'time_period_start'],
        ['Fee Withholding', 'fee_withholding'],
        ['Fair Valuation', 'fair_valuation'],
        ['Trade Restrictions', 'trade_restrictions'],
        ['Withdrawal Restrictions', 'withdrawal_restrictions'],
        ['Commitment Pause', 'commitment_pause'],
        ['Account Recovery and Rule Updates', 'account_recovery_and_rule_updates'],
        ['Draft State', 'draft_state'],
        ['Polymarket Liquidity', 'polymarket_liquidity'],
        ['Transfer Address Restrictions', 'transfer_address_restrictions'],
        ['Trading Limits', 'trading_limits'],
        ['Staked External Polymarket Execution', 'staked_external_polymarket_execution'],
    ].map(([title, templateId]) => [title.toLowerCase(), templateId])
);

const TEMPLATE_COVERAGE_BY_KIND = Object.freeze({
    agent_proxy_reimbursement: Object.freeze({
        agent_proxy: 'enforced',
        fair_valuation: 'partial',
        proposal_delegation: 'not_applicable',
        solo_user: 'not_applicable',
        recurring_fee: 'not_applicable',
        performance_fee: 'not_applicable',
        standard_period: 'not_applicable',
        day_definition: 'not_applicable',
        time_period_start: 'not_applicable',
        fee_withholding: 'not_applicable',
        withdrawal_restrictions: 'not_applicable',
        account_recovery_and_rule_updates: 'not_applicable',
        draft_state: 'not_applicable',
        trade_restrictions: 'unsupported',
        commitment_pause: 'unsupported',
        polymarket_liquidity: 'unsupported',
        transfer_address_restrictions: 'unsupported',
        trading_limits: 'unsupported',
        staked_external_polymarket_execution: 'unsupported',
    }),
});

const DEPOSIT_STATUS_RANK = Object.freeze({
    available: 0,
    reserved: 1,
    consumed: 2,
    unknown: 3,
});

const ogDeploymentBlockCacheByClient = new WeakMap();

class VerificationUnknownError extends Error {
    constructor(message, { code = 'verification_runtime_unavailable' } = {}) {
        super(message);
        this.name = 'VerificationUnknownError';
        this.code = code;
    }
}

function wrapVerificationUnknownError(error, prefix) {
    if (error instanceof VerificationUnknownError) {
        return error;
    }
    return new VerificationUnknownError(`${prefix}: ${error?.message ?? String(error)}`);
}

function getOgDeploymentBlockCache(publicClient) {
    if (!publicClient || (typeof publicClient !== 'object' && typeof publicClient !== 'function')) {
        return null;
    }
    let cache = ogDeploymentBlockCacheByClient.get(publicClient);
    if (!cache) {
        cache = new Map();
        ogDeploymentBlockCacheByClient.set(publicClient, cache);
    }
    return cache;
}

async function resolveOgHistoryStartBlock({
    publicClient,
    ogModule,
    latestBlock,
    minimumFromBlock = undefined,
}) {
    const normalizedOgModule = getAddress(ogModule).toLowerCase();
    const cache = getOgDeploymentBlockCache(publicClient);
    let deploymentBlockPromise = cache?.get(normalizedOgModule) ?? null;
    if (!deploymentBlockPromise) {
        deploymentBlockPromise = (async () => {
            let deploymentBlock;
            try {
                deploymentBlock = await findContractDeploymentBlock({
                    publicClient,
                    address: normalizedOgModule,
                    latestBlock,
                });
            } catch (error) {
                throw wrapVerificationUnknownError(
                    error,
                    `Could not determine the deployment block for OG module ${normalizedOgModule}`
                );
            }
            if (deploymentBlock === null) {
                throw new VerificationUnknownError(
                    `OG module ${normalizedOgModule} is not deployed at block ${latestBlock.toString()}.`
                );
            }
            return deploymentBlock;
        })();
        cache?.set(normalizedOgModule, deploymentBlockPromise);
    }

    let deploymentBlock;
    try {
        deploymentBlock = await deploymentBlockPromise;
    } catch (error) {
        cache?.delete(normalizedOgModule);
        throw error;
    }

    if (minimumFromBlock === undefined || minimumFromBlock === null) {
        return deploymentBlock;
    }
    const normalizedMinimum = BigInt(minimumFromBlock);
    return normalizedMinimum > deploymentBlock ? normalizedMinimum : deploymentBlock;
}

function normalizeRulesText(rulesText) {
    if (typeof rulesText !== 'string' || !rulesText.trim()) {
        throw new Error('rulesText must be a non-empty string.');
    }
    return rulesText.replace(/\r\n/g, '\n').trim();
}

function computeRulesHash(rulesText) {
    return keccak256(stringToHex(normalizeRulesText(rulesText)));
}

function normalizeRuleBody(body) {
    return String(body ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseRuleSections(rulesText) {
    const normalized = normalizeRulesText(rulesText);
    const sections = [];
    const matcher = /(^[^\n]+)\n---\n([\s\S]*?)(?=\n{2,}[^\n]+\n---\n|$)/gm;
    let match;
    while ((match = matcher.exec(normalized)) !== null) {
        sections.push({
            title: match[1].trim(),
            body: match[2].trim(),
        });
    }
    return sections;
}

function parseAddressList(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty comma-separated address list.`);
    }
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => getAddress(item).toLowerCase());
}

function parsePositiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function parsePositiveBigInt(value, label) {
    try {
        const parsed = BigInt(value);
        if (parsed <= 0n) {
            throw new Error(`${label} must be a positive integer.`);
        }
        return parsed;
    } catch (error) {
        if (error instanceof Error && error.message.includes(label)) {
            throw error;
        }
        throw new Error(`${label} must be a positive integer.`);
    }
}

function parseAgentProxyTemplate(body) {
    const match = normalizeRuleBody(body).match(
        /^The agent at address (0x[0-9a-fA-F]{40}) may trade tokens in this commitment for different tokens, at the current fair market exchange rate\. To execute the trade, they deposit tokens from their own wallet into the Safe, and propose to withdraw tokens of equal or lesser value\. Token prices are based on the prices at the time of the deposit\.$/
    );
    if (!match) {
        return { ok: false, reason: 'Body does not match the standard Agent Proxy template.' };
    }
    return {
        ok: true,
        params: {
            agentAddress: getAddress(match[1]).toLowerCase(),
        },
    };
}

function parseSoloUserTemplate(body) {
    const match = normalizeRuleBody(body).match(
        /^This commitment accepts deposits from a single user at address (0x[0-9a-fA-F]{40}) and their designated agent at address (0x[0-9a-fA-F]{40})\. Deposits from any other address are credited to the user\.$/
    );
    if (!match) {
        return { ok: false, reason: 'Body does not match the standard Solo User template.' };
    }
    return {
        ok: true,
        params: {
            userAddress: getAddress(match[1]).toLowerCase(),
            agentAddress: getAddress(match[2]).toLowerCase(),
        },
    };
}

function parseFairValuationTemplate(body) {
    const normalized = normalizeRuleBody(body);
    if (
        normalized !==
        'Tokens are priced by their fair market value. Markets that are clearly manipulated are not a valid point-in-time data source.'
    ) {
        return { ok: false, reason: 'Body does not match the standard Fair Valuation template.' };
    }
    return { ok: true, params: {} };
}

function parseAccountRecoveryTemplate(body) {
    const match = normalizeRuleBody(body).match(
        /^These rules may be updated by a (\d+)\/(\d+) consensus of addresses (.+)\. After the rule update is executed, the new rules apply to all future transaction proposals\.$/
    );
    if (!match) {
        return {
            ok: false,
            reason:
                'Body does not match the standard Account Recovery and Rule Updates template.',
        };
    }
    try {
        const requiredSigners = parsePositiveInteger(
            match[1],
            'requiredSigners'
        );
        const totalSigners = parsePositiveInteger(match[2], 'totalSigners');
        const signers = parseAddressList(match[3], 'signers');
        return {
            ok: true,
            params: {
                requiredSigners,
                totalSigners,
                signers,
            },
        };
    } catch (error) {
        return {
            ok: false,
            reason: error?.message ?? String(error),
        };
    }
}

function parseGenericKnownTemplate(body) {
    if (!normalizeRuleBody(body)) {
        return { ok: false, reason: 'Template body must not be blank.' };
    }
    return {
        ok: true,
        params: {
            rawText: body.trim(),
        },
    };
}

const TEMPLATE_PARSERS = Object.freeze({
    agent_proxy: parseAgentProxyTemplate,
    solo_user: parseSoloUserTemplate,
    fair_valuation: parseFairValuationTemplate,
    account_recovery_and_rule_updates: parseAccountRecoveryTemplate,
});

function resolveTemplateCoverage(templateId, proposalKind) {
    return TEMPLATE_COVERAGE_BY_KIND[proposalKind]?.[templateId] ?? 'unsupported';
}

function parseStandardCommitmentRules(rulesText, { proposalKind } = {}) {
    const sections = parseRuleSections(rulesText);
    const matchedTemplates = [];
    const unparsedSections = [];

    for (const section of sections) {
        const templateId = KNOWN_TEMPLATE_IDS_BY_TITLE.get(section.title.toLowerCase());
        if (!templateId) {
            unparsedSections.push({
                title: section.title,
                reason: 'Section title is not a known standard template.',
            });
            continue;
        }

        const parser = TEMPLATE_PARSERS[templateId] ?? parseGenericKnownTemplate;
        const parsed = parser(section.body);
        if (!parsed.ok) {
            unparsedSections.push({
                title: section.title,
                reason: parsed.reason ?? 'Template body could not be parsed.',
            });
            continue;
        }

        matchedTemplates.push({
            templateId,
            title: section.title,
            coverage: proposalKind ? resolveTemplateCoverage(templateId, proposalKind) : 'unknown',
            params: parsed.params ?? {},
        });
    }

    return {
        matchedTemplates,
        unparsedSections,
    };
}

function normalizeDepositTxHashes(value) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('metadata.verification.depositTxHashes must be a non-empty array.');
    }
    const normalized = value.map((item, index) => {
        const hash = normalizeHashOrNull(item);
        if (!hash) {
            throw new Error(
                `metadata.verification.depositTxHashes[${index}] must be a 32-byte hex string.`
            );
        }
        return hash;
    });
    if (new Set(normalized).size !== normalized.length) {
        throw new Error('metadata.verification.depositTxHashes must not contain duplicates.');
    }
    return normalized;
}

function normalizePriceMap(value, label) {
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be an object keyed by token address.`);
    }
    const normalized = {};
    for (const [tokenRaw, priceRaw] of Object.entries(value)) {
        const token = getAddress(tokenRaw).toLowerCase();
        normalized[token] = parsePositiveBigInt(priceRaw, `${label}.${token}`).toString();
    }
    return normalized;
}

function normalizeDepositPriceSnapshots(value) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(
            'metadata.verification.depositPriceSnapshots must be a non-empty array.'
        );
    }
    const byHash = new Map();
    for (let index = 0; index < value.length; index += 1) {
        const entry = value[index];
        if (!isPlainObject(entry)) {
            throw new Error(
                `metadata.verification.depositPriceSnapshots[${index}] must be an object.`
            );
        }
        const depositTxHash = normalizeHashOrNull(entry.depositTxHash);
        if (!depositTxHash) {
            throw new Error(
                `metadata.verification.depositPriceSnapshots[${index}].depositTxHash must be a 32-byte hex string.`
            );
        }
        if (byHash.has(depositTxHash)) {
            throw new Error(
                `metadata.verification.depositPriceSnapshots contains a duplicate entry for ${depositTxHash}.`
            );
        }
        byHash.set(depositTxHash, {
            depositTxHash,
            depositAssetPriceUsdMicros: parsePositiveBigInt(
                entry.depositAssetPriceUsdMicros,
                `metadata.verification.depositPriceSnapshots[${index}].depositAssetPriceUsdMicros`
            ).toString(),
            reimbursementAssetPricesUsdMicros: normalizePriceMap(
                entry.reimbursementAssetPricesUsdMicros,
                `metadata.verification.depositPriceSnapshots[${index}].reimbursementAssetPricesUsdMicros`
            ),
        });
    }
    return byHash;
}

function normalizeReimbursementAllocations(value) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(
            'metadata.verification.reimbursementAllocations must be a non-empty array.'
        );
    }
    const allocations = new Map();
    for (let index = 0; index < value.length; index += 1) {
        const entry = value[index];
        if (!isPlainObject(entry)) {
            throw new Error(
                `metadata.verification.reimbursementAllocations[${index}] must be an object.`
            );
        }
        const depositTxHash = normalizeHashOrNull(entry.depositTxHash);
        if (!depositTxHash) {
            throw new Error(
                `metadata.verification.reimbursementAllocations[${index}].depositTxHash must be a 32-byte hex string.`
            );
        }
        if (allocations.has(depositTxHash)) {
            throw new Error(
                `metadata.verification.reimbursementAllocations contains a duplicate entry for ${depositTxHash}.`
            );
        }
        if (!Array.isArray(entry.reimbursements) || entry.reimbursements.length === 0) {
            throw new Error(
                `metadata.verification.reimbursementAllocations[${index}].reimbursements must be a non-empty array.`
            );
        }
        allocations.set(
            depositTxHash,
            entry.reimbursements.map((reimbursement, reimbursementIndex) => {
                if (!isPlainObject(reimbursement)) {
                    throw new Error(
                        `metadata.verification.reimbursementAllocations[${index}].reimbursements[${reimbursementIndex}] must be an object.`
                    );
                }
                return {
                    token: getAddress(reimbursement.token).toLowerCase(),
                    amountWei: parsePositiveBigInt(
                        reimbursement.amountWei,
                        `metadata.verification.reimbursementAllocations[${index}].reimbursements[${reimbursementIndex}].amountWei`
                    ).toString(),
                };
            })
        );
    }
    return allocations;
}

function normalizeProposalKind(value, label = 'metadata.verification.proposalKind') {
    const normalizedProposalKind = String(value ?? '')
        .trim()
        .toLowerCase();
    const proposalKindId = PROPOSAL_KIND_ID_BY_NAME.get(normalizedProposalKind) ?? null;
    if (!proposalKindId) {
        throw new Error(
            `${label} must be one of: ${Array.from(SUPPORTED_PROPOSAL_KINDS).join(', ')}.`
        );
    }
    return {
        proposalKind: PROPOSAL_KIND_NAME_BY_ID[proposalKindId],
        proposalKindId,
    };
}

function normalizeVerificationMetadata(metadata) {
    if (!isPlainObject(metadata?.verification)) {
        throw new Error('metadata.verification must be an object.');
    }
    const { proposalKind, proposalKindId } = normalizeProposalKind(
        metadata.verification.proposalKind
    );
    const rulesHash = normalizeHashOrNull(metadata.verification.rulesHash);
    if (!rulesHash) {
        throw new Error('metadata.verification.rulesHash must be a 32-byte hex string.');
    }
    const depositTxHashes = normalizeDepositTxHashes(metadata.verification.depositTxHashes);
    const depositPriceSnapshots = normalizeDepositPriceSnapshots(
        metadata.verification.depositPriceSnapshots
    );
    const reimbursementAllocations = normalizeReimbursementAllocations(
        metadata.verification.reimbursementAllocations
    );

    for (const depositTxHash of depositTxHashes) {
        if (!depositPriceSnapshots.has(depositTxHash)) {
            throw new Error(
                `metadata.verification.depositPriceSnapshots is missing an entry for ${depositTxHash}.`
            );
        }
        if (!reimbursementAllocations.has(depositTxHash)) {
            throw new Error(
                `metadata.verification.reimbursementAllocations is missing an entry for ${depositTxHash}.`
            );
        }
    }

    return {
        proposalKind,
        proposalKindId,
        rulesHash,
        depositTxHashes,
        depositPriceSnapshots,
        reimbursementAllocations,
    };
}

function computeUsdValueMicros({ amountWei, decimals, priceMicros }) {
    return (BigInt(amountWei) * BigInt(priceMicros)) / 10n ** BigInt(decimals);
}

async function loadTokenDecimals({ publicClient, token, cache }) {
    if (cache.has(token)) {
        return cache.get(token);
    }
    let rawDecimals;
    try {
        rawDecimals = await publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'decimals',
        });
    } catch (error) {
        throw wrapVerificationUnknownError(
            error,
            `Token decimals for ${token} could not be loaded from chain`
        );
    }
    const decimals = Number(rawDecimals);
    if (!Number.isInteger(decimals) || decimals < 0) {
        throw new Error(`Token ${token} returned an invalid decimals value.`);
    }
    cache.set(token, decimals);
    return decimals;
}

function buildCheck(id, status, message, extra = {}) {
    return {
        id,
        status,
        message,
        ...extra,
    };
}

function parseEnvelopeFromRecord(record) {
    if (record?.artifact?.signedProposal?.envelope) {
        return buildSignedProposalEnvelope(record.artifact.signedProposal.envelope);
    }
    if (typeof record?.canonicalMessage !== 'string' || !record.canonicalMessage.trim()) {
        return null;
    }
    try {
        return buildSignedProposalEnvelope(JSON.parse(record.canonicalMessage));
    } catch {
        return null;
    }
}

function hasSameCommitmentContext(recordEnvelope, { commitmentSafe, ogModule }) {
    return Boolean(
        recordEnvelope &&
            recordEnvelope.commitmentSafe === commitmentSafe &&
            recordEnvelope.ogModule === ogModule
    );
}

function normalizeAddressOrNull(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    try {
        return getAddress(value).toLowerCase();
    } catch {
        return null;
    }
}

function inferAuthorizedAgentFromEnvelope(envelope) {
    try {
        const reimbursements = normalizeProposalReimbursementTransfers(envelope);
        const recipients = Array.from(new Set(reimbursements.map((entry) => entry.recipient)));
        return recipients.length === 1 ? recipients[0] : null;
    } catch {
        return null;
    }
}

function resolveRecordAuthorizedAgent(record, envelope) {
    const verifiedAgent = normalizeAddressOrNull(record?.verification?.derivedFacts?.authorizedAgent);
    if (verifiedAgent) {
        return verifiedAgent;
    }
    return inferAuthorizedAgentFromEnvelope(envelope);
}

async function resolveStoredProposalLifecycle({
    record,
    envelope = undefined,
    publicClient,
    lifecycleCache,
}) {
    const submission = record?.submission ?? { status: 'not_started' };
    if (submission.status === 'not_started' || submission.status === 'failed') {
        return 'available';
    }
    if (submission.status === 'uncertain') {
        return 'unknown';
    }
    if (!publicClient) {
        return 'unknown';
    }

    const resolvedEnvelope = envelope ?? parseEnvelopeFromRecord(record);
    if (!resolvedEnvelope) {
        return 'unknown';
    }

    let proposalHash = submission.ogProposalHash;
    let proposalCreationBlock = null;
    if (submission.transactionHash) {
        let receipt;
        try {
            receipt = await publicClient.getTransactionReceipt({
                hash: submission.transactionHash,
            });
        } catch {
            if (!proposalHash) {
                return 'unknown';
            }
        }
        if (receipt) {
            proposalCreationBlock = receipt.blockNumber ?? null;
            if (receipt?.status === 'reverted') {
                return 'available';
            }
            if (!proposalHash) {
                proposalHash = extractProposalHashFromReceipt({
                    receipt,
                    ogModule: resolvedEnvelope.ogModule,
                });
                if (!proposalHash) {
                    return 'available';
                }
            }
        }
    } else if (!proposalHash) {
        return 'unknown';
    }
    if (!proposalHash) {
        return 'unknown';
    }

    const cacheKey = `${resolvedEnvelope.ogModule}:${proposalHash}`;
    if (lifecycleCache.has(cacheKey)) {
        return lifecycleCache.get(cacheKey);
    }

    let latestBlock;
    let historyFromBlock;
    let executedLogs;
    let deletedLogs;
    try {
        latestBlock = await publicClient.getBlockNumber();
        historyFromBlock = await resolveOgHistoryStartBlock({
            publicClient,
            ogModule: resolvedEnvelope.ogModule,
            latestBlock,
            minimumFromBlock: proposalCreationBlock,
        });
        [executedLogs, deletedLogs] = await Promise.all([
            getLogsChunked({
                publicClient,
                address: resolvedEnvelope.ogModule,
                event: proposalExecutedEvent,
                args: {
                    proposalHash,
                },
                fromBlock: historyFromBlock,
                toBlock: latestBlock,
            }),
            getLogsChunked({
                publicClient,
                address: resolvedEnvelope.ogModule,
                event: proposalDeletedEvent,
                args: {
                    proposalHash,
                },
                fromBlock: historyFromBlock,
                toBlock: latestBlock,
            }),
        ]);
    } catch {
        return 'unknown';
    }

    let lifecycle = 'reserved';
    if (executedLogs.length > 0 && deletedLogs.length > 0) {
        lifecycle = 'unknown';
    } else if (executedLogs.length > 0) {
        lifecycle = 'consumed';
    } else if (deletedLogs.length > 0) {
        lifecycle = 'available';
    }

    lifecycleCache.set(cacheKey, lifecycle);
    return lifecycle;
}

function mergeDepositStatus(currentStatus, incomingStatus) {
    if (!currentStatus) {
        return incomingStatus;
    }
    return DEPOSIT_STATUS_RANK[incomingStatus] > DEPOSIT_STATUS_RANK[currentStatus]
        ? incomingStatus
        : currentStatus;
}

async function resolveReferencedDepositStatuses({
    depositTxHashes,
    storeRecords,
    chainId,
    currentPublicationKey,
    publicClient,
    commitmentSafe,
    ogModule,
    authorizedAgent,
    currentRulesHash,
}) {
    const statuses = new Map(depositTxHashes.map((depositTxHash) => [depositTxHash, 'available']));
    const lifecycleCache = new Map();

    for (const record of storeRecords) {
        if (!record || Number(record.chainId) !== Number(chainId)) {
            continue;
        }
        const recordKey = `${record.signer}:${record.chainId}:${record.requestId}`;
        if (currentPublicationKey && recordKey === currentPublicationKey) {
            continue;
        }
        const envelope = parseEnvelopeFromRecord(record);
        if (!envelope) {
            continue;
        }
        if (!hasSameCommitmentContext(envelope, { commitmentSafe, ogModule })) {
            continue;
        }

        let recordVerification;
        try {
            recordVerification = normalizeVerificationMetadata(envelope.metadata);
        } catch {
            continue;
        }
        if (recordVerification.proposalKindId !== PROPOSAL_KIND_IDS.AGENT_PROXY_REIMBURSEMENT) {
            continue;
        }

        const referenced = recordVerification.depositTxHashes.filter((depositTxHash) =>
            statuses.has(depositTxHash)
        );
        if (referenced.length === 0) {
            continue;
        }
        const recordAuthorizedAgent = resolveRecordAuthorizedAgent(record, envelope);
        if (recordAuthorizedAgent && recordAuthorizedAgent !== authorizedAgent) {
            continue;
        }
        if (!recordAuthorizedAgent && recordVerification.rulesHash !== currentRulesHash) {
            for (const depositTxHash of referenced) {
                statuses.set(
                    depositTxHash,
                    mergeDepositStatus(statuses.get(depositTxHash), 'unknown')
                );
            }
            continue;
        }

        const lifecycle = await resolveStoredProposalLifecycle({
            record,
            envelope,
            publicClient,
            lifecycleCache,
        });

        for (const depositTxHash of referenced) {
            statuses.set(
                depositTxHash,
                mergeDepositStatus(statuses.get(depositTxHash), lifecycle)
            );
        }
    }

    if (publicClient) {
        const onchainStatuses = await resolveOnchainProposalDepositStatuses({
            depositTxHashes,
            publicClient,
            ogModule,
        });
        for (const depositTxHash of depositTxHashes) {
            statuses.set(
                depositTxHash,
                mergeDepositStatus(
                    statuses.get(depositTxHash),
                    onchainStatuses.get(depositTxHash) ?? 'available'
                )
            );
        }
    }

    return statuses;
}

function decodeTransferLog(log) {
    try {
        const decoded = decodeEventLog({
            abi: erc20Abi,
            data: log.data,
            topics: log.topics,
        });
        if (decoded.eventName !== 'Transfer') {
            return null;
        }
        const from = getAddress(decoded.args.from).toLowerCase();
        const to = getAddress(decoded.args.to).toLowerCase();
        const amountWei = BigInt(decoded.args.value ?? 0n);
        if (amountWei <= 0n) {
            return null;
        }
        return {
            token: getAddress(log.address).toLowerCase(),
            from,
            to,
            amountWei: amountWei.toString(),
        };
    } catch {
        return null;
    }
}

function extractProposalHashFromReceipt({ receipt, ogModule }) {
    if (!receipt?.logs || !Array.isArray(receipt.logs)) {
        return null;
    }

    for (const log of receipt.logs) {
        let logAddress;
        try {
            logAddress = getAddress(log.address).toLowerCase();
        } catch {
            continue;
        }
        if (logAddress !== ogModule) {
            continue;
        }

        try {
            const decoded = decodeEventLog({
                abi: [transactionsProposedEvent],
                data: log.data,
                topics: log.topics,
            });
            if (decoded.eventName !== 'TransactionsProposed') {
                continue;
            }
            const proposalHash = normalizeHashOrNull(decoded.args?.proposalHash);
            if (proposalHash) {
                return proposalHash;
            }
        } catch {
            // Ignore non-matching logs.
        }
    }

    return null;
}

function decodeProposalExplanationText(explanationValue) {
    if (typeof explanationValue !== 'string' || !explanationValue) {
        return null;
    }
    if (!explanationValue.startsWith('0x')) {
        return explanationValue;
    }
    try {
        return hexToString(explanationValue);
    } catch {
        return null;
    }
}

async function resolveOnchainProposalDepositStatuses({
    depositTxHashes,
    publicClient,
    ogModule,
}) {
    const statuses = new Map(depositTxHashes.map((depositTxHash) => [depositTxHash, 'available']));

    let latestBlock;
    let historyFromBlock;
    let proposedLogs;
    let executedLogs;
    let deletedLogs;
    try {
        latestBlock = await publicClient.getBlockNumber();
        historyFromBlock = await resolveOgHistoryStartBlock({
            publicClient,
            ogModule,
            latestBlock,
        });
        [proposedLogs, executedLogs, deletedLogs] = await Promise.all([
            getLogsChunked({
                publicClient,
                address: ogModule,
                event: transactionsProposedEvent,
                fromBlock: historyFromBlock,
                toBlock: latestBlock,
            }),
            getLogsChunked({
                publicClient,
                address: ogModule,
                event: proposalExecutedEvent,
                fromBlock: historyFromBlock,
                toBlock: latestBlock,
            }),
            getLogsChunked({
                publicClient,
                address: ogModule,
                event: proposalDeletedEvent,
                fromBlock: historyFromBlock,
                toBlock: latestBlock,
            }),
        ]);
    } catch {
        for (const depositTxHash of depositTxHashes) {
            statuses.set(depositTxHash, 'unknown');
        }
        return statuses;
    }

    const executedHashes = new Set(
        executedLogs
            .map((log) => normalizeHashOrNull(log?.args?.proposalHash))
            .filter(Boolean)
    );
    const deletedHashes = new Set(
        deletedLogs
            .map((log) => normalizeHashOrNull(log?.args?.proposalHash))
            .filter(Boolean)
    );

    for (const log of proposedLogs) {
        const proposalHash = normalizeHashOrNull(log?.args?.proposalHash);
        if (!proposalHash) {
            continue;
        }
        const explanation = parseStructuredProposalExplanation(
            decodeProposalExplanationText(log?.args?.explanation),
            { requireDepositTxHashes: false }
        );
        if (
            !explanation ||
            explanation.kind !== 'agent_proxy_reimbursement' ||
            explanation.depositTxHashes.length === 0
        ) {
            continue;
        }
        const referenced = explanation.depositTxHashes.filter((depositTxHash) =>
            statuses.has(depositTxHash)
        );
        if (referenced.length === 0) {
            continue;
        }

        let lifecycle = 'reserved';
        if (executedHashes.has(proposalHash) && deletedHashes.has(proposalHash)) {
            lifecycle = 'unknown';
        } else if (executedHashes.has(proposalHash)) {
            lifecycle = 'consumed';
        } else if (deletedHashes.has(proposalHash)) {
            lifecycle = 'available';
        }

        for (const depositTxHash of referenced) {
            statuses.set(
                depositTxHash,
                mergeDepositStatus(statuses.get(depositTxHash), lifecycle)
            );
        }
    }

    return statuses;
}

async function resolveDepositReceiptEvidence({
    publicClient,
    depositTxHash,
    agentAddress,
    commitmentSafe,
}) {
    let receipt;
    try {
        receipt = await publicClient.getTransactionReceipt({ hash: depositTxHash });
    } catch (error) {
        throw wrapVerificationUnknownError(
            error,
            `Deposit transaction ${depositTxHash} receipt could not be loaded from chain`
        );
    }
    if (receipt.status === 'reverted') {
        throw new Error(`Deposit transaction ${depositTxHash} reverted.`);
    }
    const matches = receipt.logs
        .map((log) => decodeTransferLog(log))
        .filter(Boolean)
        .filter(
            (transfer) => transfer.from === agentAddress && transfer.to === commitmentSafe
        );
    if (matches.length === 0) {
        throw new Error(
            `Deposit transaction ${depositTxHash} does not include an ERC20 transfer from the authorized agent into the commitment Safe.`
        );
    }
    if (matches.length > 1) {
        throw new Error(
            `Deposit transaction ${depositTxHash} includes multiple matching agent-to-safe transfers and is ambiguous for verification.`
        );
    }
    return {
        depositTxHash,
        ...matches[0],
        blockNumber: receipt.blockNumber?.toString?.() ?? String(receipt.blockNumber),
    };
}

function normalizeProposalReimbursementTransfers(envelope) {
    const reimbursements = [];
    for (let index = 0; index < envelope.transactions.length; index += 1) {
        const transaction = envelope.transactions[index];
        if (transaction.operation !== 0) {
            throw new Error(
                `transactions[${index}] uses operation=${transaction.operation}; only direct ERC20 transfers are supported for agent_proxy_reimbursement verification.`
            );
        }
        if (BigInt(transaction.value) !== 0n) {
            throw new Error(
                `transactions[${index}] uses native value transfer; only ERC20 transfers are supported for agent_proxy_reimbursement verification.`
            );
        }
        const decoded = decodeErc20TransferCallData(transaction.data);
        if (!decoded) {
            throw new Error(
                `transactions[${index}] is not a decodable ERC20 transfer() call.`
            );
        }
        reimbursements.push({
            transactionIndex: index,
            token: getAddress(transaction.to).toLowerCase(),
            recipient: decoded.to,
            amountWei: decoded.amount.toString(),
        });
    }
    if (reimbursements.length === 0) {
        throw new Error('No reimbursement transfers were found in the proposal transactions.');
    }
    return reimbursements;
}

function sumAmountsByToken(reimbursements) {
    const totals = new Map();
    for (const reimbursement of reimbursements) {
        const nextValue =
            (totals.get(reimbursement.token) ?? 0n) + BigInt(reimbursement.amountWei);
        totals.set(reimbursement.token, nextValue);
    }
    return totals;
}

function mapsEqualBigIntAmounts(left, right) {
    if (left.size !== right.size) {
        return false;
    }
    for (const [key, leftValue] of left.entries()) {
        if ((right.get(key) ?? 0n) !== leftValue) {
            return false;
        }
    }
    return true;
}

async function verifyAgentProxyReimbursement({
    envelope,
    parsedRules,
    verificationMetadata,
    publicClient,
    storeRecords,
    currentPublicationKey,
    checks,
    derivedFacts,
}) {
    const agentProxyTemplate = parsedRules.matchedTemplates.find(
        (template) => template.templateId === 'agent_proxy'
    );
    if (!agentProxyTemplate?.params?.agentAddress) {
        checks.push(
            buildCheck(
                'agent_proxy_rule_present',
                'fail',
                'The rules do not contain a parseable Agent Proxy template.'
            )
        );
        return;
    }

    const authorizedAgent = agentProxyTemplate.params.agentAddress;
    derivedFacts.authorizedAgent = authorizedAgent;

    let reimbursements;
    try {
        reimbursements = normalizeProposalReimbursementTransfers(envelope);
        checks.push(
            buildCheck(
                'reimbursement_transfers_decoded',
                'pass',
                'Proposal transactions decode to direct ERC20 reimbursement transfers.'
            )
        );
    } catch (error) {
        checks.push(
            buildCheck(
                'reimbursement_transfers_decoded',
                'fail',
                error?.message ?? String(error)
            )
        );
        return;
    }

    const wrongRecipients = reimbursements.filter(
        (reimbursement) => reimbursement.recipient !== authorizedAgent
    );
    if (wrongRecipients.length > 0) {
        checks.push(
            buildCheck(
                'authorized_agent_recipient',
                'fail',
                'One or more reimbursement transfers target an address other than the authorized agent.',
                {
                    recipients: Array.from(
                        new Set(wrongRecipients.map((entry) => entry.recipient))
                    ),
                }
            )
        );
        return;
    }
    checks.push(
        buildCheck(
            'authorized_agent_recipient',
            'pass',
            'All reimbursement transfers target the authorized agent.'
        )
    );

    const explanation = parseStructuredProposalExplanation(envelope.explanation, {
        requireDepositTxHashes: true,
    });
    if (!explanation || explanation.kind !== verificationMetadata.proposalKind) {
        checks.push(
            buildCheck(
                'explanation_references',
                'fail',
                'Proposal explanation must be a structured JSON object with kind, description, and depositTxHashes for agent_proxy_reimbursement.'
            )
        );
        return;
    }
    const explanationDepositTxHashes = explanation.depositTxHashes;
    const metadataDepositTxHashes = verificationMetadata.depositTxHashes;
    const explanationMatchesMetadata =
        explanationDepositTxHashes.length === metadataDepositTxHashes.length &&
        explanationDepositTxHashes.every(
            (depositTxHash, index) => depositTxHash === metadataDepositTxHashes[index]
        );
    if (!explanationMatchesMetadata) {
        checks.push(
            buildCheck(
                'explanation_references',
                'fail',
                'Proposal explanation depositTxHashes do not match signed metadata.verification.depositTxHashes.'
            )
        );
        return;
    }
    derivedFacts.explanationDescription = explanation.description;
    checks.push(
        buildCheck(
            'explanation_references',
            'pass',
            'Proposal explanation includes structured deposit references that match the signed verification metadata.'
        )
    );

    if (!publicClient) {
        checks.push(
            buildCheck(
                'onchain_evidence_available',
                'unknown',
                'A verification runtime was not available, so deposit receipts and token decimals could not be checked.'
            )
        );
        return;
    }

    const depositStatuses = await resolveReferencedDepositStatuses({
        depositTxHashes: verificationMetadata.depositTxHashes,
        storeRecords,
        chainId: envelope.chainId,
        currentPublicationKey,
        publicClient,
        commitmentSafe: envelope.commitmentSafe,
        ogModule: envelope.ogModule,
        authorizedAgent,
        currentRulesHash: verificationMetadata.rulesHash,
    });
    const referencedDeposits = [];
    let hasUnavailableDeposit = false;
    let hasUnknownDepositState = false;

    for (const depositTxHash of verificationMetadata.depositTxHashes) {
        const status = depositStatuses.get(depositTxHash) ?? 'available';
        referencedDeposits.push({
            depositTxHash,
            statusBeforeVerification: status,
        });
        if (status === 'reserved' || status === 'consumed') {
            hasUnavailableDeposit = true;
        } else if (status === 'unknown') {
            hasUnknownDepositState = true;
        }
    }
    derivedFacts.referencedDeposits = referencedDeposits;
    if (hasUnavailableDeposit) {
        checks.push(
            buildCheck(
                'deposit_reuse',
                'fail',
                'At least one referenced deposit is already reserved by a live proposal or consumed by an executed proposal.'
            )
        );
        return;
    }
    if (hasUnknownDepositState) {
        checks.push(
            buildCheck(
                'deposit_reuse',
                'unknown',
                'At least one referenced deposit has an unresolved proposal lifecycle state.'
            )
        );
        return;
    }
    checks.push(
        buildCheck(
            'deposit_reuse',
            'pass',
            'All referenced deposits are currently available for reimbursement.'
        )
    );

    const proposalTotalsByToken = sumAmountsByToken(reimbursements);
    const allocatedTotalsByToken = new Map();
    const tokenDecimalsCache = new Map();
    let aggregateDepositUsdMicros = 0n;
    let aggregateAllocatedUsdMicros = 0n;

    for (const depositTxHash of verificationMetadata.depositTxHashes) {
        const depositEvidence = await resolveDepositReceiptEvidence({
            publicClient,
            depositTxHash,
            agentAddress: authorizedAgent,
            commitmentSafe: envelope.commitmentSafe,
        });
        const snapshot = verificationMetadata.depositPriceSnapshots.get(depositTxHash);
        const allocation = verificationMetadata.reimbursementAllocations.get(depositTxHash);
        const depositDecimals = await loadTokenDecimals({
            publicClient,
            token: depositEvidence.token,
            cache: tokenDecimalsCache,
        });
        const depositUsdMicros = computeUsdValueMicros({
            amountWei: depositEvidence.amountWei,
            decimals: depositDecimals,
            priceMicros: snapshot.depositAssetPriceUsdMicros,
        });

        let allocatedUsdMicros = 0n;
        for (const reimbursement of allocation) {
            const tokenDecimals = await loadTokenDecimals({
                publicClient,
                token: reimbursement.token,
                cache: tokenDecimalsCache,
            });
            const reimbursementPriceUsdMicros =
                snapshot.reimbursementAssetPricesUsdMicros[reimbursement.token];
            if (!reimbursementPriceUsdMicros) {
                throw new Error(
                    `No reimbursementAssetPricesUsdMicros entry exists for token ${reimbursement.token} in deposit snapshot ${depositTxHash}.`
                );
            }
            allocatedUsdMicros += computeUsdValueMicros({
                amountWei: reimbursement.amountWei,
                decimals: tokenDecimals,
                priceMicros: reimbursementPriceUsdMicros,
            });
            allocatedTotalsByToken.set(
                reimbursement.token,
                (allocatedTotalsByToken.get(reimbursement.token) ?? 0n) +
                    BigInt(reimbursement.amountWei)
            );
        }

        aggregateDepositUsdMicros += depositUsdMicros;
        aggregateAllocatedUsdMicros += allocatedUsdMicros;

        const referencedDeposit = referencedDeposits.find(
            (entry) => entry.depositTxHash === depositTxHash
        );
        Object.assign(referencedDeposit, {
            depositToken: depositEvidence.token,
            depositAmountWei: depositEvidence.amountWei,
            depositUsdMicros: depositUsdMicros.toString(),
            allocatedUsdMicros: allocatedUsdMicros.toString(),
            statusAfterExecution: 'consumed',
        });

        if (allocatedUsdMicros > depositUsdMicros) {
            checks.push(
                buildCheck(
                    'whole_batch_value_ceiling',
                    'fail',
                    `Allocated reimbursement value for deposit ${depositTxHash} exceeds that deposit's deposit-time value ceiling.`
                )
            );
            return;
        }
    }

    if (!mapsEqualBigIntAmounts(proposalTotalsByToken, allocatedTotalsByToken)) {
        checks.push(
            buildCheck(
                'allocation_matches_transactions',
                'fail',
                'Signed reimbursement allocations do not sum to the proposal transactions.'
            )
        );
        return;
    }
    checks.push(
        buildCheck(
            'allocation_matches_transactions',
            'pass',
            'Signed reimbursement allocations sum exactly to the proposal transactions.'
        )
    );

    derivedFacts.totalBatchDepositValueUsdMicros = aggregateDepositUsdMicros.toString();
    derivedFacts.reimbursementValueUsdMicros = aggregateAllocatedUsdMicros.toString();
    derivedFacts.roundingShortfallUsdMicros = (
        aggregateDepositUsdMicros > aggregateAllocatedUsdMicros
            ? aggregateDepositUsdMicros - aggregateAllocatedUsdMicros
            : 0n
    ).toString();

    checks.push(
        buildCheck(
            'whole_batch_value_ceiling',
            'pass',
            'Allocated reimbursement value does not exceed the aggregate deposit-time value of the referenced deposit batch.'
        )
    );
}

async function verifyProposal({
    envelope,
    publicClient = undefined,
    storeRecords = [],
    currentPublicationKey = null,
    nowMs = Date.now(),
} = {}) {
    const normalizedEnvelope = buildSignedProposalEnvelope(envelope);
    const checks = [];
    const derivedFacts = {};

    let verificationMetadata;
    try {
        verificationMetadata = normalizeVerificationMetadata(normalizedEnvelope.metadata);
        checks.push(
            buildCheck(
                'verification_metadata',
                'pass',
                'Signed verification metadata is present and well-formed.'
            )
        );
    } catch (error) {
        checks.push(
            buildCheck(
                'verification_metadata',
                'fail',
                error?.message ?? String(error)
            )
        );
        return {
            status: 'invalid',
            verifiedAtMs: nowMs,
            proposalKind: null,
            rules: null,
            checks,
            derivedFacts,
        };
    }

    let effectiveRulesText = null;
    let didReportRulesTextUnavailable = false;
    if (publicClient) {
        try {
            effectiveRulesText = await publicClient.readContract({
                address: normalizedEnvelope.ogModule,
                abi: optimisticGovernorAbi,
                functionName: 'rules',
            });
        } catch (error) {
            checks.push(
                buildCheck(
                    'rules_text',
                    'unknown',
                    `Rules text could not be loaded from the OG module: ${error?.message ?? error}`
                )
            );
            didReportRulesTextUnavailable = true;
        }
    } else {
        checks.push(
            buildCheck(
                'rules_text',
                'unknown',
                'Rules text could not be loaded from the OG module because no verification runtime was available.'
            )
        );
        didReportRulesTextUnavailable = true;
    }

    let rules = null;
    if (effectiveRulesText !== null) {
        try {
            const computedRulesHash = computeRulesHash(effectiveRulesText);
            if (computedRulesHash !== verificationMetadata.rulesHash) {
                checks.push(
                    buildCheck(
                        'rules_hash',
                        'fail',
                        'Signed metadata.rulesHash does not match the current onchain rules text.'
                    )
                );
            } else {
                checks.push(
                    buildCheck(
                        'rules_hash',
                        'pass',
                        'Signed metadata.rulesHash matches the current onchain rules text.'
                    )
                );
            }
            rules = {
                rulesHash: computedRulesHash,
                ...parseStandardCommitmentRules(effectiveRulesText, {
                    proposalKind: verificationMetadata.proposalKind,
                }),
            };
        } catch (error) {
            checks.push(
                buildCheck(
                    'rules_text',
                    'fail',
                    error?.message ?? String(error)
                )
            );
        }
    } else if (!didReportRulesTextUnavailable) {
        checks.push(
            buildCheck(
                'rules_text',
                'unknown',
                'Rules text could not be loaded from the OG module.'
            )
        );
    }

    if (rules) {
        const unsupportedTemplates = rules.matchedTemplates.filter(
            (template) => template.coverage === 'unsupported'
        );
        if (rules.unparsedSections.length > 0 || unsupportedTemplates.length > 0) {
            checks.push(
                buildCheck(
                    'template_coverage',
                    'unknown',
                    'The rules include unparsed or unsupported templates for this verifier profile.',
                    {
                        unsupportedTemplateIds: unsupportedTemplates.map(
                            (template) => template.templateId
                        ),
                        unparsedSectionTitles: rules.unparsedSections.map(
                            (section) => section.title
                        ),
                    }
                )
            );
        } else {
            checks.push(
                buildCheck(
                    'template_coverage',
                    'pass',
                    'All parsed rule templates are within the verifier coverage for this proposal kind.'
                )
            );
        }
    }

    if (
        checks.some((check) => check.id === 'verification_metadata' && check.status === 'fail') ||
        checks.some((check) => check.id === 'rules_hash' && check.status === 'fail') ||
        checks.some((check) => check.id === 'rules_text' && check.status === 'fail')
    ) {
        return {
            status: 'invalid',
            verifiedAtMs: nowMs,
            proposalKind: verificationMetadata.proposalKind,
            rules,
            checks,
            derivedFacts,
        };
    }

    if (verificationMetadata.proposalKindId === PROPOSAL_KIND_IDS.AGENT_PROXY_REIMBURSEMENT && rules) {
        try {
            await verifyAgentProxyReimbursement({
                envelope: normalizedEnvelope,
                parsedRules: rules,
                verificationMetadata,
                publicClient,
                storeRecords,
                currentPublicationKey,
                checks,
                derivedFacts,
            });
        } catch (error) {
            checks.push(
                buildCheck(
                    'agent_proxy_reimbursement',
                    error instanceof VerificationUnknownError ? 'unknown' : 'fail',
                    error?.message ?? String(error)
                )
            );
        }
    }

    let status = 'valid';
    if (checks.some((check) => check.status === 'fail')) {
        status = 'invalid';
    } else if (checks.some((check) => check.status === 'unknown')) {
        status = 'unknown';
    }

    return {
        status,
        verifiedAtMs: nowMs,
        proposalKind: verificationMetadata.proposalKind,
        rules,
        checks,
        derivedFacts,
    };
}

export {
    PROPOSAL_KIND_IDS,
    computeRulesHash,
    normalizeProposalKind,
    parseStandardCommitmentRules,
    verifyProposal,
};
