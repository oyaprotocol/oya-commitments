import { RETRYABLE_HTTP_NETWORK_ERROR_CODES } from '@oyaprotocol/utils';

RETRYABLE_HTTP_NETWORK_ERROR_CODES.has('ECONNRESET');
RETRYABLE_HTTP_NETWORK_ERROR_CODES.forEach((_code, _duplicateCode, set) => {
    set.has('ECONNRESET');
});

// The package-owned view intentionally does not inherit evolving Set APIs.
// @ts-expect-error union is not part of ImmutableSetView.
RETRYABLE_HTTP_NETWORK_ERROR_CODES.union(new Set<string>());
