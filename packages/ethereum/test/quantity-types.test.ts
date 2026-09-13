import { parseTransactionQuantity } from '@oyaprotocol/ethereum';

declare const value: unknown;
const quantity: bigint = parseTransactionQuantity(value, 'RPC result');
// @ts-expect-error Quantities must not be narrowed to imprecise numbers.
const imprecise: number = parseTransactionQuantity(value, 'RPC result');
// @ts-expect-error An explicit error label is required.
parseTransactionQuantity(value);
void [quantity, imprecise];
