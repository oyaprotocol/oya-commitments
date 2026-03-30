import { getAddress } from 'viem';
import { recoverMessageAddress } from 'viem';
import { canonicalizeJson, isPlainObject, stringifyCanonicalJson } from './canonical-json.js';

const SIGNED_PROPOSAL_VERSION = 'oya-signed-proposal-v1';
const SIGNED_PROPOSAL_KIND = 'og_proposal_publication';
const PROPOSAL_PUBLICATION_RECORD_VERSION = 'oya-proposal-publication-record-v1';

function parsePositiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function parseOptionalTimestamp(value, label) {
    if (value === undefined || value === null) {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        throw new Error(`${label} must be an integer when provided.`);
    }
    return parsed;
}

function normalizeNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}

function normalizeHexData(value, label) {
    if (value === undefined || value === null || value === '') {
        return '0x';
    }
    if (typeof value !== 'string') {
        throw new Error(`${label} must be a hex string when provided.`);
    }
    const trimmed = value.trim();
    if (!/^0x([0-9a-fA-F]{2})*$/.test(trimmed)) {
        throw new Error(`${label} must be a 0x-prefixed even-length hex string.`);
    }
    return trimmed.toLowerCase();
}

function normalizeValueString(value, label) {
    try {
        const normalized = BigInt(value ?? 0);
        if (normalized < 0n) {
            throw new Error(`${label} must be non-negative.`);
        }
        return normalized.toString();
    } catch (error) {
        if (error instanceof Error && error.message.includes(label)) {
            throw error;
        }
        throw new Error(`${label} must be an integer-like value.`);
    }
}

function normalizeOperation(value, label) {
    if (value === undefined || value === null) {
        return 0;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || (parsed !== 0 && parsed !== 1)) {
        throw new Error(`${label} must be 0 or 1 when provided.`);
    }
    return parsed;
}

function normalizeMetadata(value, label) {
    if (value === undefined || value === null) {
        return null;
    }
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be a JSON object when provided.`);
    }
    return canonicalizeJson(value);
}

function normalizeTransactions(transactions, label = 'transactions') {
    if (!Array.isArray(transactions) || transactions.length === 0) {
        throw new Error(`${label} must be a non-empty array.`);
    }

    return transactions.map((transaction, index) => {
        if (!isPlainObject(transaction)) {
            throw new Error(`${label}[${index}] must be an object.`);
        }
        if (typeof transaction.to !== 'string' || !transaction.to.trim()) {
            throw new Error(`${label}[${index}].to must be a non-empty address string.`);
        }

        return {
            to: getAddress(transaction.to).toLowerCase(),
            value: normalizeValueString(transaction.value ?? 0, `${label}[${index}].value`),
            data: normalizeHexData(transaction.data, `${label}[${index}].data`),
            operation: normalizeOperation(transaction.operation, `${label}[${index}].operation`),
        };
    });
}

function buildSignedProposalEnvelope({
    address,
    chainId,
    timestampMs,
    requestId,
    commitmentSafe,
    ogModule,
    transactions,
    explanation,
    metadata,
    deadline,
}) {
    const normalizedExplanation =
        typeof explanation === 'string' && explanation.trim()
            ? explanation
            : (() => {
                  throw new Error('explanation must be a non-empty string.');
              })();

    return canonicalizeJson({
        version: SIGNED_PROPOSAL_VERSION,
        kind: SIGNED_PROPOSAL_KIND,
        address: getAddress(address).toLowerCase(),
        chainId: parsePositiveInteger(chainId, 'chainId'),
        timestampMs: parsePositiveInteger(timestampMs, 'timestampMs'),
        requestId: normalizeNonEmptyString(requestId, 'requestId'),
        commitmentSafe: getAddress(commitmentSafe).toLowerCase(),
        ogModule: getAddress(ogModule).toLowerCase(),
        transactions: normalizeTransactions(transactions),
        explanation: normalizedExplanation,
        metadata: normalizeMetadata(metadata, 'metadata'),
        deadline: parseOptionalTimestamp(deadline, 'deadline'),
    });
}

function buildSignedProposalPayload(args) {
    return stringifyCanonicalJson(buildSignedProposalEnvelope(args));
}

function sanitizeFilenameSegment(value) {
    return String(value)
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
}

function buildProposalPublicationFilename({ requestId, signer }) {
    const requestPart = sanitizeFilenameSegment(requestId) || 'request';
    const signerPart = getAddress(signer).toLowerCase().slice(2, 10);
    return `signed-proposal-${requestPart}-${signerPart}.json`;
}

function buildProposalPublicationArtifact({
    signer,
    signature,
    signedAtMs,
    canonicalMessage,
    envelope,
    receivedAtMs,
    publishedAtMs,
    signerAllowlistMode,
    nodeName,
}) {
    const normalizedEnvelope = buildSignedProposalEnvelope(envelope);
    const normalizedCanonicalMessage = buildSignedProposalPayload(normalizedEnvelope);
    if (canonicalMessage !== normalizedCanonicalMessage) {
        throw new Error('canonicalMessage does not match the normalized signed proposal envelope.');
    }

    const artifact = {
        version: PROPOSAL_PUBLICATION_RECORD_VERSION,
        publication: {
            receivedAtMs: parsePositiveInteger(receivedAtMs, 'receivedAtMs'),
            publishedAtMs: parsePositiveInteger(publishedAtMs, 'publishedAtMs'),
            signerAllowlistMode: normalizeNonEmptyString(signerAllowlistMode, 'signerAllowlistMode'),
            ...(nodeName ? { nodeName: normalizeNonEmptyString(nodeName, 'nodeName') } : {}),
        },
        signedProposal: {
            authType: 'eip191',
            signer: getAddress(signer).toLowerCase(),
            signature,
            signedAtMs: parsePositiveInteger(signedAtMs, 'signedAtMs'),
            canonicalMessage: normalizedCanonicalMessage,
            envelope: normalizedEnvelope,
        },
    };
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new Error('signature must be a 65-byte hex string.');
    }
    return canonicalizeJson(artifact);
}

async function verifySignedProposalArtifact(artifact) {
    if (!isPlainObject(artifact)) {
        throw new Error('artifact must be a JSON object.');
    }
    if (artifact.version !== PROPOSAL_PUBLICATION_RECORD_VERSION) {
        throw new Error(`artifact.version must be "${PROPOSAL_PUBLICATION_RECORD_VERSION}".`);
    }
    if (!isPlainObject(artifact.publication)) {
        throw new Error('artifact.publication must be an object.');
    }
    if (!isPlainObject(artifact.signedProposal)) {
        throw new Error('artifact.signedProposal must be an object.');
    }

    const signedProposal = artifact.signedProposal;
    const normalizedEnvelope = buildSignedProposalEnvelope(signedProposal.envelope ?? {});
    const canonicalMessage = buildSignedProposalPayload(normalizedEnvelope);
    if (signedProposal.canonicalMessage !== canonicalMessage) {
        throw new Error('artifact signedProposal.canonicalMessage does not match the normalized envelope.');
    }
    if (signedProposal.signedAtMs !== normalizedEnvelope.timestampMs) {
        throw new Error('artifact signedProposal.signedAtMs does not match the signed envelope timestamp.');
    }
    if (typeof signedProposal.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signedProposal.signature)) {
        throw new Error('artifact signedProposal.signature must be a 65-byte hex string.');
    }

    const recoveredSigner = getAddress(
        await recoverMessageAddress({
            message: canonicalMessage,
            signature: signedProposal.signature,
        })
    ).toLowerCase();
    const declaredSigner = getAddress(signedProposal.signer).toLowerCase();
    if (recoveredSigner !== declaredSigner) {
        throw new Error('artifact signature does not recover to the archived signer.');
    }

    return {
        ok: true,
        signer: declaredSigner,
        requestId: normalizedEnvelope.requestId,
        chainId: normalizedEnvelope.chainId,
        commitmentSafe: normalizedEnvelope.commitmentSafe,
        ogModule: normalizedEnvelope.ogModule,
        transactionCount: normalizedEnvelope.transactions.length,
        signedAtMs: normalizedEnvelope.timestampMs,
        receivedAtMs: artifact.publication.receivedAtMs,
        publishedAtMs: artifact.publication.publishedAtMs,
        canonicalMessage,
        envelope: normalizedEnvelope,
    };
}

export {
    PROPOSAL_PUBLICATION_RECORD_VERSION,
    SIGNED_PROPOSAL_KIND,
    SIGNED_PROPOSAL_VERSION,
    buildProposalPublicationArtifact,
    buildProposalPublicationFilename,
    buildSignedProposalEnvelope,
    buildSignedProposalPayload,
    normalizeTransactions,
    verifySignedProposalArtifact,
};
