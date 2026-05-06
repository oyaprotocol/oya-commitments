function assertNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}
function assertPositiveInteger(value, label) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return value;
}
function assertNonNegativeInteger(value, label) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return value;
}
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function assertHeadersObject(headers, label, options = {}) {
    if (!isPlainObject(headers)) {
        throw new Error(`${label} must be a plain object.`);
    }
    const disallowedNames = new Set((options.disallowedNames ?? []).map((name) => name.toLowerCase()));
    const validated = {};
    for (const [key, value] of Object.entries(headers)) {
        if (disallowedNames.has(key.toLowerCase())) {
            throw new Error(`${label} must not include ${key.toLowerCase()}.`);
        }
        if (typeof value !== 'string') {
            throw new Error(`${label}.${key} must be a string.`);
        }
        validated[key] = value;
    }
    return Object.freeze(validated);
}
function assertAsciiBytes(bytes, message) {
    for (const byte of bytes) {
        if (byte > 0x7f) {
            throw new Error(message);
        }
    }
}
function assertHexString(value, label) {
    const validated = assertNonEmptyString(value, label);
    if (!/^0x[0-9a-fA-F]*$/.test(validated)) {
        throw new Error(`${label} must be a 0x-prefixed hex string.`);
    }
    return validated;
}
function assertHexData(value, label) {
    const validated = assertHexString(value, label);
    if (validated.length === 2 || validated.length % 2 !== 0) {
        throw new Error(`${label} must be non-empty byte-aligned hex data.`);
    }
    return validated;
}
function assertBytes32HexString(value, label) {
    const validated = assertHexString(value, label);
    if (validated.length !== 66) {
        throw new Error(`${label} must be a 32-byte hex string.`);
    }
    return validated;
}
export { assertAsciiBytes, assertBytes32HexString, assertHeadersObject, assertHexData, assertHexString, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, isPlainObject, };
//# sourceMappingURL=validation-utils.js.map