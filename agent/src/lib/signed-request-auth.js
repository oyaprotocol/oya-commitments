import { timingSafeEqual } from 'node:crypto';
import { getAddress, recoverMessageAddress } from 'viem';
import { isPlainObject } from './canonical-json.js';

function safeTokenEquals(leftRaw, rightRaw) {
    const left = Buffer.from(String(leftRaw));
    const right = Buffer.from(String(rightRaw));
    if (left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(left, right);
}

function buildBearerKeyEntries(keys = {}) {
    return Object.entries(keys ?? {}).map(([keyId, token]) => ({
        keyId,
        token,
    }));
}

function authenticateBearerRequest({ authorizationHeader, keyEntries }) {
    if (typeof authorizationHeader !== 'string') return null;
    const [scheme, ...tokenParts] = authorizationHeader.trim().split(/\s+/);
    if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
    const token = tokenParts.join(' ').trim();
    if (!token) return null;

    let matchedKeyId = null;
    for (const entry of keyEntries) {
        if (safeTokenEquals(token, entry.token)) {
            matchedKeyId = matchedKeyId ?? entry.keyId;
        }
    }
    return matchedKeyId;
}

async function authenticateSignedRequest({
    body,
    signerAllowlist,
    requireSignerAllowlist,
    signatureMaxAgeSeconds,
    expectedChainId,
    nowMs,
    buildPayload,
}) {
    if (!body?.auth) {
        return {
            ok: false,
            statusCode: 401,
            message: 'Signed auth is required.',
        };
    }
    if (!isPlainObject(body.auth)) {
        return { ok: false, statusCode: 400, message: 'auth must be an object when provided.' };
    }

    const auth = body.auth;
    if (auth.type !== 'eip191') {
        return { ok: false, statusCode: 400, message: 'auth.type must be "eip191".' };
    }
    if (typeof auth.address !== 'string') {
        return { ok: false, statusCode: 400, message: 'auth.address must be a string.' };
    }
    if (typeof auth.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(auth.signature)) {
        return { ok: false, statusCode: 400, message: 'auth.signature must be a 65-byte hex string.' };
    }
    if (!Number.isInteger(auth.timestampMs)) {
        return { ok: false, statusCode: 400, message: 'auth.timestampMs must be an integer.' };
    }
    if (typeof body.requestId !== 'string' || !body.requestId.trim()) {
        return {
            ok: false,
            statusCode: 400,
            message: 'requestId is required when using signed auth.',
        };
    }
    if (expectedChainId !== undefined && body.chainId !== expectedChainId) {
        return {
            ok: false,
            statusCode: 400,
            message: `chainId must equal ${expectedChainId}.`,
        };
    }

    let declaredAddress;
    try {
        declaredAddress = getAddress(auth.address);
    } catch (error) {
        return { ok: false, statusCode: 400, message: 'auth.address must be a valid EVM address.' };
    }
    const normalizedDeclared = declaredAddress.toLowerCase();
    if (requireSignerAllowlist && signerAllowlist.size === 0) {
        return {
            ok: false,
            statusCode: 503,
            message: 'Signer allowlist is required but not configured.',
        };
    }
    if (requireSignerAllowlist && !signerAllowlist.has(normalizedDeclared)) {
        return { ok: false, statusCode: 401, message: 'Signer is not allowlisted.' };
    }

    const maxAgeMs = signatureMaxAgeSeconds * 1000;
    const maxFutureSkewMs = 30_000;
    const ageMs = nowMs - auth.timestampMs;
    if (ageMs < -maxFutureSkewMs || ageMs > maxAgeMs) {
        return {
            ok: false,
            statusCode: 401,
            message: 'Signed request expired or has an invalid timestamp.',
        };
    }

    let payload;
    try {
        payload = await buildPayload({ declaredAddress });
    } catch (error) {
        return {
            ok: false,
            statusCode: 400,
            message: error?.message ?? 'Unable to build signed payload.',
        };
    }

    let recoveredAddress;
    try {
        recoveredAddress = getAddress(
            await recoverMessageAddress({
                message: payload,
                signature: auth.signature,
            })
        );
    } catch (error) {
        return { ok: false, statusCode: 401, message: 'Invalid message signature.' };
    }

    if (recoveredAddress.toLowerCase() !== normalizedDeclared) {
        return { ok: false, statusCode: 401, message: 'Signature does not match auth.address.' };
    }

    return {
        ok: true,
        payload,
        senderKeyId: `addr:${normalizedDeclared}`,
        sender: {
            authType: 'eip191',
            address: declaredAddress,
            signedAtMs: auth.timestampMs,
            signature: auth.signature,
        },
    };
}

export { authenticateBearerRequest, authenticateSignedRequest, buildBearerKeyEntries };
