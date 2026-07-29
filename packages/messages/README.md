# @oyaprotocol/messages

Signed message validation and EIP-191 verification primitives for Oya nodes.

## Public Entrypoint

- `@oyaprotocol/messages`

## Message Shape

The v1 signed text message body is:

    {
      "text": "Please withdraw 100 USDC.",
      "signer": "0x1111111111111111111111111111111111111111",
      "signature": "0x..."
    }

`validateSignedMessage(input)` validates that the body is a JSON-style object with exactly `text`, `signer`, and `signature`.

- `text` must be a non-empty string and is preserved exactly; it is not trimmed or parsed.
- `signer` must be a 20-byte `0x`-prefixed Ethereum address and is preserved as submitted.
- `signature` must be a 65-byte `0x`-prefixed Ethereum signature string and is preserved as submitted.
- Unknown top-level fields are rejected.
- Message size is not enforced by schema validation.

Schema failures throw `SignedMessageValidationError` with a stable `code`, HTTP-friendly `status`, and message.

## Signature Verification

`verifySignedMessage(input)` first applies the schema validation above, then verifies that `signature` is an Ethereum EIP-191 signed-message signature over exactly `text`.

- The EIP-191 prefix uses the UTF-8 byte length of `text`, not the JavaScript string length.
- Recovery values `27`/`28` and `0`/`1` are accepted.
- The recovered Ethereum address is compared to `signer` case-insensitively.
- The validated, frozen message is returned unchanged when verification succeeds.
- A well-shaped signature that cannot recover `signer` throws `SignedMessageVerificationError` with code `invalid_signature` and status `401`.

Verification uses `@noble/curves` 2.2.0 for secp256k1 public-key recovery and `@noble/hashes` 2.2.0 for Keccak-256. These ESM dependencies require Node.js 20.19.0 or newer, which is also declared by this package.

Allowlist authorization, deterministic message keys, and server-agnostic HTTP request handling remain planned follow-on APIs in the package ExecPlan. HTTP ingress callers should enforce request body and message size limits before schema validation.

Because v1 signs only `text` and includes no timestamp, nonce, audience, or domain, a valid signature can be replayed anywhere the signer is authorized. Nodes must apply their own authorization and durable deduplication policy.
