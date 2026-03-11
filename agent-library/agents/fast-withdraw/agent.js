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
        'The archive artifact must preserve the canonical signed message, the signer address, the signature, and the request envelope fields.',
        'Do not reimburse or dispute unless later logic proves the direct fill and reimbursement satisfy the commitment.',
        'Use ipfs_publish for archival when IPFS is enabled.',
        mode,
        commitmentText ? `Commitment text:\n${commitmentText}` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

async function getDeterministicToolCalls({
    signals,
    commitmentSafe,
    agentAddress,
    config,
}) {
    await hydrateRequestArchiveState();
    const signedMessages = Array.isArray(signals) ? signals.filter(isSignedUserMessage) : [];
    if (signedMessages.length === 0) {
        return [];
    }
    if (!config?.ipfsEnabled) {
        throw new Error(
            'fast-withdraw agent requires IPFS_ENABLED=true to archive signed withdrawal requests.'
        );
    }

    const toolCalls = [];
    const scheduledRequestIds = new Set();
    for (const message of signedMessages) {
        const requestId = message.requestId.trim();
        if (!requestId) continue;
        if (scheduledRequestIds.has(requestId)) continue;
        if (requestArchiveState.requests?.[requestId]?.artifactCid) continue;

        const filename = buildArtifactFilename(requestId);
        const artifact = buildSignedRequestArchiveArtifact({
            message,
            commitmentSafe,
            agentAddress,
        });
        pendingArtifactPublishes.set(
            filename,
            buildSignedRequestArchiveRecord({
                message,
                commitmentSafe,
                agentAddress,
            })
        );
        scheduledRequestIds.add(requestId);
        toolCalls.push({
            callId: `fast-withdraw-ipfs-${encodeRequestIdForFilename(requestId)}`,
            name: 'ipfs_publish',
            arguments: JSON.stringify({
                json: artifact,
                filename,
                pin: true,
            }),
        });
    }

    return toolCalls;
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
    buildSignedRequestArchiveArtifact,
    decodeRequestIdFromFilename,
    getDeterministicToolCalls,
    getRequestArchiveState,
    getSystemPrompt,
    onToolOutput,
    resetRequestArchiveState,
    setRequestArchiveStatePathForTest,
};
