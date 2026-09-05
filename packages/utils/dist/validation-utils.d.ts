declare function assertNonEmptyString(value: unknown, label: string): string;
declare function assertPositiveInteger(value: unknown, label: string): number;
declare function assertNonNegativeInteger(value: unknown, label: string): number;
declare function isPlainObject(value: unknown): value is Record<string, unknown>;
declare function assertHeadersObject(headers: unknown, label: string, options?: {
    disallowedNames?: string[];
}): Readonly<Record<string, string>>;
declare function assertAsciiBytes(bytes: Uint8Array, message: string): void;
declare function assertHexString(value: unknown, label: string): string;
declare function assertHexData(value: unknown, label: string): string;
declare function assertBytes32HexString(value: unknown, label: string): string;
declare function parseBytes(value: unknown, name: string, size?: number): string;
export { assertAsciiBytes, assertBytes32HexString, assertHeadersObject, assertHexData, assertHexString, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, isPlainObject, parseBytes, };
