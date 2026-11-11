import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
function checksumAddress(hex) {
    const lower = hex.toLowerCase();
    const digest = bytesToHex(keccak_256(utf8ToBytes(lower)));
    return '0x' + [...lower].map((char, index) => parseInt(digest[index], 16) >= 8 ? char.toUpperCase() : char).join('');
}
/** Normalize a hex or direct ICAP address, validating any supplied checksum. */
export function getAddress(value) {
    if (typeof value !== 'string')
        throw new Error('Invalid Ethereum address.');
    if ((value.length === 40 || value.length === 42) && /^(?:0x)?[0-9a-fA-F]{40}$/.test(value)) {
        const hex = value.startsWith('0x') ? value.slice(2) : value;
        const result = checksumAddress(hex);
        if (/[a-f]/.test(hex) && /[A-F]/.test(hex) && result.slice(2) !== hex) {
            throw new Error('Invalid Ethereum address checksum.');
        }
        return result;
    }
    if ((value.length === 34 || value.length === 35) && /^XE[0-9]{2}[0-9a-zA-Z]{30,31}$/.test(value)) {
        const body = value.slice(4).toUpperCase();
        // IBAN mod-97 check digits over the rearranged alphanumeric representation.
        let remainder = 0;
        for (const char of body + 'XE00') {
            const digit = parseInt(char, 36);
            remainder = (remainder * (digit < 10 ? 10 : 100) + digit) % 97;
        }
        if (value.slice(2, 4) !== String(98 - remainder).padStart(2, '0')) {
            throw new Error('Invalid ICAP checksum.');
        }
        let address = 0n;
        for (const char of body)
            address = address * 36n + BigInt(parseInt(char, 36));
        if (address >= (1n << 160n))
            throw new Error('Invalid Ethereum address.');
        return checksumAddress(address.toString(16).padStart(40, '0'));
    }
    throw new Error('Invalid Ethereum address.');
}
//# sourceMappingURL=address.js.map