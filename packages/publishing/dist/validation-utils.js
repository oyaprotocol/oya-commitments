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
function assertAsciiBytes(bytes, message) {
    for (const byte of bytes) {
        if (byte > 0x7f) {
            throw new Error(message);
        }
    }
}
export { assertAsciiBytes, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, };
//# sourceMappingURL=validation-utils.js.map