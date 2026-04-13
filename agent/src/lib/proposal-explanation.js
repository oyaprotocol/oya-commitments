import { isPlainObject, stringifyCanonicalJson } from './canonical-json.js';
import { normalizeHashOrNull } from './utils.js';

function normalizeExplanationKind(value, label = 'kind') {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}

function normalizeExplanationDescription(value, label = 'description') {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}

function normalizeExplanationDepositTxHashes(value, { required = false } = {}) {
    if (value === undefined || value === null) {
        if (required) {
            throw new Error('depositTxHashes must be a non-empty array.');
        }
        return [];
    }
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('depositTxHashes must be a non-empty array.');
    }

    const normalized = value.map((item, index) => {
        const hash = normalizeHashOrNull(item);
        if (!hash) {
            throw new Error(`depositTxHashes[${index}] must be a 32-byte hex string.`);
        }
        return hash;
    });
    if (new Set(normalized).size !== normalized.length) {
        throw new Error('depositTxHashes must not contain duplicates.');
    }
    return normalized;
}

function normalizeStructuredProposalExplanation(value, { requireDepositTxHashes = false } = {}) {
    if (!isPlainObject(value)) {
        throw new Error('Structured proposal explanation must be a JSON object.');
    }
    return {
        description: normalizeExplanationDescription(value.description),
        depositTxHashes: normalizeExplanationDepositTxHashes(value.depositTxHashes, {
            required: requireDepositTxHashes,
        }),
        kind: normalizeExplanationKind(value.kind),
    };
}

function buildStructuredProposalExplanation({
    kind,
    description,
    depositTxHashes = undefined,
}) {
    const normalized = normalizeStructuredProposalExplanation(
        {
            kind,
            description,
            depositTxHashes,
        },
        {
            requireDepositTxHashes: depositTxHashes !== undefined,
        }
    );
    return stringifyCanonicalJson(normalized);
}

function parseStructuredProposalExplanation(explanation, options = {}) {
    if (typeof explanation !== 'string' || !explanation.trim()) {
        return null;
    }
    try {
        return normalizeStructuredProposalExplanation(JSON.parse(explanation), options);
    } catch {
        return null;
    }
}

export {
    buildStructuredProposalExplanation,
    normalizeStructuredProposalExplanation,
    parseStructuredProposalExplanation,
};
