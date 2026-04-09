import { getAddress, recoverMessageAddress } from 'viem';
import { canonicalizeJson, isPlainObject, stringifyCanonicalJson } from './canonical-json.js';

const SIGNED_PUBLISHED_MESSAGE_VERSION = 'oya-signed-message-v1';
const SIGNED_PUBLISHED_MESSAGE_KIND = 'generic_message_publication';
const MESSAGE_PUBLICATION_RECORD_VERSION = 'oya-message-publication-record-v1';

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
        version: MESSAGE_PUBLICATION_RECORD_VERSION,
        publication: {
            receivedAtMs: parsePositiveInteger(receivedAtMs, 'receivedAtMs'),
            publishedAtMs: parsePositiveInteger(publishedAtMs, 'publishedAtMs'),
            signerAllowlistMode: normalizeNonEmptyString(
                signerAllowlistMode,
                'signerAllowlistMode'
            ),
            ...(nodeName ? { nodeName: normalizeNonEmptyString(nodeName, 'nodeName') } : {}),
        },
        signedMessage: {
            authType: 'eip191',
            signer: getAddress(signer).toLowerCase(),
            signature,
            signedAtMs: parsePositiveInteger(signedAtMs, 'signedAtMs'),
            canonicalMessage: normalizedCanonicalMessage,
            envelope: normalizedEnvelope,
        },
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

    const publication = {
        receivedAtMs: parsePositiveInteger(
            artifact.publication.receivedAtMs,
            'artifact.publication.receivedAtMs'
        ),
        publishedAtMs: parsePositiveInteger(
            artifact.publication.publishedAtMs,
            'artifact.publication.publishedAtMs'
        ),
        signerAllowlistMode: normalizeNonEmptyString(
            artifact.publication.signerAllowlistMode,
            'artifact.publication.signerAllowlistMode'
        ),
        ...(artifact.publication.nodeName !== undefined
            ? {
                  nodeName: normalizeNonEmptyString(
                      artifact.publication.nodeName,
                      'artifact.publication.nodeName'
                  ),
              }
            : {}),
    };

    const normalizedEnvelope = buildSignedPublishedMessageEnvelope(artifact.signedMessage.envelope ?? {});
    const canonicalMessage = buildSignedPublishedMessagePayload(normalizedEnvelope);
    if (artifact.signedMessage.canonicalMessage !== canonicalMessage) {
        throw new Error('artifact signedMessage.canonicalMessage does not match the normalized envelope.');
    }
    if (artifact.signedMessage.signedAtMs !== normalizedEnvelope.timestampMs) {
        throw new Error('artifact signedMessage.signedAtMs does not match the signed envelope timestamp.');
    }
    if (
        typeof artifact.signedMessage.signature !== 'string' ||
        !/^0x[0-9a-fA-F]{130}$/.test(artifact.signedMessage.signature)
    ) {
        throw new Error('artifact signedMessage.signature must be a 65-byte hex string.');
    }

    const recoveredSigner = getAddress(
        await recoverMessageAddress({
            message: canonicalMessage,
            signature: artifact.signedMessage.signature,
        })
    ).toLowerCase();
    const declaredSigner = getAddress(artifact.signedMessage.signer).toLowerCase();
    if (recoveredSigner !== declaredSigner) {
        throw new Error('artifact signature does not recover to the archived signer.');
    }

    return {
        ok: true,
        signer: declaredSigner,
        chainId: normalizedEnvelope.message.chainId,
        requestId: normalizedEnvelope.message.requestId,
        commitmentAddresses: normalizedEnvelope.message.commitmentAddresses,
        agentAddress: normalizedEnvelope.message.agentAddress,
        signedAtMs: normalizedEnvelope.timestampMs,
        receivedAtMs: publication.receivedAtMs,
        publishedAtMs: publication.publishedAtMs,
        canonicalMessage,
        publication,
        envelope: normalizedEnvelope,
        message: normalizedEnvelope.message,
    };
}

export {
    MESSAGE_PUBLICATION_RECORD_VERSION,
    SIGNED_PUBLISHED_MESSAGE_KIND,
    SIGNED_PUBLISHED_MESSAGE_VERSION,
    buildMessagePublicationArtifact,
    buildMessagePublicationFilename,
    buildSignedPublishedMessageEnvelope,
    buildSignedPublishedMessagePayload,
    normalizePublishedMessage,
    verifySignedPublishedMessageArtifact,
};
