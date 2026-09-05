# @oyaprotocol/messages

Signed message validation, EIP-191 verification, signer authorization, HTTP-shaped ingress, and IPFS publication for Oya nodes.

## Public Entrypoint

- `@oyaprotocol/messages`

## Runtime Requirements

The package is ESM compiled for an ECMAScript 2025-compatible environment. Its public APIs require these standard JavaScript and Web Platform primitives:

- ESM package exports and explicit `.js` module specifiers
- `Uint8Array`
- `BigInt`
- `TextEncoder` and `TextDecoder`, including fatal UTF-8 decoding
- `Object.hasOwn(...)` and `Object.freeze(...)`
- `Reflect.ownKeys(...)`
- `Set`
- `JSON.parse(...)` and `JSON.stringify(...)`

The IPFS publication handler additionally uses the Web Platform APIs required by `@oyaprotocol/ipfs`, including `Blob`, `FormData`, `AbortController`, `AbortSignal`, and timers. The host supplies a fetch-compatible implementation explicitly.

The package does not import `node:*` modules or use Node-only globals such as `process` or `Buffer`. It does not declare a Node.js engine requirement. The pinned Noble dependencies publish their own runtime metadata. Current repository validation runs under Node.js; support for other ECMAScript 2025 runtimes should be established with runtime-specific smoke tests.

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

Verification uses `@noble/curves` 2.2.0 for secp256k1 public-key recovery and `@noble/hashes` 2.2.0 for Keccak-256.

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

`handleSignedMessage(request, options)` accepts raw request bytes and returns a Promise of frozen HTTP-shaped values without owning a server, router, socket, or process lifecycle. A node can mount it behind an endpoint such as `POST /v1/messages` and optionally configure one function to handle each authenticated message:

    import {
      createSignedMessageAuthorizer,
      handleSignedMessage,
    } from '@oyaprotocol/messages';

    const authorize = createSignedMessageAuthorizer(allowedSigners);
    const result = await handleSignedMessage(
      {
        method,
        contentType,
        body,
      },
      {
        authorize,
        maxBodyBytes,
        maxTextBytes,
        async onAcceptedMessage(message) {
          return await configuredAction(message);
        },
      }
    );

    if (result.status === 202) {
      const actionResult = result.handleSignedMessageResult;
      if (actionResult !== undefined) {
        inspectConfiguredActionResult(actionResult);
      }
    }

The request must be a plain object with exactly these own properties:

- `method`: a string; only the exact value `POST` is accepted.
- `contentType`: a string, or `undefined` when the header is absent; the own property is always required. The accepted media type is `application/json` with an optional unquoted `charset=utf-8` parameter.
- `body`: a `Uint8Array` containing the raw request bytes.

The options must be a plain object with required own `authorize`, `maxBodyBytes`, and `maxTextBytes` properties and an optional own `onAcceptedMessage` property. The two limits are required positive integers with no package defaults. An own `onAcceptedMessage`, when present, must be a function; inherited values with that name are ignored. Malformed request or option containers reject the returned Promise with `TypeError` because they indicate adapter or configuration bugs.

The handler processes a well-typed request in this order: method, content type, raw body size, fatal UTF-8 decoding and JSON parsing, encoded text size when a string `text` field exists, then signed-message authorization. This order prevents oversized bodies from reaching JSON parsing and oversized text from reaching signature verification.

Expected request failures return structured bodies with stable HTTP statuses and codes:

- `405 method_not_allowed`
- `415 unsupported_content_type`
- `413 body_too_large` or `text_too_large`
- `400 invalid_json` or a `SignedMessageValidationError` code
- `401 invalid_signature` from `SignedMessageVerificationError`
- `403 unauthorized_signer` from `SignedMessageAuthorizationError`

Unexpected authorizer exceptions reject the returned Promise unchanged so infrastructure and programming failures remain visible.

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

Status `202` means the message passed package authentication and authorization. Any configured accepted-message function has also resolved successfully; guarantees about completed side effects depend on that function. An HTTP adapter sends only `result.status` and `result.body` to the remote caller; the node consumes `result.message` internally.

### Optional Accepted-Message Handling

The host may provide `onAcceptedMessage` to act on the authenticated message before `handleSignedMessage(...)` resolves. The package invokes it exactly once for each accepted call, after authorization, with the frozen `result.message` snapshot. Rejected requests bypass it. The function may return synchronously or asynchronously; the package awaits it and adds its exact settled value as the `handleSignedMessageResult` property on the accepted result. The property is present even when the function returns `undefined`, and absent when no function is configured. The package preserves arbitrary host-owned result values by reference rather than cloning or freezing them.

A synchronous throw or rejected Promise from `onAcceptedMessage` rejects `handleSignedMessage(...)` unchanged. The package does not convert a failed action into a status-`202` result. Retrying the same valid request invokes the configured function again, so side-effecting functions remain responsible for any deduplication or idempotency they require.

The public TypeScript API uses one `HandleSignedMessageOptions<TResult>` interface whose `onAcceptedMessage` property is optional, and one accepted-result interface with an optional `handleSignedMessageResult` property. After narrowing `status === 202`, the host may read the property directly as `Awaited<TResult> | undefined`, with `TResult` inferred from the handler. Check `'handleSignedMessageResult' in result` when distinguishing an omitted handler from one that returned `undefined`. With `exactOptionalPropertyTypes` enabled, this presence check also narrows the property's type to `Awaited<TResult>`.

The accepted-message function is a host integration point. The package provides the IPFS publisher below; the host selects and configures a handler. Onchain Logger integration remains separate.

## IPFS Publication Handler

`publishSignedMessage(message, options)` verifies the message's schema and EIP-191 signature, snapshots its three fields, and publishes and pins the resulting JSON through `@oyaprotocol/ipfs`. It is implemented in `src/handlers/publish.ts` and exported through the package root. Direct callers receive the same verification as callback users; allowlist authorization remains the responsibility of ingress or the host.

Publication inherits the [fixed IPFS import settings and strict CID format](../ipfs/README.md#canonical-cids-and-file-imports): CIDv1, lowercase unpadded Base32, and SHA-256. The returned `cid` can be passed directly to IPFS reads, `encodeLoggerCall`, and `hashLoggerCid` from `@oyaprotocol/ethereum`. The same serialized envelope bytes produce the same CID through a conforming provider; changing the text, signer spelling, or signature changes the serialized artifact.

`PublishSignedMessageOptions` requires `config` and `fetch` from `PublishToIpfsOptions` and accepts its optional `signal`. The host provides an explicit IPFS URL, headers, timeout, retry count, and retry delay through `createIpfsConfig(...)`. Cancellation and retry behavior are delegated to the IPFS primitive.

The uploaded artifact is compact JSON with fields in the fixed order `text`, `signer`, `signature`, no additional fields, and no trailing newline. JSON escaping preserves the original field values, including text whitespace, address/signature casing, and signature recovery encoding. The filename is always `message.json` and its media type is `application/json`. The same exact field values produce the same file bytes regardless of input property order. Different signature bytes or signer casing can produce different artifacts even for identical text.

The Promise resolves to the existing `PublishToIpfsResult`, including `cid`, `uri`, `pinned: true`, filename, media type, content byte length, attempt count, and provider metadata. Schema and signature errors reject before any upload. IPFS failures propagate unchanged from `publishToIpfs(...)`.

The host can call the publisher directly with an authorized message:

    const publication = await publishSignedMessage(message, {
      config: ipfsConfig,
      fetch,
    });

For ingress, close over the host's dependencies in a one-argument callback:

    import {
      createSignedMessageAuthorizer,
      handleSignedMessage,
      publishSignedMessage,
    } from '@oyaprotocol/messages';
    import { createIpfsConfig } from '@oyaprotocol/ipfs';

    const ipfsConfig = createIpfsConfig({
      url: ipfsUrl,
      headers: ipfsHeaders,
      timeoutMs,
      maxRetries,
      retryDelayMs,
    });

    const result = await handleSignedMessage(request, {
      authorize: createSignedMessageAuthorizer(allowedSigners),
      maxBodyBytes,
      maxTextBytes,
      onAcceptedMessage: (message) =>
        publishSignedMessage(message, { config: ipfsConfig, fetch }),
    });

    if (result.status === 202 && result.handleSignedMessageResult !== undefined) {
      const { cid, uri, pinned } = result.handleSignedMessageResult;
      recordPublication({ cid, uri, pinned });
    }

The callback wrapper satisfies `AcceptedSignedMessageHandler<PublishToIpfsResult>` and TypeScript infers the publication result in the example above. The host chooses its handler at startup; if selection uses a configured name, validate that name before accepting requests. Omitting `onAcceptedMessage` keeps authentication-only behavior.

When this publisher is configured, ingress waits for publication to succeed before returning an accepted result. Publication metadata is internal to `handleSignedMessageResult`; the HTTP response body remains the small authentication result. Rejected requests do not upload. Each accepted submission invokes publication again, and the publisher adds no deduplication or retry loop beyond the configured IPFS retries.

## Internet-Facing Limits

An Internet-facing server must cap request bytes while reading the request stream before it constructs the handler's `Uint8Array`. It then supplies explicit `maxBodyBytes` and `maxTextBytes` values to the handler. The stream limit bounds buffering, the handler body limit bounds decoding and JSON parsing, and the text limit bounds validation and cryptographic work.

## Publication Ordering

A v1 EIP-191 signature authenticates the signer and exact `text`; it does not assign a publication time or order. Repeated valid submissions remain acceptable at this ingress boundary. The downstream publication flow will establish the public record by logging the published IPFS CID through the onchain Logger, whose block and log position identify when and in what order the message was recorded.
