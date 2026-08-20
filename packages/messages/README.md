# @oyaprotocol/messages

Signed message validation, EIP-191 verification, signer authorization, and HTTP-shaped ingress primitives for Oya nodes.

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

- `text` must be a non-empty ASCII string and is preserved exactly as submitted.
- `signer` must be a 20-byte `0x`-prefixed Ethereum address and is preserved as submitted.
- `signature` must be a 65-byte `0x`-prefixed Ethereum signature string and is preserved as submitted.
- Unknown top-level fields are rejected.

Schema failures throw `SignedMessageValidationError` with a stable `code`, HTTP-friendly `status`, and message.

## Signature Verification

`verifySignedMessage(input)` first applies the schema validation above, then verifies that `signature` is an Ethereum EIP-191 signed-message signature over exactly `text`.

- The EIP-191 prefix uses the byte length of the validated ASCII `text`.
- Recovery values `27`/`28` and `0`/`1` are accepted.
- The recovered Ethereum address is compared to `signer` case-insensitively.
- The validated, frozen message is returned unchanged when verification succeeds.
- A well-shaped signature that cannot recover `signer` throws `SignedMessageVerificationError` with code `invalid_signature` and status `401`.

Verification uses `@noble/curves` 2.2.0 for secp256k1 public-key recovery and `@noble/hashes` 2.2.0 for Keccak-256. The kernel packages target ECMAScript 2025; when used under Node.js, this package requires Node.js 22 or newer. Noble also supports other modern JavaScript runtimes, although this package is currently tested under Node.js.

## Allowlist Authorization

`createSignedMessageAuthorizer(allowedSigners)` validates and snapshots an explicit array of Ethereum addresses once, then returns a frozen authorization function that can be reused for every request:

    const authorizeSignedMessage = createSignedMessageAuthorizer(allowedSigners);
    const message = authorizeSignedMessage(input);

The returned function validates and verifies the signed message before checking its recovered signer against the authorizer's private normalized Set. This composed API guarantees that authorization follows verification and that authorizer creation snapshots the supplied policy.

- Address comparison is case-insensitive.
- Case-variant duplicate addresses count as one allowed signer.
- The validated, frozen message is returned unchanged when authorized.
- An empty allowlist denies every signer.
- A non-member throws `SignedMessageAuthorizationError` with code `unauthorized_signer` and status `403`.
- Message validation and signature-verification errors are preserved.
- Malformed allowlist entries or containers throw `TypeError` when the authorizer is created, before request processing begins.

## HTTP-Shaped Ingress

`handleSignedMessage(request, options)` accepts raw request bytes and returns frozen HTTP-shaped values without owning a server, router, socket, or process lifecycle. A node can mount it behind an endpoint such as `POST /v1/messages`:

    import {
      createSignedMessageAuthorizer,
      handleSignedMessage,
    } from '@oyaprotocol/messages';

    const authorize = createSignedMessageAuthorizer(allowedSigners);
    const result = handleSignedMessage(
      {
        method,
        contentType,
        body,
      },
      {
        authorize,
        maxBodyBytes,
        maxTextBytes,
      }
    );

    if (result.status === 202) {
      await processAuthenticatedMessage(result.message);
    }

The request must be a plain object with exactly these own properties:

- `method`: a string; only the exact value `POST` is accepted.
- `contentType`: a string, or `undefined` when the header is absent; the own property is always required. The accepted media type is `application/json` with an optional unquoted `charset=utf-8` parameter.
- `body`: a `Uint8Array` containing the raw request bytes.

The options must be a plain object with exactly `authorize`, `maxBodyBytes`, and `maxTextBytes`. The two limits are required positive integers with no package defaults. Malformed request or option containers throw `TypeError` because they indicate adapter or configuration bugs.

The handler processes a well-typed request in this order: method, content type, raw body size, fatal UTF-8 decoding and JSON parsing, encoded text size when a string `text` field exists, then signed-message authorization. This order prevents oversized bodies from reaching JSON parsing and oversized text from reaching signature verification.

Expected request failures return structured bodies with stable HTTP statuses and codes:

- `405 method_not_allowed`
- `415 unsupported_content_type`
- `413 body_too_large` or `text_too_large`
- `400 invalid_json` or a `SignedMessageValidationError` code
- `401 invalid_signature` from `SignedMessageVerificationError`
- `403 unauthorized_signer` from `SignedMessageAuthorizationError`

Unexpected authorizer exceptions propagate so infrastructure and programming failures remain visible.

An accepted result has status `202`, a small response `body`, and a separate trusted `message` handoff:

    {
      "status": 202,
      "body": {
        "status": "accepted",
        "signer": "0x1111111111111111111111111111111111111111"
      },
      "message": {
        "text": "Please withdraw 100 USDC.",
        "signer": "0x1111111111111111111111111111111111111111",
        "signature": "0x..."
      }
    }

Status `202` means the message passed package authentication and authorization. It does not mean a node has completed an IPFS publication, onchain transaction, or other implementation-specific side effect. An HTTP adapter sends only `result.status` and `result.body` to the remote caller; the node consumes `result.message` internally.

## Internet-Facing Limits

An Internet-facing server must cap request bytes while reading the request stream before it constructs the handler's `Uint8Array`. It then supplies explicit `maxBodyBytes` and `maxTextBytes` values to the handler. The stream limit bounds buffering, the handler body limit bounds decoding and JSON parsing, and the text limit bounds validation and cryptographic work.

## Replay Safety

A v1 EIP-191 signature authenticates the signer and exact `text`; it does not establish freshness. The same valid signature remains valid across repeated submissions and anywhere the signer is authorized. Before performing a non-idempotent side effect, a node consumer must apply a durable replay/idempotency policy or make the operation itself idempotent.
