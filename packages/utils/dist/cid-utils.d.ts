/** Validate the kernel's CIDv1 / lowercase unpadded Base32 / SHA-256 format. */
declare function assertCanonicalCid(value: unknown, label: string): string;
export { assertCanonicalCid };
