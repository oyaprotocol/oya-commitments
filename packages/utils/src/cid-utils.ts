const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Validate the kernel's CIDv1 / lowercase unpadded Base32 / SHA-256 format. */
function assertCanonicalCid(value: unknown, label: string): string {
    const invalid = () => new TypeError(
        `${label} must be a canonical CIDv1 in lowercase unpadded Base32 with a 32-byte SHA-256 digest.`
    );
    // One-byte version/hash/length, a 1–9-byte codec varint, and a 32-byte digest.
    // Bound the input before decoding; no trimming, URLs, paths, or alternate bases.
    if (typeof value !== 'string' || value.length < 59 || value.length > 72 || !/^b[a-z2-7]+$/.test(value)) {
        throw invalid();
    }

    const bytes: number[] = [];
    let accumulator = 0;
    let bitCount = 0;
    for (const character of value.slice(1)) {
        accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
        bitCount += 5;
        if (bitCount >= 8) {
            bitCount -= 8;
            bytes.push(accumulator >> bitCount);
            accumulator &= (1 << bitCount) - 1;
        }
    }
    // Reject redundant symbols and nonzero unused bits, not just '=' padding.
    if (bitCount >= 5 || accumulator !== 0 || bytes[0] !== 1) {
        throw invalid();
    }

    // A codec is an unsigned, minimally encoded varint of at most 63 bits.
    // Do not freeze the evolving codec registry into this format validator.
    let offset = 1;
    while (offset <= 9 && (bytes[offset] & 0x80) !== 0) {
        offset += 1;
    }
    if (offset > 9 || (offset > 1 && bytes[offset] === 0)) {
        throw invalid();
    }
    offset += 1;
    // Requiring these exact bytes also rejects nonminimal hash/length varints.
    if (bytes[offset] !== 0x12 || bytes[offset + 1] !== 0x20 || bytes.length !== offset + 2 + 32) {
        throw invalid();
    }
    return value;
}

export { assertCanonicalCid };
