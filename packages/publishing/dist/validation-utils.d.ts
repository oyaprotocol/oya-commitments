declare function assertNonEmptyString(value: unknown, label: string): string;
declare function assertPositiveInteger(value: unknown, label: string): number;
declare function assertNonNegativeInteger(value: unknown, label: string): number;
declare function assertHeadersObject(headers: unknown, label: string, options?: {
    disallowedNames?: string[];
}): Readonly<Record<string, string>>;
declare function assertAsciiBytes(bytes: Uint8Array, message: string): void;
export { assertAsciiBytes, assertHeadersObject, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, };
