import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { erc20Abi, getAddress, isAddressEqual, zeroAddress } from 'viem';
import { buildSignedMessagePayload } from '../../../agent/src/lib/message-signing.js';
import { getAlwaysEmitBalanceSnapshotPollingOptions } from '../../../agent/src/lib/polling.js';
import { buildOgTransactions } from '../../../agent/src/lib/tx.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_VERSION = 1;
const ARTIFACT_VERSION = 'oya-signed-request-archive-v1';
const REIMBURSEMENT_EXPLANATION_VERSION = 'oya-fast-withdraw-reimbursement-v1';
const FILENAME_PREFIX = 'signed-request-';
const FILENAME_SUFFIX = '.json';
const DIRECT_FILL_CONFIRMATION_THRESHOLD = 3n;

const requestArchiveState = {
    requests: {},
};
let requestArchiveStateHydrated = false;
const pendingArtifactPublishes = new Map();
let pendingDirectFill = null;
let pendingReimbursementProposal = null;
let statePathOverride = null;
const assetMetadataCache = new Map();

function getStatePath() {
    if (typeof statePathOverride === 'string' && statePathOverride.trim()) {
        return path.resolve(statePathOverride.trim());
    }
    return path.join(__dirname, '.request-archive-state.json');
}

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = canonicalize(value[key]);
        }
        return out;
    }
    return value;
}

function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

function normalizeAddress(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('Address must be a non-empty string.');
    }
    return getAddress(value.trim());
}

function normalizeAssetAddress(value) {
    const normalized = normalizeAddress(value);
    return isAddressEqual(normalized, zeroAddress) ? zeroAddress : normalized;
}

function parsePositiveAmountWei(value, fieldName = 'amountWei') {
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

function parseMaybeBigInt(value) {
    if (value === undefined || value === null || value === '') return null;
    try {
        return BigInt(value);
    } catch (error) {
        return null;
    }
}

function normalizeRequestId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isRequestExpired(record, nowMs = Date.now()) {
    const deadline = Number(record?.deadline ?? 0);
    return Number.isInteger(deadline) && deadline > 0 && nowMs > deadline;
}

function getTrackedAssets(config = {}) {
    const assets = new Set();
    for (const asset of Array.isArray(config.watchAssets) ? config.watchAssets : []) {
        assets.add(normalizeAssetAddress(String(asset)));
    }
    if (config.watchNativeBalance) {
        assets.add(zeroAddress);
    }
    return Array.from(assets);
}

async function getAssetMetadata(publicClient, asset) {
    const normalizedAsset = normalizeAssetAddress(asset);
    const cacheKey = normalizedAsset.toLowerCase();
    if (assetMetadataCache.has(cacheKey)) {
        return assetMetadataCache.get(cacheKey);
    }

    let metadata;
    if (isAddressEqual(normalizedAsset, zeroAddress)) {
        metadata = {
            asset: zeroAddress,
            assetKind: 'native',
            symbol: 'ETH',
            decimals: 18,
        };
    } else {
        let symbol = normalizedAsset;
        let decimals = 18;
        try {
            symbol = await publicClient.readContract({
                address: normalizedAsset,
                abi: erc20Abi,
                functionName: 'symbol',
            });
        } catch (error) {
            // Some ERC20s omit symbol() or return malformed data; keep address fallback.
        }
        try {
            decimals = Number(
                await publicClient.readContract({
                    address: normalizedAsset,
                    abi: erc20Abi,
                    functionName: 'decimals',
                })
            );
        } catch (error) {
            decimals = 18;
        }
        metadata = {
            asset: normalizedAsset,
            assetKind: 'erc20',
            symbol: typeof symbol === 'string' && symbol.trim() ? symbol.trim() : normalizedAsset,
            decimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : 18,
        };
    }

    assetMetadataCache.set(cacheKey, metadata);
    return metadata;
}

async function getAssetBalances({ publicClient, asset, commitmentSafe, agentAddress, blockNumber }) {
    const normalizedAsset = normalizeAssetAddress(asset);
    if (isAddressEqual(normalizedAsset, zeroAddress)) {
        const [safeBalance, agentBalance] = await Promise.all([
            publicClient.getBalance({ address: commitmentSafe, blockNumber }),
            publicClient.getBalance({ address: agentAddress, blockNumber }),
        ]);
        return {
            safeBalance,
            agentBalance,
        };
    }

    const [safeBalance, agentBalance] = await Promise.all([
        publicClient.readContract({
            address: normalizedAsset,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [commitmentSafe],
            blockNumber,
        }),
        publicClient.readContract({
            address: normalizedAsset,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [agentAddress],
            blockNumber,
        }),
    ]);
    return {
        safeBalance,
        agentBalance,
    };
}

function buildReimbursementExplanation(record) {
    if (!record?.requestId || !record?.artifactUri || !record?.directFillTxHash) {
        return null;
    }
    return JSON.stringify({
        version: REIMBURSEMENT_EXPLANATION_VERSION,
        requestId: record.requestId,
        signedRequestCid: record.artifactUri,
        fillTxHash: record.directFillTxHash,
    });
}

function buildExpectedReimbursementTransactions({ record, agentAddress, config }) {
    if (!record?.directFillAsset || !record?.directFillAmountWei || !agentAddress) {
        return null;
    }
    const normalizedAgent = normalizeAddress(agentAddress);
    const actions = [
        isAddressEqual(record.directFillAsset, zeroAddress)
            ? {
                  kind: 'native_transfer',
                  to: normalizedAgent,
                  amountWei: String(record.directFillAmountWei),
              }
            : {
                  kind: 'erc20_transfer',
                  token: normalizeAddress(record.directFillAsset),
                  to: normalizedAgent,
                  amountWei: String(record.directFillAmountWei),
              },
    ];
    return buildOgTransactions(actions, { config });
}

function getRequestLifecycleStatus(record, nowMs = Date.now()) {
    if (!record) return 'unknown';
    if (record.reimbursementExecutedAtMs) return 'reimbursed';
    if (record.reimbursementProposalHash || record.reimbursementSubmissionTxHash) {
        return 'reimbursement_submitted';
    }
    if (record.directFillConfirmed) {
        return 'fill_confirmed';
    }
    if (record.directFillTxHash) {
        return 'fill_submitted';
    }
    if (record.artifactCid) {
        return isRequestExpired(record, nowMs) ? 'archived_expired' : 'archived';
    }
    return 'received';
}

async function hydrateRequestArchiveState() {
    if (requestArchiveStateHydrated) return;
    requestArchiveStateHydrated = true;
    try {
        const raw = await readFile(getStatePath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            requestArchiveState.requests =
                parsed.requests && typeof parsed.requests === 'object' && !Array.isArray(parsed.requests)
                    ? parsed.requests
                    : {};
        }
    } catch (error) {
        requestArchiveState.requests = {};
    }
}

async function persistRequestArchiveState() {
    const payload = JSON.stringify(
        {
            version: STATE_VERSION,
            requests: requestArchiveState.requests,
        },
        null,
        2
    );
    await writeFile(getStatePath(), payload, 'utf8');
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

function encodeRequestIdForFilename(requestId) {
    return Buffer.from(String(requestId), 'utf8').toString('hex');
}

function decodeRequestIdFromFilename(filename) {
    if (typeof filename !== 'string') return null;
    if (!filename.startsWith(FILENAME_PREFIX) || !filename.endsWith(FILENAME_SUFFIX)) {
        return null;
    }
    const encoded = filename.slice(FILENAME_PREFIX.length, -FILENAME_SUFFIX.length);
    if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encoded)) {
        return null;
    }
    try {
        return Buffer.from(encoded, 'hex').toString('utf8');
    } catch (error) {
        return null;
    }
}

function buildArtifactFilename(requestId) {
    return `${FILENAME_PREFIX}${encodeRequestIdForFilename(requestId)}${FILENAME_SUFFIX}`;
}

function buildSignedRequestArchiveArtifact({ message, commitmentSafe, agentAddress }) {
    if (!isSignedUserMessage(message)) {
        throw new Error('buildSignedRequestArchiveArtifact requires a signed userMessage signal.');
    }

    const canonicalSignedMessage = buildSignedMessagePayload({
        address: message.sender.address,
        timestampMs: message.sender.signedAtMs,
        text: message.text,
        command: message.command,
        args: message.args,
        metadata: message.metadata,
        requestId: message.requestId,
        deadline: message.deadline,
    });

    return {
        version: ARTIFACT_VERSION,
        requestId: message.requestId,
        messageId: message.messageId ?? null,
        signedRequest: {
            authType: 'eip191',
            signer: message.sender.address,
            signature: message.sender.signature,
            signedAtMs: message.sender.signedAtMs,
            canonicalMessage: canonicalSignedMessage,
            envelope: {
                requestId: message.requestId,
                deadline: message.deadline ?? null,
                text: message.text ?? null,
                command: message.command ?? null,
                args: cloneJson(message.args ?? null),
                metadata: cloneJson(message.metadata ?? null),
            },
        },
        agentContext: {
            commitmentSafe: commitmentSafe ?? null,
            agentAddress: agentAddress ?? null,
            receivedAtMs: message.receivedAtMs ?? null,
            expiresAtMs: message.expiresAtMs ?? null,
        },
    };
}

function buildSignedRequestArchiveRecord({ message, commitmentSafe, agentAddress }) {
    return {
        requestId: message.requestId,
        messageId: message.messageId ?? null,
        signer: message.sender.address,
        signature: message.sender.signature,
        signedAtMs: message.sender.signedAtMs,
        deadline: message.deadline ?? null,
        text: message.text ?? null,
        command: message.command ?? null,
        args: cloneJson(message.args ?? null),
        metadata: cloneJson(message.metadata ?? null),
        commitmentSafe: commitmentSafe ?? null,
        agentAddress: agentAddress ?? null,
    };
}

function buildSignedRequestArchiveSignal({ message, commitmentSafe, agentAddress, archivedRequest }) {
    const archiveArtifact = buildSignedRequestArchiveArtifact({
        message,
        commitmentSafe,
        agentAddress,
    });
    const archiveFilename = buildArtifactFilename(message.requestId);

    return {
        kind: 'signedRequestArchive',
        requestId: message.requestId,
        messageId: message.messageId ?? null,
        signer: message.sender.address,
        signature: message.sender.signature,
        signedAtMs: message.sender.signedAtMs,
        archiveFilename,
        archiveArtifact,
        archived: Boolean(archivedRequest?.artifactCid),
        artifactCid: archivedRequest?.artifactCid ?? null,
        artifactUri: archivedRequest?.artifactUri ?? null,
        pinned: archivedRequest?.pinned ?? null,
        directFillTxHash: archivedRequest?.directFillTxHash ?? null,
        reimbursementProposalHash: archivedRequest?.reimbursementProposalHash ?? null,
    };
}

function buildFastWithdrawRequestSignal({
    record,
    agentAddress,
    config,
    nowMs,
}) {
    const normalizedAgentAddress = agentAddress ?? record?.agentAddress ?? null;
    const fillConfirmations = Number(record?.directFillConfirmations ?? 0);
    const fillConfirmedEnough = fillConfirmations >= Number(DIRECT_FILL_CONFIRMATION_THRESHOLD);
    const expired = isRequestExpired(record, nowMs);
    const expectedReimbursementExplanation = buildReimbursementExplanation(record);
    const expectedReimbursementTransactions = fillConfirmedEnough && !expired
        ? buildExpectedReimbursementTransactions({
              record,
              agentAddress: normalizedAgentAddress,
              config,
          })
        : null;
    const reimbursementPending = Boolean(
        record?.reimbursementProposalHash || record?.reimbursementSubmissionTxHash
    );

    return {
        kind: 'fastWithdrawRequest',
        requestId: record.requestId,
        messageId: record.messageId ?? null,
        status: getRequestLifecycleStatus(record, nowMs),
        signer: record.signer ?? null,
        signature: record.signature ?? null,
        signedAtMs: record.signedAtMs ?? null,
        deadline: record.deadline ?? null,
        expired,
        text: record.text ?? null,
        command: record.command ?? null,
        metadata: cloneJson(record.metadata ?? null),
        archived: Boolean(record.artifactCid),
        artifactCid: record.artifactCid ?? null,
        artifactUri: record.artifactUri ?? null,
        directFillAsset: record.directFillAsset ?? null,
        directFillRecipient: record.directFillRecipient ?? null,
        directFillAmountWei: record.directFillAmountWei ?? null,
        directFillTxHash: record.directFillTxHash ?? null,
        directFillConfirmations: fillConfirmations,
        fillConfirmationThreshold: Number(DIRECT_FILL_CONFIRMATION_THRESHOLD),
        directFillConfirmed: fillConfirmedEnough,
        reimbursementProposalHash: record.reimbursementProposalHash ?? null,
        reimbursementSubmissionTxHash: record.reimbursementSubmissionTxHash ?? null,
        expectedReimbursementExplanation,
        expectedReimbursementTransactions,
        eligibleForDirectFill:
            Boolean(record.artifactCid) &&
            !record.directFillTxHash &&
            !reimbursementPending &&
            !expired,
        eligibleForReimbursement:
            Boolean(record.artifactCid) &&
            Boolean(record.directFillTxHash) &&
            fillConfirmedEnough &&
            !reimbursementPending &&
            !expired,
    };
}

async function refreshRequestStateFromChain({ publicClient, latestBlock }) {
    if (!publicClient) {
        return;
    }
    let changed = false;
    const currentBlock =
        latestBlock !== undefined && latestBlock !== null
            ? BigInt(latestBlock)
            : await publicClient.getBlockNumber();

    for (const record of Object.values(requestArchiveState.requests)) {
        if (!record?.directFillTxHash) continue;
        try {
            const receipt = await publicClient.getTransactionReceipt({
                hash: record.directFillTxHash,
            });
            const confirmations = Number(currentBlock - receipt.blockNumber + 1n);
            const previouslyConfirmed = Boolean(record.directFillConfirmed);
            if (record.directFillReceiptBlockNumber !== receipt.blockNumber.toString()) {
                record.directFillReceiptBlockNumber = receipt.blockNumber.toString();
                changed = true;
            }
            if (record.directFillConfirmations !== confirmations) {
                record.directFillConfirmations = confirmations;
                changed = true;
            }
            const nowConfirmed = confirmations >= Number(DIRECT_FILL_CONFIRMATION_THRESHOLD);
            if (record.directFillConfirmed !== nowConfirmed) {
                record.directFillConfirmed = nowConfirmed;
                changed = true;
            }
            if (nowConfirmed && !previouslyConfirmed && !record.directFillConfirmedAtMs) {
                record.directFillConfirmedAtMs = Date.now();
                changed = true;
            }
        } catch (error) {
            // Receipt not yet available or transient RPC issue; keep current state.
        }
    }

    if (changed) {
        await persistRequestArchiveState();
    }
}

function parseCallArgs(call) {
    if (call?.parsedArguments && typeof call.parsedArguments === 'object') {
        return call.parsedArguments;
    }
    if (typeof call?.arguments === 'string') {
        try {
            return JSON.parse(call.arguments);
        } catch (error) {
            return null;
        }
    }
    return null;
}

function getSystemPrompt({ proposeEnabled, disputeEnabled, commitmentText }) {
    const mode = proposeEnabled && disputeEnabled
        ? 'You may use proposal and dispute tools when the fast-withdraw lifecycle requires them.'
        : proposeEnabled
          ? 'You may propose when the fast-withdraw lifecycle requires it, but you may not dispute.'
          : disputeEnabled
            ? 'You may dispute when the fast-withdraw lifecycle requires it, but you may not propose.'
            : 'You may not propose or dispute; only archival and direct-fill reasoning are available.';

    return [
        'You are a fast-withdraw commitment agent.',
        'Focus on signed userMessage signals that represent user withdrawal requests.',
        'The first required step is to archive each signed request to IPFS before any direct fill or reimbursement logic.',
        'Use the signed human-readable message text as the source of withdrawal intent. Do not treat args as authoritative execution instructions.',
        'Only use assets that appear in fastWithdrawAsset signals. Use their symbol, decimals, and balances to map the signed human request to a concrete asset address and onchain amount.',
        'When a signedRequestArchive signal is present and archived is false, use ipfs_publish with exactly that signal’s archiveArtifact and archiveFilename. You may then call make_transfer for that same request in the same response, but only after ipfs_publish.',
        'Use make_transfer for the direct fill from the agent wallet to the recipient inferred from the signed text.',
        'A direct fill is only complete once its transaction has enough confirmations. Wait until fastWithdrawRequest.directFillConfirmations is at least fastWithdrawRequest.fillConfirmationThreshold before reimbursement.',
        'Once fastWithdrawRequest.eligibleForReimbursement is true, use post_bond_and_propose directly with the exact expectedReimbursementTransactions and expectedReimbursementExplanation from that signal. Do not rely on auto-posting from build_og_transactions.',
        'Do not reimburse or dispute unless later logic proves the direct fill and reimbursement satisfy the commitment.',
        'If asset, amount, or recipient cannot be inferred confidently from the signed text, return ignore.',
        mode,
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

async function enrichSignals(signals, {
    publicClient,
    config,
    account,
    nowMs,
    latestBlock,
} = {}) {
    await hydrateRequestArchiveState();
    await refreshRequestStateFromChain({ publicClient, latestBlock });
    const commitmentSafe = config?.commitmentSafe;
    const agentAddress = account?.address ?? null;
    const out = Array.isArray(signals) ? [...signals] : [];

    if (publicClient && commitmentSafe && agentAddress) {
        for (const asset of getTrackedAssets(config)) {
            const metadata = await getAssetMetadata(publicClient, asset);
            const balances = await getAssetBalances({
                publicClient,
                asset,
                commitmentSafe,
                agentAddress,
                blockNumber: latestBlock,
            });
            out.push({
                kind: 'fastWithdrawAsset',
                asset: metadata.asset,
                assetKind: metadata.assetKind,
                symbol: metadata.symbol,
                decimals: metadata.decimals,
                safeBalance: balances.safeBalance,
                agentBalance: balances.agentBalance,
            });
        }
    }

    for (const signal of Array.isArray(signals) ? signals : []) {
        if (!isSignedUserMessage(signal)) continue;
        const archivedRequest = requestArchiveState.requests?.[signal.requestId] ?? null;
        out.push(
            buildSignedRequestArchiveSignal({
                message: signal,
                commitmentSafe,
                agentAddress,
                archivedRequest,
            })
        );
    }

    for (const record of Object.values(requestArchiveState.requests)) {
        out.push(
            buildFastWithdrawRequestSignal({
                record,
                agentAddress,
                config,
                nowMs: nowMs ?? Date.now(),
            })
        );
    }
    return out;
}

async function validateToolCalls({
    toolCalls,
    signals,
    config,
    agentAddress,
}) {
    await hydrateRequestArchiveState();
    const archiveSignals = new Map();
    const requestSignals = [];
    const assetSignalsByAsset = new Map();
    for (const signal of Array.isArray(signals) ? signals : []) {
        if (signal?.kind === 'signedRequestArchive') {
            if (typeof signal.requestId !== 'string' || !signal.requestId.trim()) continue;
            archiveSignals.set(signal.requestId, signal);
            continue;
        }
        if (signal?.kind === 'fastWithdrawRequest') {
            requestSignals.push(signal);
            continue;
        }
        if (signal?.kind === 'fastWithdrawAsset') {
            try {
                assetSignalsByAsset.set(normalizeAssetAddress(signal.asset), signal);
            } catch (error) {
                // Ignore malformed asset context signals.
            }
        }
    }

    const validatedArchiveCalls = [];
    const validatedFillCalls = [];
    const validatedProposalCalls = [];
    let archiveApprovedRequestId = null;
    let fillApprovedRequestId = null;
    let proposalApprovedRequestId = null;

    function getEligibleDirectFillSignals() {
        return requestSignals.filter((signal) => signal?.eligibleForDirectFill === true);
    }

    function getEligibleReimbursementSignals() {
        return requestSignals.filter((signal) => signal?.eligibleForReimbursement === true);
    }

    function resolveDirectFillRequestId() {
        if (archiveApprovedRequestId) {
            return archiveApprovedRequestId;
        }
        const eligible = getEligibleDirectFillSignals();
        if (eligible.length === 1) {
            return eligible[0].requestId;
        }
        if (eligible.length > 1) {
            throw new Error(
                'Multiple archived fast-withdraw requests are eligible for direct fill; refusing ambiguous make_transfer.'
            );
        }
        throw new Error('No fast-withdraw request is eligible for direct fill.');
    }

    function resolveReimbursementRequest(args) {
        const eligible = getEligibleReimbursementSignals();
        if (eligible.length === 0) {
            throw new Error('No fast-withdraw request is eligible for reimbursement proposal.');
        }
        const explanation = typeof args?.explanation === 'string' ? args.explanation.trim() : '';
        if (explanation) {
            const matched = eligible.filter(
                (signal) => signal.expectedReimbursementExplanation === explanation
            );
            if (matched.length === 1) {
                return matched[0];
            }
        }
        if (eligible.length === 1) {
            return eligible[0];
        }
        throw new Error(
            'Multiple fast-withdraw requests are eligible for reimbursement; use the exact expected explanation to disambiguate.'
        );
    }

    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        if (call?.name === 'ipfs_publish') {
            if (!config?.ipfsEnabled) {
                throw new Error('fast-withdraw archival requires IPFS_ENABLED=true.');
            }

            const args = parseCallArgs(call);
            if (!args || typeof args !== 'object') {
                throw new Error('ipfs_publish requires valid arguments.');
            }
            if (typeof args.filename !== 'string' || !args.filename.trim()) {
                throw new Error('ipfs_publish filename is required.');
            }
            const requestId = decodeRequestIdFromFilename(args.filename);
            if (!requestId) {
                throw new Error('ipfs_publish filename must encode a requestId generated by this agent.');
            }
            const archiveSignal = archiveSignals.get(requestId);
            if (!archiveSignal) {
                throw new Error(`No signedRequestArchive signal available for requestId ${requestId}.`);
            }
            if (archiveSignal.archived) {
                throw new Error(`Request ${requestId} is already archived.`);
            }
            if (args.content !== undefined && args.content !== null) {
                throw new Error('fast-withdraw archival only allows JSON artifacts, not raw content.');
            }
            if (canonicalJson(args.json) !== canonicalJson(archiveSignal.archiveArtifact)) {
                throw new Error(
                    'ipfs_publish json must exactly match the prepared signed request archive artifact.'
                );
            }

            pendingArtifactPublishes.set(
                archiveSignal.archiveFilename,
                buildSignedRequestArchiveRecord({
                    message: {
                        requestId: archiveSignal.requestId,
                        messageId: archiveSignal.messageId,
                        text: archiveSignal.archiveArtifact?.signedRequest?.envelope?.text ?? null,
                        command: archiveSignal.archiveArtifact?.signedRequest?.envelope?.command ?? null,
                        args: cloneJson(
                            archiveSignal.archiveArtifact?.signedRequest?.envelope?.args ?? null
                        ),
                        metadata: cloneJson(
                            archiveSignal.archiveArtifact?.signedRequest?.envelope?.metadata ?? null
                        ),
                        deadline:
                            archiveSignal.archiveArtifact?.signedRequest?.envelope?.deadline ?? null,
                        sender: {
                            address: archiveSignal.signer,
                            signature: archiveSignal.signature,
                            signedAtMs: archiveSignal.signedAtMs,
                        },
                    },
                    commitmentSafe:
                        archiveSignal.archiveArtifact?.agentContext?.commitmentSafe ?? null,
                    agentAddress: archiveSignal.archiveArtifact?.agentContext?.agentAddress ?? null,
                })
            );
            archiveApprovedRequestId = requestId;
            validatedArchiveCalls.push({
                ...call,
                parsedArguments: {
                    json: cloneJson(archiveSignal.archiveArtifact),
                    filename: archiveSignal.archiveFilename,
                    pin: true,
                },
            });
            continue;
        }

        if (call?.name === 'make_transfer') {
            if (fillApprovedRequestId) {
                throw new Error('Only one fast-withdraw direct fill is allowed per response.');
            }
            const requestId = resolveDirectFillRequestId();
            const record = requestArchiveState.requests?.[requestId] ?? null;
            if (record && isRequestExpired(record)) {
                throw new Error(`Request ${requestId} is expired and cannot be filled.`);
            }

            const args = parseCallArgs(call);
            if (!args || typeof args !== 'object') {
                throw new Error('make_transfer requires valid arguments.');
            }
            const asset = normalizeAssetAddress(args.asset);
            const recipient = normalizeAddress(args.recipient);
            const amountWei = parsePositiveAmountWei(args.amountWei);
            const assetSignal = assetSignalsByAsset.get(asset);
            if (!assetSignal) {
                throw new Error(
                    `make_transfer asset ${asset} is not present in fastWithdrawAsset signals.`
                );
            }
            if (parseMaybeBigInt(assetSignal.agentBalance) < amountWei) {
                throw new Error('Agent balance is insufficient for the requested fast-withdraw fill.');
            }

            pendingDirectFill = {
                requestId,
                asset,
                recipient,
                amountWei: amountWei.toString(),
            };
            fillApprovedRequestId = requestId;
            validatedFillCalls.push({
                ...call,
                parsedArguments: {
                    asset,
                    recipient,
                    amountWei: amountWei.toString(),
                },
            });
            continue;
        }

        if (call?.name === 'post_bond_and_propose') {
            if (proposalApprovedRequestId) {
                throw new Error('Only one fast-withdraw reimbursement proposal is allowed per response.');
            }
            const args = parseCallArgs(call);
            const requestSignal = resolveReimbursementRequest(args);
            if (requestSignal.expired) {
                throw new Error(`Request ${requestSignal.requestId} is expired and cannot be reimbursed.`);
            }
            const expectedTransactions = requestSignal.expectedReimbursementTransactions;
            const expectedExplanation = requestSignal.expectedReimbursementExplanation;
            if (!Array.isArray(expectedTransactions) || expectedTransactions.length !== 1) {
                throw new Error(
                    `Request ${requestSignal.requestId} does not have a valid reimbursement transaction.`
                );
            }
            if (!expectedExplanation) {
                throw new Error(
                    `Request ${requestSignal.requestId} does not have a valid reimbursement explanation.`
                );
            }

            pendingReimbursementProposal = {
                requestId: requestSignal.requestId,
                explanation: expectedExplanation,
            };
            proposalApprovedRequestId = requestSignal.requestId;
            validatedProposalCalls.push({
                ...call,
                parsedArguments: {
                    transactions: cloneJson(expectedTransactions),
                    explanation: expectedExplanation,
                },
            });
            continue;
        }

        // Ignore other tool calls for this specialized module.
    }

    if (validatedProposalCalls.length > 0 && validatedFillCalls.length > 0) {
        throw new Error(
            'Direct fill and reimbursement proposal must not occur in the same response; wait for confirmations first.'
        );
    }

    if (validatedProposalCalls.length > 0 && validatedArchiveCalls.length > 0) {
        throw new Error(
            'Archival and reimbursement proposal must not occur in the same response.'
        );
    }

    return [...validatedArchiveCalls, ...validatedFillCalls, ...validatedProposalCalls];
}

async function onToolOutput({ name, parsedOutput }) {
    await hydrateRequestArchiveState();

    if (name === 'ipfs_publish') {
        if (!parsedOutput || parsedOutput.status !== 'published') {
            return;
        }

        const filename =
            parsedOutput?.publishResult?.Name ??
            parsedOutput?.publishResult?.name ??
            null;
        const requestId = decodeRequestIdFromFilename(filename);
        if (!requestId) return;

        const pending = pendingArtifactPublishes.get(filename) ?? {};
        const previous = requestArchiveState.requests?.[requestId] ?? {};
        requestArchiveState.requests[requestId] = {
            ...previous,
            ...pending,
            requestId,
            artifactCid: parsedOutput.cid ?? previous.artifactCid ?? null,
            artifactUri: parsedOutput.uri ?? previous.artifactUri ?? null,
            pinned:
                parsedOutput.pinned === undefined
                    ? previous.pinned ?? true
                    : Boolean(parsedOutput.pinned),
            artifactPublishedAtMs: Date.now(),
        };
        pendingArtifactPublishes.delete(filename);
        await persistRequestArchiveState();
        return;
    }

    if (name === 'make_transfer') {
        const pending = pendingDirectFill;
        pendingDirectFill = null;
        if (!pending) return;
        if (!parsedOutput || (parsedOutput.status !== 'confirmed' && parsedOutput.status !== 'submitted')) {
            return;
        }
        const previous = requestArchiveState.requests?.[pending.requestId] ?? {};
        requestArchiveState.requests[pending.requestId] = {
            ...previous,
            requestId: pending.requestId,
            directFillAsset: pending.asset,
            directFillRecipient: pending.recipient,
            directFillAmountWei: pending.amountWei,
            directFillTxHash: parsedOutput.transactionHash ?? previous.directFillTxHash ?? null,
            directFillSubmittedAtMs: Date.now(),
            directFillConfirmations:
                parsedOutput.status === 'confirmed' ? 1 : previous.directFillConfirmations ?? 0,
            directFillConfirmed:
                parsedOutput.status === 'confirmed' &&
                Number(DIRECT_FILL_CONFIRMATION_THRESHOLD) <= 1,
        };
        await persistRequestArchiveState();
        return;
    }

    if (name === 'post_bond_and_propose' || name === 'auto_post_bond_and_propose') {
        const pending = pendingReimbursementProposal;
        pendingReimbursementProposal = null;
        if (!pending) return;
        if (!parsedOutput || parsedOutput.status !== 'submitted') {
            return;
        }
        const previous = requestArchiveState.requests?.[pending.requestId] ?? {};
        requestArchiveState.requests[pending.requestId] = {
            ...previous,
            reimbursementExplanation: pending.explanation,
            reimbursementSubmissionTxHash:
                parsedOutput.transactionHash ?? previous.reimbursementSubmissionTxHash ?? null,
            reimbursementProposalHash:
                parsedOutput.ogProposalHash ??
                parsedOutput.proposalHash ??
                previous.reimbursementProposalHash ??
                null,
            reimbursementSubmittedAtMs: Date.now(),
        };
        await persistRequestArchiveState();
    }
}

async function getRequestArchiveState() {
    await hydrateRequestArchiveState();
    return cloneJson({
        version: STATE_VERSION,
        requests: requestArchiveState.requests,
    });
}

async function resetRequestArchiveState() {
    requestArchiveState.requests = {};
    requestArchiveStateHydrated = true;
    pendingArtifactPublishes.clear();
    pendingDirectFill = null;
    pendingReimbursementProposal = null;
    assetMetadataCache.clear();
    await unlink(getStatePath()).catch(() => {});
}

function setRequestArchiveStatePathForTest(nextPath) {
    statePathOverride = typeof nextPath === 'string' && nextPath.trim() ? nextPath : null;
    requestArchiveState.requests = {};
    requestArchiveStateHydrated = false;
    pendingArtifactPublishes.clear();
    pendingDirectFill = null;
    pendingReimbursementProposal = null;
    assetMetadataCache.clear();
}

const getPollingOptions = getAlwaysEmitBalanceSnapshotPollingOptions;

export {
    buildArtifactFilename,
    buildFastWithdrawRequestSignal,
    buildSignedRequestArchiveSignal,
    buildSignedRequestArchiveArtifact,
    decodeRequestIdFromFilename,
    enrichSignals,
    getPollingOptions,
    getRequestArchiveState,
    getSystemPrompt,
    onToolOutput,
    resetRequestArchiveState,
    setRequestArchiveStatePathForTest,
    validateToolCalls,
};
