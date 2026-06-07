# @oyaprotocol/messages

Signed message validation primitives for Oya nodes.

## Public Entrypoint

- `@oyaprotocol/messages`

## Current API

The package currently exposes schema normalization for the v1 signed text message body:

    {
      "text": "Please withdraw 100 USDC.",
      "signer": "0x1111111111111111111111111111111111111111",
      "signature": "0x..."
    }

`normalizeSignedMessage(input)` validates that the body is a JSON-style object with exactly `text`, `signer`, and `signature`.

- `text` must be a non-empty string and is preserved exactly; it is not trimmed or parsed.
- `signer` must be a 20-byte `0x`-prefixed Ethereum address and is normalized to lowercase.
- `signature` must be a 65-byte `0x`-prefixed Ethereum signature string and is preserved as submitted.
- Unknown top-level fields are rejected.
- Message size is not enforced by schema normalization.

Schema failures throw `SignedMessageValidationError` with a stable `code`, HTTP-friendly `status`, and message.

Signature recovery, allowlist authorization, deterministic message keys, and server-agnostic HTTP request handling are planned follow-on APIs in the package ExecPlan. HTTP ingress callers should enforce request body and message size limits before schema normalization.
