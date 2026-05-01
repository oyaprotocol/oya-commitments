declare function assertNonEmptyString(value: unknown, label: string): string;
declare function assertPositiveInteger(value: unknown, label: string): number;
declare function assertNonNegativeInteger(value: unknown, label: string): number;
declare function assertAsciiBytes(bytes: Uint8Array, message: string): void;
export { assertAsciiBytes, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, };
