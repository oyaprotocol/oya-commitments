# @oyaprotocol/messages

Signed message validation, EIP-191 verification, and signer authorization primitives for Oya nodes.

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

- `text` must be a non-empty ASCII string and is preserved exactly; it is not trimmed or parsed.
- `signer` must be a 20-byte `0x`-prefixed Ethereum address and is preserved as submitted.
- `signature` must be a 65-byte `0x`-prefixed Ethereum signature string and is preserved as submitted.
- Unknown top-level fields are rejected.
- Message size is not enforced by schema validation.

Schema failures throw `SignedMessageValidationError` with a stable `code`, HTTP-friendly `status`, and message.

## Signature Verification

`verifySignedMessage(input)` first applies the schema validation above, then verifies that `signature` is an Ethereum EIP-191 signed-message signature over exactly `text`.

- The EIP-191 prefix uses the byte length of the validated ASCII `text`.
- Recovery values `27`/`28` and `0`/`1` are accepted.
- The recovered Ethereum address is compared to `signer` case-insensitively.
- The validated, frozen message is returned unchanged when verification succeeds.
- A well-shaped signature that cannot recover `signer` throws `SignedMessageVerificationError` with code `invalid_signature` and status `401`.

Verification uses `@noble/curves` 2.2.0 for secp256k1 public-key recovery and `@noble/hashes` 2.2.0 for Keccak-256. When used under Node.js, these ESM dependencies require Node.js 20.19.0 or newer. Noble also supports other modern JavaScript runtimes, although this package is currently tested under Node.js.

## Allowlist Authorization

`createSignedMessageAuthorizer(allowedSigners)` validates and snapshots an explicit array of Ethereum addresses once, then returns a frozen authorization function that can be reused for every request:

    const authorizeSignedMessage = createSignedMessageAuthorizer(allowedSigners);
    const message = authorizeSignedMessage(input);

The returned function validates and verifies the signed message before checking its recovered signer against the authorizer's private normalized Set. This composed API prevents callers from authorizing an unverified signer or changing policy by mutating the original array after authorizer creation.

- Address comparison is case-insensitive.
- Case-variant duplicate addresses count as one allowed signer.
- The validated, frozen message is returned unchanged when authorized.
- An empty allowlist denies every signer.
- A non-member throws `SignedMessageAuthorizationError` with code `unauthorized_signer` and status `403`.
- Message validation and signature-verification errors are preserved.
- Malformed allowlist entries or containers throw `TypeError` when the authorizer is created, before request processing begins.

Deterministic message keys and server-agnostic HTTP request handling remain planned follow-on APIs in the package ExecPlan. HTTP ingress callers should enforce request body and message size limits before schema validation.

Because v1 signs only `text` and includes no timestamp, nonce, audience, or domain, a valid signature can be replayed anywhere the signer is authorized. Nodes must apply their own authorization and durable deduplication policy.
