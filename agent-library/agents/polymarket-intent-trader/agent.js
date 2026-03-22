import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUnits } from 'viem';
import { buildSignedMessagePayload } from '../../../agent/src/lib/message-signing.js';
import { normalizeAddressOrNull, normalizeTokenId } from '../../../agent/src/lib/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_VERSION = 1;
const ARTIFACT_VERSION = 'oya-polymarket-signed-intent-archive-v1';
const FILENAME_PREFIX = 'signed-trade-intent-';
const FILENAME_SUFFIX = '.json';
const USDC_DECIMALS = 6;
const PRICE_SCALE = 1_000_000n;
const DEFAULT_ARCHIVE_RETRY_DELAY_MS = 30_000;
const DEFAULT_SIGNED_COMMANDS = [
    'buy',
    'trade',
    'intent',
    'polymarket_buy',
    'polymarket_trade',
    'polymarket_intent',
];

const tradeIntentState = {
    intents: {},
};
let tradeIntentStateHydrated = false;
let statePathOverride = null;
let pendingArtifactPublish = null;

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function resetInMemoryState({ hydrated = false } = {}) {
    tradeIntentState.intents = {};
    tradeIntentStateHydrated = hydrated;
    pendingArtifactPublish = null;
}

function getStatePath() {
    if (typeof statePathOverride === 'string' && statePathOverride.trim()) {
        return path.resolve(statePathOverride.trim());
    }
    return path.join(__dirname, '.trade-intent-state.json');
}

async function hydrateTradeIntentState() {
    if (tradeIntentStateHydrated) return;
    tradeIntentStateHydrated = true;
    try {
        const raw = await readFile(getStatePath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            tradeIntentState.intents =
                parsed.intents &&
                typeof parsed.intents === 'object' &&
                !Array.isArray(parsed.intents)
                    ? parsed.intents
                    : {};
        }
    } catch (error) {
        tradeIntentState.intents = {};
    }
}

async function persistTradeIntentState() {
    await writeFile(
        getStatePath(),
        JSON.stringify(
            {
                version: STATE_VERSION,
                intents: tradeIntentState.intents,
            },
            null,
            2
        ),
        'utf8'
    );
}

async function resetTradeIntentState() {
    resetInMemoryState({ hydrated: true });
    try {
        await unlink(getStatePath());
    } catch (error) {
        // Ignore missing state files during tests.
    }
}

function setTradeIntentStatePathForTest(nextPath) {
    statePathOverride =
        typeof nextPath === 'string' && nextPath.trim() ? nextPath.trim() : null;
    resetInMemoryState();
}

function getTradeIntentState() {
    return cloneJson(tradeIntentState);
}

function normalizeNonEmptyString(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function normalizePositiveInteger(value) {
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized <= 0) {
        return null;
    }
    return normalized;
}

function normalizeWhitespace(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeDecimalText(value) {
    const normalized = String(value ?? '')
        .replace(/,/g, '')
        .trim();
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
        return null;
    }
    const [wholeRaw, fractionRaw = ''] = normalized.split('.');
    const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
    const fraction = fractionRaw.replace(/0+$/, '');
    return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

function formatScaledDecimal(value, decimals) {
    const normalized = BigInt(value);
    const negative = normalized < 0n;
    const absolute = negative ? -normalized : normalized;
    const scale = 10n ** BigInt(decimals);
    const whole = absolute / scale;
    const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
    const sign = negative ? '-' : '';
    return fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
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

function resolvePolicy(config = {}) {
    const candidate =
        config?.agentConfig?.polymarketIntentTrader ?? config?.polymarketIntentTrader ?? {};
    const signedCommands =
        Array.isArray(candidate.signedCommands) && candidate.signedCommands.length > 0
            ? candidate.signedCommands
            : DEFAULT_SIGNED_COMMANDS;
    return {
        authorizedAgent: normalizeAddressOrNull(
            candidate.authorizedAgent ?? candidate.agentAddress ?? null
        ),
        marketId: normalizeNonEmptyString(candidate.marketId),
        yesTokenId: normalizeTokenId(candidate.yesTokenId),
        noTokenId: normalizeTokenId(candidate.noTokenId),
        archiveRetryDelayMs:
            normalizePositiveInteger(candidate.archiveRetryDelayMs) ??
            DEFAULT_ARCHIVE_RETRY_DELAY_MS,
        signedCommands: new Set(
            signedCommands
                .map((entry) => normalizeNonEmptyString(entry)?.toLowerCase())
                .filter(Boolean)
        ),
    };
}

function resolveExpiryMs(signal) {
    const candidates = [
        normalizePositiveInteger(signal?.expiresAtMs),
        normalizePositiveInteger(signal?.deadline),
    ].filter(Boolean);
    if (candidates.length === 0) {
        return null;
    }
    return Math.min(...candidates);
}

function containsBuyVerb(text) {
    return /\b(buy|purchase)\b/i.test(text);
}

function containsSellVerb(text) {
    return /\b(sell|short)\b/i.test(text);
}

function parseOutcomeFromText(text) {
    const actionMatch = text.match(/\b(?:buy|purchase)\s+(?:the\s+)?(yes|no)\b/i);
    if (actionMatch?.[1]) {
        return actionMatch[1].trim().toUpperCase();
    }

    const outcomes = new Set(
        Array.from(text.matchAll(/\b(yes|no)\b/gi), (match) => match[1].trim().toUpperCase())
    );
    if (outcomes.size === 1) {
        return Array.from(outcomes)[0];
    }
    return null;
}

function parseMaxSpendFromText(text) {
    const patterns = [
        /\bfor\s+up\s+to\s+\$?([\d,]+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\b/gi,
        /\bup\s+to\s+\$?([\d,]+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\b/gi,
        /\b(?:spend|use|risk)\s+up\s+to\s+\$?([\d,]+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\b/gi,
        /\bmax(?:imum)?\s+(?:spend|cost|notional)?\s*\$?([\d,]+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\b/gi,
        /\bfor\s+\$?([\d,]+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\b/gi,
    ];

    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            const normalized = normalizeDecimalText(match[1]);
            if (!normalized) continue;
            try {
                const wei = parseUnits(normalized, USDC_DECIMALS);
                if (wei <= 0n) continue;
                return {
                    usdc: normalized,
                    wei: wei.toString(),
                };
            } catch (error) {
                // Ignore malformed numeric candidates and continue scanning.
            }
        }
    }

    return null;
}

function normalizePriceToScaled(value, unit) {
    const normalized = normalizeDecimalText(value);
    if (!normalized) return null;

    try {
        const scaled =
            unit === 'c' || unit === 'cent' || unit === 'cents' || unit === '%'
                ? parseUnits(normalized, 4)
                : parseUnits(normalized, 6);
        if (scaled <= 0n || scaled > PRICE_SCALE) {
            return null;
        }
        return {
            decimal: formatScaledDecimal(scaled, 6),
            scaled: scaled.toString(),
        };
    } catch (error) {
        return null;
    }
}

function parseMaxPriceFromText(text) {
    const patterns = [
        /\b(?:price\s*(?:is|<=|=<|<|under|at\s+most|up\s+to)|max(?:imum)?\s+price(?:\s+is)?|at)\s*\$?([\d,]+(?:\.\d+)?)\s*(c|cent|cents|%)\b(?:\s+or\s+(?:better|less|lower))?/gi,
        /\b(?:price\s*(?:is|<=|=<|<|under|at\s+most|up\s+to)|max(?:imum)?\s+price(?:\s+is)?|at)\s*\$?([\d,]+(?:\.\d+)?)\b(?:\s+or\s+(?:better|less|lower))?/gi,
    ];

    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            const normalized = normalizePriceToScaled(match[1], match[2]?.toLowerCase() ?? null);
            if (normalized) {
                return normalized;
            }
        }
    }

    return null;
}

function buildTradeIntentKey({ signer, requestId }) {
    return `${signer}:${requestId}`;
}

function encodeRequestIdForFilename(requestId) {
    return Buffer.from(String(requestId), 'utf8').toString('hex');
}

function buildArtifactFilename(requestId) {
    return `${FILENAME_PREFIX}${encodeRequestIdForFilename(requestId)}${FILENAME_SUFFIX}`;
}

function getIntentStatus(record, nowMs = Date.now()) {
    if (!record) return 'unknown';
    if (Number.isInteger(record.expiryMs) && nowMs > record.expiryMs) {
        return 'expired';
    }
    if (record.artifactCid) {
        return 'archived';
    }
    if (record.lastArchiveAttemptAtMs) {
        return 'archive_pending';
    }
    return 'parsed';
}

function interpretSignedTradeIntentSignal(
    signal,
    {
        policy = resolvePolicy({}),
        commitmentSafe = null,
        agentAddress = null,
        nowMs = Date.now(),
    } = {}
) {
    if (!isSignedUserMessage(signal)) {
        return { ok: false, reason: 'not_signed_user_message' };
    }

    const signer = normalizeAddressOrNull(signal.sender.address);
    if (!signer) {
        return { ok: false, reason: 'invalid_signer' };
    }

    const requestId = signal.requestId.trim();
    const normalizedCommand = normalizeNonEmptyString(signal.command)?.toLowerCase() ?? '';
    if (
        normalizedCommand &&
        policy.signedCommands.size > 0 &&
        !policy.signedCommands.has(normalizedCommand)
    ) {
        return { ok: false, reason: 'unsupported_command' };
    }

    const text = normalizeWhitespace(signal.text);
    if (!text) {
        return { ok: false, reason: 'missing_text' };
    }
    if (!containsBuyVerb(text)) {
        return { ok: false, reason: 'missing_buy_instruction' };
    }
    if (containsSellVerb(text)) {
        return { ok: false, reason: 'sell_not_supported' };
    }

    const outcome = parseOutcomeFromText(text);
    if (!outcome) {
        return { ok: false, reason: 'missing_or_ambiguous_outcome' };
    }

    const maxSpend = parseMaxSpendFromText(text);
    if (!maxSpend) {
        return { ok: false, reason: 'missing_max_spend' };
    }

    const maxPrice = parseMaxPriceFromText(text);
    if (!maxPrice) {
        return { ok: false, reason: 'missing_max_price' };
    }

    const expiryMs = resolveExpiryMs(signal);
    if (!expiryMs) {
        return { ok: false, reason: 'missing_expiry' };
    }
    if (nowMs > expiryMs) {
        return { ok: false, reason: 'expired' };
    }

    const canonicalMessage = buildSignedMessagePayload({
        address: signer,
        chainId: signal.chainId,
        timestampMs: signal.sender.signedAtMs,
        text: signal.text,
        command: signal.command,
        args: signal.args,
        metadata: signal.metadata,
        requestId,
        deadline: signal.deadline,
    });

    const intent = {
        intentKey: buildTradeIntentKey({ signer, requestId }),
        requestId,
        messageId: signal.messageId ?? null,
        signer,
        signature: signal.sender.signature,
        signedAtMs: signal.sender.signedAtMs,
        chainId: signal.chainId ?? null,
        deadline: signal.deadline ?? null,
        expiresAtMs: signal.expiresAtMs ?? null,
        expiryMs,
        receivedAtMs: signal.receivedAtMs ?? null,
        text,
        command: signal.command ?? null,
        args: cloneJson(signal.args ?? null),
        metadata: cloneJson(signal.metadata ?? null),
        side: 'BUY',
        outcome,
        marketId: policy.marketId ?? null,
        tokenId: outcome === 'YES' ? policy.yesTokenId ?? null : policy.noTokenId ?? null,
        maxSpendUsdc: maxSpend.usdc,
        maxSpendWei: maxSpend.wei,
        maxPrice: maxPrice.decimal,
        maxPriceScaled: maxPrice.scaled,
        canonicalMessage,
        archiveFilename: buildArtifactFilename(requestId),
        artifactCid: null,
        artifactUri: null,
        pinned: null,
        commitmentSafe: commitmentSafe ?? null,
        agentAddress: agentAddress ?? null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        lastArchiveAttemptAtMs: null,
        nextArchiveAttemptAtMs: null,
        lastArchiveError: null,
        lastArchiveStatus: null,
        archivedAtMs: null,
    };

    return {
        ok: true,
        intent,
    };
}

function buildSignedTradeIntentArchiveArtifact({
    record,
    commitmentSafe,
    agentAddress,
}) {
    if (!record?.canonicalMessage) {
        throw new Error('buildSignedTradeIntentArchiveArtifact requires a parsed signed intent record.');
    }

    return {
        version: ARTIFACT_VERSION,
        requestId: record.requestId,
        messageId: record.messageId ?? null,
        interpretedIntent: {
            side: record.side,
            outcome: record.outcome,
            marketId: record.marketId ?? null,
            tokenId: record.tokenId ?? null,
            maxSpendUsdc: record.maxSpendUsdc,
            maxSpendWei: record.maxSpendWei,
            maxPrice: record.maxPrice,
            maxPriceScaled: record.maxPriceScaled,
            expiryMs: record.expiryMs,
        },
        signedRequest: {
            authType: 'eip191',
            signer: record.signer,
            signature: record.signature,
            signedAtMs: record.signedAtMs,
            canonicalMessage: record.canonicalMessage,
            envelope: {
                chainId: record.chainId ?? null,
                requestId: record.requestId,
                deadline: record.deadline ?? null,
                text: record.text ?? null,
                command: record.command ?? null,
                args: cloneJson(record.args ?? null),
                metadata: cloneJson(record.metadata ?? null),
            },
        },
        agentContext: {
            commitmentSafe: commitmentSafe ?? record.commitmentSafe ?? null,
            agentAddress: agentAddress ?? record.agentAddress ?? null,
            receivedAtMs: record.receivedAtMs ?? null,
            expiresAtMs: record.expiresAtMs ?? null,
        },
    };
}

function buildTradeIntentSignal(record, nowMs = Date.now()) {
    return {
        kind: 'polymarketTradeIntent',
        intentKey: record.intentKey,
        requestId: record.requestId,
        messageId: record.messageId ?? null,
        signer: record.signer,
        signedAtMs: record.signedAtMs,
        text: record.text,
        command: record.command ?? null,
        side: record.side,
        outcome: record.outcome,
        marketId: record.marketId ?? null,
        tokenId: record.tokenId ?? null,
        maxSpendUsdc: record.maxSpendUsdc,
        maxSpendWei: record.maxSpendWei,
        maxPrice: record.maxPrice,
        maxPriceScaled: record.maxPriceScaled,
        expiryMs: record.expiryMs,
        expired: Number.isInteger(record.expiryMs) && nowMs > record.expiryMs,
        archived: Boolean(record.artifactCid),
        artifactCid: record.artifactCid ?? null,
        artifactUri: record.artifactUri ?? null,
        pinned: record.pinned ?? null,
        status: getIntentStatus(record, nowMs),
    };
}

function buildArchiveSignal(record, commitmentSafe, agentAddress) {
    return {
        kind: 'polymarketSignedIntentArchive',
        intentKey: record.intentKey,
        requestId: record.requestId,
        messageId: record.messageId ?? null,
        archiveFilename: record.archiveFilename,
        archiveArtifact: buildSignedTradeIntentArchiveArtifact({
            record,
            commitmentSafe,
            agentAddress,
        }),
        archived: Boolean(record.artifactCid),
        artifactCid: record.artifactCid ?? null,
        artifactUri: record.artifactUri ?? null,
        pinned: record.pinned ?? null,
    };
}

function mergeRecordIntoState(record) {
    const existing = tradeIntentState.intents[record.intentKey];
    if (!existing) {
        tradeIntentState.intents[record.intentKey] = record;
        return { record, changed: true };
    }

    if (
        existing.canonicalMessage &&
        record.canonicalMessage &&
        existing.canonicalMessage !== record.canonicalMessage
    ) {
        console.warn(
            `[agent] Ignoring conflicting signed trade intent for ${record.intentKey}; requestId already exists with a different signed payload.`
        );
        return { record: existing, changed: false };
    }

    let changed = false;
    const optionalUpdates = [
        'messageId',
        'deadline',
        'expiresAtMs',
        'receivedAtMs',
        'commitmentSafe',
        'agentAddress',
        'marketId',
        'tokenId',
    ];
    for (const key of optionalUpdates) {
        if ((existing[key] === null || existing[key] === undefined) && record[key] !== null && record[key] !== undefined) {
            existing[key] = record[key];
            changed = true;
        }
    }

    if (changed) {
        existing.updatedAtMs = Date.now();
    }

    return { record: existing, changed };
}

function getArchivableIntent(nowMs = Date.now()) {
    return Object.values(tradeIntentState.intents)
        .filter((record) => {
            if (!record || record.artifactCid) return false;
            if (Number.isInteger(record.expiryMs) && nowMs > record.expiryMs) return false;
            if (
                Number.isInteger(record.nextArchiveAttemptAtMs) &&
                record.nextArchiveAttemptAtMs > nowMs
            ) {
                return false;
            }
            return true;
        })
        .sort((left, right) => Number(left.createdAtMs ?? 0) - Number(right.createdAtMs ?? 0))[0];
}

function markArchiveAttempt(record, policy, nowMs = Date.now()) {
    record.lastArchiveAttemptAtMs = nowMs;
    record.nextArchiveAttemptAtMs = nowMs + policy.archiveRetryDelayMs;
    record.updatedAtMs = nowMs;
}

function buildArchiveToolCall(record, commitmentSafe, agentAddress) {
    return {
        callId: `archive-trade-intent-${record.requestId}`,
        name: 'ipfs_publish',
        arguments: JSON.stringify({
            json: buildSignedTradeIntentArchiveArtifact({
                record,
                commitmentSafe,
                agentAddress,
            }),
            filename: record.archiveFilename,
            pin: false,
        }),
    };
}

function getSystemPrompt({ commitmentText }) {
    return [
        'You are a Polymarket signed-intent trading agent for an onchain commitment.',
        'Focus on signals where kind is "userMessage".',
        'Treat userMessage as an authenticated trade intent candidate only when sender.authType is "eip191".',
        'Use the signed human-readable message text as the primary source of trading intent. Do not treat args as authoritative execution instructions.',
        'Parse signed free-text messages into candidate BUY intents for the configured market only.',
        'Recommend acting only when the signed message text clearly identifies outcome, spend limit, price bound, and time validity under the commitment rules.',
        'Archive accepted signed trade intents before later execution or reimbursement steps when IPFS is enabled.',
        'Prefer ignore or clarify when the message is unsigned, malformed, expired, duplicated, ambiguous, or missing trade bounds.',
        'Do not invent markets, prices, balances, or signer authority.',
        'Return strict JSON with keys: action, rationale, intentStatus, recommendedNextStep.',
        'Allowed action values: acknowledge_signed_intent, clarify, ignore.',
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

function augmentSignals(signals, { nowMs } = {}) {
    return [
        ...(Array.isArray(signals) ? signals : []),
        {
            kind: 'polymarketIntentTick',
            nowMs: nowMs ?? Date.now(),
        },
    ];
}

async function enrichSignals(
    signals,
    {
        config,
        account,
        nowMs,
    } = {}
) {
    await hydrateTradeIntentState();
    const policy = resolvePolicy(config);
    const commitmentSafe = config?.commitmentSafe ?? null;
    const agentAddress = normalizeAddressOrNull(account?.address) ?? null;
    const out = Array.isArray(signals) ? [...signals] : [];
    const emittedKeys = new Set();
    const effectiveNowMs = normalizePositiveInteger(nowMs) ?? Date.now();

    for (const record of Object.values(tradeIntentState.intents)) {
        if (!record?.intentKey || emittedKeys.has(record.intentKey)) continue;
        out.push(buildTradeIntentSignal(record, effectiveNowMs));
        out.push(buildArchiveSignal(record, commitmentSafe, agentAddress));
        emittedKeys.add(record.intentKey);
    }

    for (const signal of Array.isArray(signals) ? signals : []) {
        const interpreted = interpretSignedTradeIntentSignal(signal, {
            policy,
            commitmentSafe,
            agentAddress,
            nowMs: effectiveNowMs,
        });
        if (!interpreted.ok) {
            continue;
        }
        const record =
            tradeIntentState.intents[interpreted.intent.intentKey] ?? interpreted.intent;
        if (emittedKeys.has(record.intentKey)) {
            continue;
        }
        out.push(buildTradeIntentSignal(record, effectiveNowMs));
        out.push(buildArchiveSignal(record, commitmentSafe, agentAddress));
        emittedKeys.add(record.intentKey);
    }

    return out;
}

async function getDeterministicToolCalls({
    signals,
    commitmentSafe,
    agentAddress,
    config,
}) {
    await hydrateTradeIntentState();
    const policy = resolvePolicy(config);
    const normalizedAgentAddress = normalizeAddressOrNull(agentAddress);

    if (policy.authorizedAgent && normalizedAgentAddress !== policy.authorizedAgent) {
        throw new Error(
            `polymarket-intent-trader may only be served by authorized agent ${policy.authorizedAgent}.`
        );
    }

    let changed = false;
    const nowMs = Date.now();
    for (const signal of Array.isArray(signals) ? signals : []) {
        const interpreted = interpretSignedTradeIntentSignal(signal, {
            policy,
            commitmentSafe,
            agentAddress: normalizedAgentAddress,
            nowMs,
        });
        if (!interpreted.ok) {
            continue;
        }

        const merged = mergeRecordIntoState(interpreted.intent);
        if (merged.changed) {
            changed = true;
            console.log(
                `[agent] Parsed signed Polymarket trade intent ${merged.record.intentKey}: outcome=${merged.record.outcome} maxSpendWei=${merged.record.maxSpendWei} maxPrice=${merged.record.maxPrice}.`
            );
        }
    }

    if (changed) {
        await persistTradeIntentState();
    }

    if (!config?.ipfsEnabled) {
        return [];
    }

    const record = getArchivableIntent(nowMs);
    if (!record) {
        return [];
    }

    markArchiveAttempt(record, policy, nowMs);
    await persistTradeIntentState();
    pendingArtifactPublish = {
        intentKey: record.intentKey,
    };
    console.log(`[agent] Preparing signed trade intent archive for ${record.intentKey}.`);
    return [buildArchiveToolCall(record, commitmentSafe, normalizedAgentAddress)];
}

function getParsedToolOutputStatus(parsedOutput) {
    return typeof parsedOutput?.status === 'string' && parsedOutput.status.trim()
        ? parsedOutput.status.trim()
        : 'unknown';
}

function getParsedToolOutputDetail(parsedOutput, status) {
    if (typeof parsedOutput?.message === 'string' && parsedOutput.message.trim()) {
        return parsedOutput.message.trim();
    }
    if (typeof parsedOutput?.reason === 'string' && parsedOutput.reason.trim()) {
        return parsedOutput.reason.trim();
    }
    return `tool returned status=${status}`;
}

async function onToolOutput({ name, parsedOutput, config }) {
    await hydrateTradeIntentState();

    if (name !== 'ipfs_publish') {
        return;
    }

    const pending = pendingArtifactPublish;
    pendingArtifactPublish = null;
    if (!pending?.intentKey) {
        console.warn('[agent] Received ipfs_publish tool output with no pending trade intent.');
        return;
    }

    const record = tradeIntentState.intents[pending.intentKey];
    if (!record) {
        console.warn(
            `[agent] Received ipfs_publish tool output for unknown trade intent ${pending.intentKey}.`
        );
        return;
    }

    const policy = resolvePolicy(config);
    const nowMs = Date.now();
    if (parsedOutput?.status !== 'published') {
        const status = getParsedToolOutputStatus(parsedOutput);
        const detail = getParsedToolOutputDetail(parsedOutput, status);
        record.lastArchiveStatus = status;
        record.lastArchiveError = detail;
        record.nextArchiveAttemptAtMs = nowMs + policy.archiveRetryDelayMs;
        record.updatedAtMs = nowMs;
        await persistTradeIntentState();
        console.warn(
            `[agent] Signed trade intent archive failed for ${pending.intentKey}: status=${status} detail=${detail}.`
        );
        return;
    }

    const cid =
        typeof parsedOutput?.cid === 'string' && parsedOutput.cid.trim()
            ? parsedOutput.cid.trim()
            : null;
    const uri =
        typeof parsedOutput?.uri === 'string' && parsedOutput.uri.trim()
            ? parsedOutput.uri.trim()
            : cid
                ? `ipfs://${cid}`
                : null;

    record.artifactCid = cid;
    record.artifactUri = uri;
    record.pinned = parsedOutput?.pinned ?? parsedOutput?.pin ?? null;
    record.lastArchiveError = null;
    record.lastArchiveStatus = 'published';
    record.nextArchiveAttemptAtMs = null;
    record.archivedAtMs = nowMs;
    record.updatedAtMs = nowMs;
    await persistTradeIntentState();
    console.log(
        `[agent] Signed trade intent archive published for ${pending.intentKey}: uri=${record.artifactUri ?? 'missing'}.`
    );
}

export {
    augmentSignals,
    buildSignedTradeIntentArchiveArtifact,
    enrichSignals,
    getDeterministicToolCalls,
    getSystemPrompt,
    getTradeIntentState,
    interpretSignedTradeIntentSignal,
    onToolOutput,
    resetTradeIntentState,
    setTradeIntentStatePathForTest,
};
