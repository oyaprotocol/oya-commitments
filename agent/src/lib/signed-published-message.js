import { getAddress, recoverMessageAddress } from 'viem';
import { canonicalizeJson, isPlainObject, stringifyCanonicalJson } from './canonical-json.js';

const SIGNED_PUBLISHED_MESSAGE_VERSION = 'oya-signed-message-v1';
const SIGNED_PUBLISHED_MESSAGE_KIND = 'generic_message_publication';
const MESSAGE_PUBLICATION_RECORD_VERSION = 'oya-message-publication-record-v1';
const NODE_MESSAGE_PUBLICATION_ATTESTATION_VERSION =
    'oya-node-message-publication-attestation-v1';
const NODE_MESSAGE_PUBLICATION_ATTESTATION_KIND = 'message_publication_attestation';

function parsePositiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function normalizeNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}

function normalizeAddressArray(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${label} must be a non-empty array of addresses.`);
    }
    return value.map((item, index) =>
        getAddress(normalizeNonEmptyString(item, `${label}[${index}]`)).toLowerCase()
    );
}

function normalizePublishedMessage(message, label = 'message') {
    if (!isPlainObject(message)) {
        throw new Error(`${label} must be a JSON object.`);
    }

    const normalized = canonicalizeJson(message);
    return canonicalizeJson({
        ...normalized,
        chainId: parsePositiveInteger(normalized.chainId, `${label}.chainId`),
        requestId: normalizeNonEmptyString(normalized.requestId, `${label}.requestId`),
        commitmentAddresses: normalizeAddressArray(
            normalized.commitmentAddresses,
            `${label}.commitmentAddresses`
        ),
        agentAddress: getAddress(
            normalizeNonEmptyString(normalized.agentAddress, `${label}.agentAddress`)
        ).toLowerCase(),
    });
}

function buildSignedPublishedMessageEnvelope({ address, timestampMs, message }) {
    const normalizedAddress = getAddress(address).toLowerCase();
    const normalizedMessage = normalizePublishedMessage(message);
    if (normalizedMessage.agentAddress !== normalizedAddress) {
        throw new Error('message.agentAddress must match the signing address.');
    }

    return canonicalizeJson({
        version: SIGNED_PUBLISHED_MESSAGE_VERSION,
        kind: SIGNED_PUBLISHED_MESSAGE_KIND,
        address: normalizedAddress,
        timestampMs: parsePositiveInteger(timestampMs, 'timestampMs'),
        message: normalizedMessage,
    });
}

function buildSignedPublishedMessagePayload(args) {
    return stringifyCanonicalJson(buildSignedPublishedMessageEnvelope(args));
}

function normalizePublicationMetadata({
    receivedAtMs,
    publishedAtMs,
    signerAllowlistMode,
    nodeName,
}) {
    return canonicalizeJson({
        receivedAtMs: parsePositiveInteger(receivedAtMs, 'receivedAtMs'),
        publishedAtMs: parsePositiveInteger(publishedAtMs, 'publishedAtMs'),
        signerAllowlistMode: normalizeNonEmptyString(
            signerAllowlistMode,
            'signerAllowlistMode'
        ),
        ...(nodeName ? { nodeName: normalizeNonEmptyString(nodeName, 'nodeName') } : {}),
    });
}

function normalizeSignedMessageReference({
    signer,
    signature,
    canonicalMessage,
}) {
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new Error('signature must be a 65-byte hex string.');
    }
    if (typeof canonicalMessage !== 'string' || !canonicalMessage.trim()) {
        throw new Error('canonicalMessage must be a non-empty string.');
    }

    return canonicalizeJson({
        signer: getAddress(signer).toLowerCase(),
        signature,
        canonicalMessage,
    });
}

function buildArchivedSignedMessageRecord({
    signer,
    signature,
    signedAtMs,
    canonicalMessage,
    envelope,
}) {
    const normalizedEnvelope = buildSignedPublishedMessageEnvelope(envelope);
    const normalizedCanonicalMessage = buildSignedPublishedMessagePayload(normalizedEnvelope);
    if (canonicalMessage !== normalizedCanonicalMessage) {
        throw new Error('canonicalMessage does not match the normalized signed message envelope.');
    }
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new Error('signature must be a 65-byte hex string.');
    }

    return canonicalizeJson({
        authType: 'eip191',
        signer: getAddress(signer).toLowerCase(),
        signature,
        signedAtMs: parsePositiveInteger(signedAtMs, 'signedAtMs'),
        canonicalMessage: normalizedCanonicalMessage,
        envelope: normalizedEnvelope,
    });
}

function buildMessagePublicationNodeAttestationEnvelope({
    address,
    timestampMs,
    publication,
    signedMessage,
}) {
    return canonicalizeJson({
        version: NODE_MESSAGE_PUBLICATION_ATTESTATION_VERSION,
        kind: NODE_MESSAGE_PUBLICATION_ATTESTATION_KIND,
        address: getAddress(address).toLowerCase(),
        timestampMs: parsePositiveInteger(timestampMs, 'timestampMs'),
        publication: normalizePublicationMetadata(publication),
        signedMessage: normalizeSignedMessageReference(signedMessage),
    });
}

function buildMessagePublicationNodeAttestationPayload(args) {
    return stringifyCanonicalJson(buildMessagePublicationNodeAttestationEnvelope(args));
}

function buildMessagePublicationNodeAttestationRecord({
    signer,
    signature,
    signedAtMs,
    canonicalMessage,
    envelope,
}) {
    const normalizedEnvelope = buildMessagePublicationNodeAttestationEnvelope(envelope);
    const normalizedCanonicalMessage = buildMessagePublicationNodeAttestationPayload(
        normalizedEnvelope
    );
    if (canonicalMessage !== normalizedCanonicalMessage) {
        throw new Error(
            'canonicalMessage does not match the normalized message publication node attestation envelope.'
        );
    }
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new Error('signature must be a 65-byte hex string.');
    }

    return canonicalizeJson({
        authType: 'eip191',
        signer: getAddress(signer).toLowerCase(),
        signature,
        signedAtMs: parsePositiveInteger(signedAtMs, 'signedAtMs'),
        canonicalMessage: normalizedCanonicalMessage,
        envelope: normalizedEnvelope,
    });
}

function sanitizeFilenameSegment(value) {
    return String(value)
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
}

function buildMessagePublicationFilename({ requestId, signer }) {
    const requestPart = sanitizeFilenameSegment(requestId) || 'request';
    const signerPart = getAddress(signer).toLowerCase().slice(2, 10);
    return `signed-message-${requestPart}-${signerPart}.json`;
}

function buildMessagePublicationArtifact({
    signer,
    signature,
    signedAtMs,
    canonicalMessage,
    envelope,
    receivedAtMs,
    publishedAtMs,
    signerAllowlistMode,
    nodeName,
    nodeAttestation,
}) {
    const normalizedPublication = normalizePublicationMetadata({
        receivedAtMs,
        publishedAtMs,
        signerAllowlistMode,
        nodeName,
    });
    const normalizedSignedMessage = buildArchivedSignedMessageRecord({
        signer,
        signature,
        signedAtMs,
        canonicalMessage,
        envelope,
    });
    const normalizedNodeAttestation =
        nodeAttestation === undefined || nodeAttestation === null
            ? null
            : buildMessagePublicationNodeAttestationRecord(nodeAttestation);

    if (normalizedNodeAttestation) {
        const expectedPublication = JSON.stringify(normalizedPublication);
        const expectedSignedMessage = JSON.stringify(
            normalizeSignedMessageReference(normalizedSignedMessage)
        );
        if (
            JSON.stringify(normalizedNodeAttestation.envelope.publication) !== expectedPublication
        ) {
            throw new Error(
                'nodeAttestation must attest to the same publication metadata embedded in the artifact.'
            );
        }
        if (
            JSON.stringify(normalizedNodeAttestation.envelope.signedMessage) !==
            expectedSignedMessage
        ) {
            throw new Error(
                'nodeAttestation must attest to the same signed message embedded in the artifact.'
            );
        }
    }

    return canonicalizeJson({
        version: MESSAGE_PUBLICATION_RECORD_VERSION,
        publication: {
            ...normalizedPublication,
            ...(normalizedNodeAttestation
                ? { nodeAttestation: normalizedNodeAttestation }
                : {}),
        },
        signedMessage: normalizedSignedMessage,
    });
}

async function verifySignedPublishedMessageArtifact(artifact) {
    if (!isPlainObject(artifact)) {
        throw new Error('artifact must be a JSON object.');
    }
    if (artifact.version !== MESSAGE_PUBLICATION_RECORD_VERSION) {
        throw new Error(`artifact.version must be "${MESSAGE_PUBLICATION_RECORD_VERSION}".`);
    }
    if (!isPlainObject(artifact.publication)) {
        throw new Error('artifact.publication must be an object.');
    }
    if (!isPlainObject(artifact.signedMessage)) {
        throw new Error('artifact.signedMessage must be an object.');
    }

    const publication = normalizePublicationMetadata({
        receivedAtMs: artifact.publication.receivedAtMs,
        publishedAtMs: artifact.publication.publishedAtMs,
        signerAllowlistMode: artifact.publication.signerAllowlistMode,
        nodeName: artifact.publication.nodeName,
    });
    const normalizedSignedMessage = buildArchivedSignedMessageRecord({
        signer: artifact.signedMessage.signer,
        signature: artifact.signedMessage.signature,
        signedAtMs: artifact.signedMessage.signedAtMs,
        canonicalMessage: artifact.signedMessage.canonicalMessage,
        envelope: artifact.signedMessage.envelope ?? {},
    });
    const canonicalMessage = normalizedSignedMessage.canonicalMessage;

    const recoveredSigner = getAddress(
        await recoverMessageAddress({
            message: canonicalMessage,
            signature: normalizedSignedMessage.signature,
        })
    ).toLowerCase();
    const declaredSigner = normalizedSignedMessage.signer;
    if (recoveredSigner !== declaredSigner) {
        throw new Error('artifact signature does not recover to the archived signer.');
    }

    let normalizedNodeAttestation = null;
    if (artifact.publication.nodeAttestation !== undefined) {
        normalizedNodeAttestation = buildMessagePublicationNodeAttestationRecord(
            artifact.publication.nodeAttestation
        );
        const expectedSignedMessageReference = normalizeSignedMessageReference(
            normalizedSignedMessage
        );
        if (
            JSON.stringify(normalizedNodeAttestation.envelope.publication) !==
            JSON.stringify(publication)
        ) {
            throw new Error(
                'artifact node attestation does not match the normalized publication metadata.'
            );
        }
        if (
            JSON.stringify(normalizedNodeAttestation.envelope.signedMessage) !==
            JSON.stringify(expectedSignedMessageReference)
        ) {
            throw new Error(
                'artifact node attestation does not match the normalized signed message.'
            );
        }

        const recoveredNodeSigner = getAddress(
            await recoverMessageAddress({
                message: normalizedNodeAttestation.canonicalMessage,
                signature: normalizedNodeAttestation.signature,
            })
        ).toLowerCase();
        if (recoveredNodeSigner !== normalizedNodeAttestation.signer) {
            throw new Error('artifact node attestation signature does not recover to the archived node signer.');
        }
    }

    return {
        ok: true,
        signer: declaredSigner,
        chainId: normalizedSignedMessage.envelope.message.chainId,
        requestId: normalizedSignedMessage.envelope.message.requestId,
        commitmentAddresses: normalizedSignedMessage.envelope.message.commitmentAddresses,
        agentAddress: normalizedSignedMessage.envelope.message.agentAddress,
        signedAtMs: normalizedSignedMessage.envelope.timestampMs,
        receivedAtMs: publication.receivedAtMs,
        publishedAtMs: publication.publishedAtMs,
        canonicalMessage,
        publication,
        nodeAttestation: normalizedNodeAttestation,
        envelope: normalizedSignedMessage.envelope,
        message: normalizedSignedMessage.envelope.message,
    };
}

export {
    MESSAGE_PUBLICATION_RECORD_VERSION,
    NODE_MESSAGE_PUBLICATION_ATTESTATION_KIND,
    NODE_MESSAGE_PUBLICATION_ATTESTATION_VERSION,
    SIGNED_PUBLISHED_MESSAGE_KIND,
    SIGNED_PUBLISHED_MESSAGE_VERSION,
    buildMessagePublicationArtifact,
    buildMessagePublicationFilename,
    buildMessagePublicationNodeAttestationEnvelope,
    buildMessagePublicationNodeAttestationPayload,
    buildMessagePublicationNodeAttestationRecord,
    buildSignedPublishedMessageEnvelope,
    buildSignedPublishedMessagePayload,
    normalizePublishedMessage,
    verifySignedPublishedMessageArtifact,
};
