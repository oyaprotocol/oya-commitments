import { canonicalizeJson, isPlainObject } from './canonical-json.js';

function parseNonNegativeInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return parsed;
}

function normalizeNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}

function normalizeOptionalNonEmptyString(value, label) {
    if (value === undefined || value === null) {
        return null;
    }
    return normalizeNonEmptyString(value, label);
}

function normalizeValidationClassification(
    value,
    label = 'validation.classifications[]'
) {
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be a JSON object.`);
    }

    return canonicalizeJson({
        id: normalizeNonEmptyString(value.id, `${label}.id`),
        classification: normalizeNonEmptyString(
            value.classification,
            `${label}.classification`
        ),
        firstSeenAtMs: parseNonNegativeInteger(
            value.firstSeenAtMs,
            `${label}.firstSeenAtMs`
        ),
        ...(normalizeOptionalNonEmptyString(value.reason, `${label}.reason`)
            ? {
                  reason: normalizeOptionalNonEmptyString(
                      value.reason,
                      `${label}.reason`
                  ),
              }
            : {}),
    });
}

function normalizeValidationClassifications(value, label) {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array when provided.`);
    }

    const normalized = value.map((item, index) =>
        normalizeValidationClassification(item, `${label}[${index}]`)
    );
    normalized.sort((left, right) => {
        if (left.id !== right.id) {
            return left.id.localeCompare(right.id);
        }
        if (left.classification !== right.classification) {
            return left.classification.localeCompare(right.classification);
        }
        return left.firstSeenAtMs - right.firstSeenAtMs;
    });
    return normalized;
}

function normalizeMessagePublicationValidation(value, label = 'validation') {
    if (value === undefined || value === null) {
        return null;
    }
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be a JSON object.`);
    }

    const classifications = normalizeValidationClassifications(
        value.classifications,
        `${label}.classifications`
    );
    const normalized = {
        validatorId: normalizeNonEmptyString(value.validatorId, `${label}.validatorId`),
        status: normalizeNonEmptyString(value.status, `${label}.status`),
    };
    if (classifications.length > 0) {
        normalized.classifications = classifications;
    }
    if (value.summary !== undefined) {
        if (!isPlainObject(value.summary)) {
            throw new Error(`${label}.summary must be a JSON object when provided.`);
        }
        normalized.summary = canonicalizeJson(value.summary);
    }
    return canonicalizeJson(normalized);
}

class MessagePublicationValidationError extends Error {
    constructor(
        message,
        { code = 'message_validation_failed', statusCode = 422, details = null, cause } = {}
    ) {
        super(message, cause ? { cause } : undefined);
        this.name = 'MessagePublicationValidationError';
        this.code = code;
        this.statusCode = statusCode;
        this.details = details === undefined ? null : canonicalizeJson(details);
    }
}

export {
    MessagePublicationValidationError,
    normalizeMessagePublicationValidation,
};
