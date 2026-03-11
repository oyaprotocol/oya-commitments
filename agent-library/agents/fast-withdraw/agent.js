import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSignedMessagePayload } from '../../../agent/src/lib/message-signing.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_VERSION = 1;
const ARTIFACT_VERSION = 'oya-signed-request-archive-v1';
const FILENAME_PREFIX = 'signed-request-';
const FILENAME_SUFFIX = '.json';

const requestArchiveState = {
    requests: {},
};
let requestArchiveStateHydrated = false;
const pendingArtifactPublishes = new Map();
let statePathOverride = null;

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
        ? 'You may eventually propose and dispute, but the current automated step is request archival.'
        : proposeEnabled
          ? 'You may eventually propose, but the current automated step is request archival.'
          : disputeEnabled
            ? 'You may eventually dispute, but the current automated step is request archival.'
            : 'Current automated behavior is request archival only.';

    return [
        'You are a fast-withdraw commitment agent.',
        'Focus on signed userMessage signals that represent user withdrawal requests.',
        'The first required step is to archive each signed request to IPFS before any direct fill or reimbursement logic.',
        'Use the signed human-readable message text as the source of withdrawal intent. Do not treat args as authoritative execution instructions.',
        'The archive artifact must preserve the canonical signed message, the signer address, the signature, and the request envelope fields.',
        'When a signedRequestArchive signal is present and archived is false, use ipfs_publish with exactly that signal’s archiveArtifact and archiveFilename.',
        'Do not reimburse or dispute unless later logic proves the direct fill and reimbursement satisfy the commitment.',
        'After archival, reason about asset, amount, and recipient from the signed text itself.',
        'Use ipfs_publish for archival when IPFS is enabled.',
        mode,
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

async function enrichSignals(signals, {
    config,
    account,
} = {}) {
    await hydrateRequestArchiveState();
    const commitmentSafe = config?.commitmentSafe;
    const agentAddress = account?.address ?? null;
    const out = Array.isArray(signals) ? [...signals] : [];
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
    return out;
}

async function validateToolCalls({
    toolCalls,
    signals,
    config,
}) {
    await hydrateRequestArchiveState();
    const archiveSignals = new Map();
    for (const signal of Array.isArray(signals) ? signals : []) {
        if (signal?.kind !== 'signedRequestArchive') continue;
        if (typeof signal.requestId !== 'string' || !signal.requestId.trim()) continue;
        archiveSignals.set(signal.requestId, signal);
    }

    const validated = [];
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        if (call?.name !== 'ipfs_publish') {
            continue;
        }
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
            throw new Error('ipfs_publish json must exactly match the prepared signed request archive artifact.');
        }

        pendingArtifactPublishes.set(
            archiveSignal.archiveFilename,
            buildSignedRequestArchiveRecord({
                message: {
                    requestId: archiveSignal.requestId,
                    messageId: archiveSignal.messageId,
                    text: archiveSignal.archiveArtifact?.signedRequest?.envelope?.text ?? null,
                    command: archiveSignal.archiveArtifact?.signedRequest?.envelope?.command ?? null,
                    args: cloneJson(archiveSignal.archiveArtifact?.signedRequest?.envelope?.args ?? null),
                    metadata: cloneJson(archiveSignal.archiveArtifact?.signedRequest?.envelope?.metadata ?? null),
                    deadline: archiveSignal.archiveArtifact?.signedRequest?.envelope?.deadline ?? null,
                    sender: {
                        address: archiveSignal.signer,
                        signature: archiveSignal.signature,
                        signedAtMs: archiveSignal.signedAtMs,
                    },
                },
                commitmentSafe: archiveSignal.archiveArtifact?.agentContext?.commitmentSafe ?? null,
                agentAddress: archiveSignal.archiveArtifact?.agentContext?.agentAddress ?? null,
            })
        );
        validated.push({
            ...call,
            parsedArguments: {
                json: cloneJson(archiveSignal.archiveArtifact),
                filename: archiveSignal.archiveFilename,
                pin: true,
            },
        });
    }

    return validated;
}

async function onToolOutput({ name, parsedOutput }) {
    if (name !== 'ipfs_publish') return;
    if (!parsedOutput || parsedOutput.status !== 'published') return;

    const filename =
        parsedOutput?.publishResult?.Name ??
        parsedOutput?.publishResult?.name ??
        null;
    const requestId = decodeRequestIdFromFilename(filename);
    if (!requestId) return;

    await hydrateRequestArchiveState();
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
    await unlink(getStatePath()).catch(() => {});
}

function setRequestArchiveStatePathForTest(nextPath) {
    statePathOverride = typeof nextPath === 'string' && nextPath.trim() ? nextPath : null;
    requestArchiveState.requests = {};
    requestArchiveStateHydrated = false;
    pendingArtifactPublishes.clear();
}

export {
    buildArtifactFilename,
    buildSignedRequestArchiveSignal,
    buildSignedRequestArchiveArtifact,
    decodeRequestIdFromFilename,
    enrichSignals,
    getRequestArchiveState,
    getSystemPrompt,
    onToolOutput,
    resetRequestArchiveState,
    setRequestArchiveStatePathForTest,
    validateToolCalls,
};
