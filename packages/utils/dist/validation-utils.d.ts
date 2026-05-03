declare function assertNonEmptyString(value: unknown, label: string): string;
declare function assertPositiveInteger(value: unknown, label: string): number;
declare function assertNonNegativeInteger(value: unknown, label: string): number;
declare function isPlainObject(value: unknown): value is Record<string, unknown>;
declare function assertHeadersObject(headers: unknown, label: string, options?: {
    disallowedNames?: string[];
}): Readonly<Record<string, string>>;
export { assertHeadersObject, assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger, isPlainObject, };
