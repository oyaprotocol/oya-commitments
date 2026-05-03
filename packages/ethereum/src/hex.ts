import { assertNonEmptyString } from '@oyaprotocol/utils';

function assertHexString(value: unknown, label: string): string {
    const normalized = assertNonEmptyString(value, label);
    if (!/^0x[0-9a-fA-F]*$/.test(normalized)) {
        throw new Error(`${label} must be a 0x-prefixed hex string.`);
    }
    return normalized;
}

function normalizeHexData(value: unknown, label: string): string {
    const validated = assertHexString(value, label);
    if (validated.length === 2 || validated.length % 2 !== 0) {
        throw new Error(`${label} must be non-empty byte-aligned hex data.`);
    }
    return validated;
}

function normalizeHash(value: unknown, label: string): string {
    const validated = assertHexString(value, label);
    if (validated.length !== 66) {
        throw new Error(`${label} must be a 32-byte hex string.`);
    }
    return validated;
}

export { normalizeHash, normalizeHexData };
