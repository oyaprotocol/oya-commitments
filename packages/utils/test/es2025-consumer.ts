import { RETRYABLE_HTTP_NETWORK_ERROR_CODES } from '@oyaprotocol/utils';

RETRYABLE_HTTP_NETWORK_ERROR_CODES.has('ECONNRESET');
RETRYABLE_HTTP_NETWORK_ERROR_CODES.forEach((_code, _duplicateCode, set) => {
    set.has('ECONNRESET');
});
RETRYABLE_HTTP_NETWORK_ERROR_CODES.union(new Set<string>());
RETRYABLE_HTTP_NETWORK_ERROR_CODES.intersection(new Set<string>());
RETRYABLE_HTTP_NETWORK_ERROR_CODES.difference(new Set<string>());
RETRYABLE_HTTP_NETWORK_ERROR_CODES.symmetricDifference(new Set<string>());
RETRYABLE_HTTP_NETWORK_ERROR_CODES.isSubsetOf(new Set<string>());
RETRYABLE_HTTP_NETWORK_ERROR_CODES.isSupersetOf(new Set<string>());
RETRYABLE_HTTP_NETWORK_ERROR_CODES.isDisjointFrom(new Set<string>());
