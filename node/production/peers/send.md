# Send to one chosen node

Use a runtime image or source checkout containing `src/peers/client.mjs`. The receiver must authorize your signing address on both its inbox and worker through explicit grants or [registry reception](receive.md). This sends an ordinary publication request: content can become public and the receiver's worker can spend gas to log it. An address-book entry is routing information, not evidence of service ownership or authorization.

## One command from a checkout

With Node.js 24 and the locked `node/production` dependencies installed, run from the repository root:

```sh
node node/production/src/peers/client.mjs send REGISTRY_FILE NODE_ADDRESS KEY_FILE TEXT_FILE OUTPUT_FILE
```

Replace all five positional placeholders:

- `REGISTRY_FILE`: your installed, reviewed registry snapshot, an array of `{nodeAddress,url,target}` records. No registry is fetched automatically.
- `NODE_ADDRESS`: the explicit public Ethereum address of the chosen node. Missing or duplicate matches fail, even when duplicates have identical routing.
- `KEY_FILE`: your authorized sender's hex private key, in an owner-only file. It is used locally, not transmitted. No worker credential is needed.
- `TEXT_FILE`: nonempty ASCII text, at most 8,192 bytes and without NUL. Whitespace, including trailing newlines, is preserved exactly. A receiver may have a lower admission limit.
- `OUTPUT_FILE`: a **new** file in a private directory outside the checkout. The helper saves the original job and pinned destination exclusively with mode 0600 and synchronizes the file and parent directory before HTTP. Existing files are never overwritten.

The selected URL must end exactly in `/v1/jobs`, with HTTPS off-host, no credentials, query or fragment. Only loopback permits HTTP. The helper derives the origin and uses the registry target without changing runtime configuration. Keep the reviewed registry separate from downloads awaiting review.

The signed job retains the ordinary 24-hour default deadline and the same independently signed inner message as every other sender. Reads are bounded: registry 1 MiB/1,000 entries, key 256 bytes, text 8,192 bytes, saved request 64 KiB. Network requests have the existing ten-second deadline and 128 KiB response limit, and reject redirects.

## Status and explicit retry

```sh
node node/production/src/peers/client.mjs status OUTPUT_FILE
node node/production/src/peers/client.mjs retry OUTPUT_FILE
```

Both commands use only the saved file. They do not reopen a key, reread the registry, regenerate request IDs or extend expiry. Changes to the installed registry cannot redirect a retry. `status` can query expired jobs while retained and currently authorized. `retry` refuses expired jobs locally. There is no polling, automatic retry or replacement request.

Keep the saved file after any failure. `delivery_unknown` means admission may already have occurred; first query status, then decide explicitly whether to retry the **same** file. A missing status or HTTP rejection does not prove that earlier work was never published. Do not create a fresh request to resolve uncertainty. If local saving or synchronization fails, nothing is sent, but a partial or complete output may remain; inspect and preserve it instead of blindly overwriting it.

Protect the file and its parent directory. Destination metadata is **not signed routing**. Local edits can change its meaning. The v1 signature binds target, request ID, deadline and message, not a unique receiver/network. Multiple authorized receivers sharing a target can accept the same job; cross-node deduplication is not promised.

### Structured results

The CLI prints one sanitized JSON object, without message text, signatures, private keys, raw exceptions or response bodies. Successful requests include `operation`, `saved`, `requestId`, `expiresAt` (Unix milliseconds), `nodeAddress`, `target`, `outcome`, `admission` and `execution`.

| Result | Meaning |
| --- | --- |
| `outcome: admitted`, `execution: queued` or `processing` | Receiver reported admission, not completed publication. |
| `outcome: status` | Status lookup returned a recognized state for the saved request. |
| `execution: published` or `logged` | Receiver reports completion. This is not independently verified storage availability or a Ledger proof. |
| `execution: failed` or `expired` | Receiver reports terminal failure/expiry. |
| `outcome: delivery_unknown` / `status_unknown` | No usable response, including timeout, disconnect, redirect or malformed response. Admission/execution are unknown. |
| `outcome: http_error`, `httpStatus` | Server returned an HTTP error. Admission/execution remain unknown; no response details are exposed. |
| `outcome: local_error`, `code` | Invalid arguments/input/saved file, expired retry or persistence failure. No HTTP request was made. |

Exit 0 means recognized admission/status except failed/expired execution. Exit 1 means remote error, unknown outcome or failed/expired execution. Exit 2 means a local error. Admission is not proof of logs or storage. Use the [existing Ledger evidence tools](../inbox-api.md#verify-ledger-evidence) and content retrieval for independent verification.

## Extracted release bundle and image

Release bundles include this guide; executable modules and dependencies ship in the matching image. Use the reviewed digest from `image.txt`, and a private directory containing the reviewed registry, sender key and text. Set `OYA_NODE_IMAGE` to that digest and `PEER_PRIVATE_DIR` to the directory's absolute path. This command signs locally within the container and sends once:

```sh
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" --mount "type=bind,src=$PEER_PRIVATE_DIR,dst=/peer" \
  --entrypoint node "$OYA_NODE_IMAGE" /app/src/peers/client.mjs \
  send /peer/registry.json NODE_ADDRESS /peer/key.txt /peer/text.txt /peer/saved.json
```

Choose a fresh saved filename for each deliberately new request. The directory is writable so persistence can precede sending. Use only the intended input directory, not an installation directory containing unrelated credentials. Image loopback refers to the container, not the host. No real peer or onchain send is needed for local tests.

For subsequent operations, mount only the saved file read-only; the signing key is unnecessary:

```sh
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PEER_PRIVATE_DIR/saved.json,dst=/peer/saved.json,readonly" \
  --entrypoint node "$OYA_NODE_IMAGE" /app/src/peers/client.mjs status /peer/saved.json
```

Change `status` to `retry` only after deciding to resubmit the same request. Older images lack this entrypoint. Upgrading a bundle containing this guide requires an updated reviewed upgrader that allows `peers/send.md`.

## Reuse from automation

From a source application with the production dependencies, import functions directly rather than scraping CLI output:

```js
import { sendToPeer, peerJobStatus, retryPeerJob, PeerSendError } from './node/production/src/peers/send.mjs';

const result = await sendToPeer({ registryFile, nodeAddress, keyFile, textFile, outputFile });
// Later, after reviewing an uncertain result:
const status = await peerJobStatus(outputFile);
// An explicit operator/automation decision can call retryPeerJob(outputFile).
```

Local failures throw `PeerSendError` with a fixed safe `code` (`invalid_input`, `invalid_saved_job`, `job_expired`, `save_failed`). Remote outcomes return the structured result above. The optional second argument `{transport}` accepts a Fetch-compatible function for testing. Production calls use the existing bounded inbox transport. The helper supplies no scheduler, fanout or retry policy; callers decide when to initiate a new request and must retain its saved file.
