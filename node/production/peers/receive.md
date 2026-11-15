# Peer publication reception

This opt-in feature accepts ordinary signed publication requests from an operator-installed [trusted registry](README.md). It atomically stores a **peer receipt and ordinary inbox job**. The existing worker publishes the original `{ text, signer, signature }` to IPFS and logs its CID in Ledger mode, using its normal checkpoints and retry policy. A receipt acknowledges admission, not completed publication or a confirmed Ledger log.

## Enable on an inbox

Use an image and matching deployment bundle containing this feature. For an upgrade, use the reviewed upgrader containing the peer guide and overlay allowlist entries; older helpers reject these new bundle files. Keep your existing target, publication settings and worker credentials. Add this optional object to private `inbox.json` (replace the public address):

```json
"peers": {
  "networkId": "oya-testnet",
  "nodeAddress": "0x1111111111111111111111111111111111111111",
  "registryFile": "peer-registry.json",
  "maxMessages": 1000,
  "retentionMs": 604800000
}
```

`networkId` is the agreed case-sensitive peer-message domain, not an Ethereum chain ID. `nodeAddress` is the receiver's public identity and must match `execution.nodeAddress` in Ledger mode. IPFS-mode inboxes set it explicitly. **No private node key goes on the inbox.** All senders must use the same network ID, receiver address and exact inbox target.

Install an operator-reviewed registry snapshot as `peer-registry.json` next to the private inbox settings. The [list/fetch helper](README.md) produces the plain `{nodeAddress,url,target}` array. Enabling `peers` adds every listed address except self to effective `allowedSigners`, including the ordinary `/v1/jobs` route. Explicit local grants remain unchanged. This is a publication/spending grant in Ledger mode: review the snapshot before enabling it. The official list may be empty; do not enroll sample identities. Reads are capped at 1 MiB and 1,000 entries.

Add the same `peers` object and registry snapshot to the **worker's private `worker.json` directory**, not `node.json`. `registryFile` resolves relative to `worker.json`. The worker independently unions registry members with `node.json`'s explicit `allowedSigners` and verifies ordinary job signatures. In Ledger mode its configured peer address must match its local signer. For a containerized worker, mount the registry read-only at the configured path using a private Compose override with `bind.create_host_path: false`, as for the inbox overlay. A missing or invalid registry fails startup. Without matching worker authorization, jobs are rejected by the worker rather than bypassing its policy. Keep the receiver's network, target and identity consistent across both roles.

For Compose, add `node/production/inbox/compose.peers.yaml` to your existing inbox Compose file list, alongside the base and any PostgreSQL/HTTPS overlays. It mounts `${OYA_INBOX_DIR}/peer-registry.json` read-only at `/config/peer-registry.json`; a missing file fails rather than creating a directory. Keep `OYA_INBOX_DIR`, image digest, project name and selected files in your existing private operation record. Validate with `docker compose config --quiet`, then recreate the inbox in your normal maintenance window. Recreate the HTTPS proxy too when installing the new route allowlist. Host processes resolve `registryFile` relative to the inbox config file.

Startup loads one immutable snapshot, never fetches a list or sends messages. Replacing the file does not affect a running process. To revoke a peer, replace the snapshot and deliberately restart **all inbox and worker replicas**. Peer reception/status require current membership even if an explicit publication grant remains. Ordinary jobs retain any explicit grants. Coordinate replicas and preserve pending transaction checkpoints: removing authorization does not cancel a transaction already broadcast, and normal reconciliation may require an operator-reviewed explicit grant. Removing `peers` disables peer routes and registry-derived grants, not already queued work or explicit grants. Preserve the database. Older runtimes require removing the unknown `peers` settings before startup.

## Prepare once, submit explicitly

With Node 24 and installed production dependencies, from the repository root:

```sh
node node/production/src/peers/cli.mjs prepare NETWORK RECEIVER TARGET TEXT_FILE KEY_FILE EXPIRY_MS ENVELOPE_FILE
node node/production/src/peers/cli.mjs submit https://receiver.example ENVELOPE_FILE
node node/production/src/peers/cli.mjs status https://receiver.example ENVELOPE_FILE
```

Arguments are positional. Replace all uppercase placeholders. `KEY_FILE` contains only the sender's hex private key (with `0x`), protected by owner-only permissions. Keep it on the sender device. `EXPIRY_MS` is a future integer Unix timestamp in milliseconds, at most seven days ahead. Text must match the ordinary message package: nonempty ASCII, at most 8,192 bytes (or the receiver's lower `maxTextBytes`), with NUL rejected by the inbox. Whitespace is preserved exactly; Unicode/BOM input is rejected rather than rewritten. `prepare` signs the message, ordinary job and routing envelope offline, then exclusively creates a synchronized mode-0600 file. Use a private output directory. If preparation fails, inspect/remove any partial output; never submit an incomplete file.

For an extracted bundle, use the matching **digest-pinned** image from `image.txt`; the CLI lives in the image and needs no host npm installation. Set `OYA_NODE_IMAGE` to that reviewed digest and `PEER_PRIVATE_DIR` to a private directory containing text and key files. Example preparation (substitute network, address, target and expiry):

```sh
docker run --rm --network none --read-only --cap-drop ALL   --security-opt no-new-privileges --user "$(id -u):$(id -g)"   --mount "type=bind,src=$PEER_PRIVATE_DIR,dst=/peer"   --entrypoint node "$OYA_NODE_IMAGE" /app/src/peers/cli.mjs   prepare NETWORK RECEIVER TARGET /peer/text.txt /peer/key.txt EXPIRY_MS /peer/envelope.json
```

For online commands mount **only the envelope**, not the key or worker secrets:

```sh
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges   --user "$(id -u):$(id -g)"   --mount "type=bind,src=$PEER_PRIVATE_DIR/envelope.json,dst=/peer/envelope.json,readonly"   --entrypoint node "$OYA_NODE_IMAGE" /app/src/peers/cli.mjs   submit https://receiver.example /peer/envelope.json
```

Change `submit` to `status` to recover an acknowledgement. Production destinations require an explicit HTTPS origin without path, query, fragment or credentials. Loopback HTTP is allowed for local tests. Registry `url` values retain their existing `/v1/jobs` routing convention; this command does not derive credentials or auto-select destinations from them. It sends to the origin's exact `/v1/peers/receive` or `/v1/peers/status` path, never follows redirects, sends no Authorization header, and has a ten-second whole-response deadline and 16 KiB response bound. It validates receipt identity before printing JSON. Failures exit nonzero with a sanitized message.

## Receipts, retry and retention

The version-2 transport signature binds operation/domain, network, receiver, target, UUID, expiry, the entire independently signed message, ordinary job signature and sender. All three signatures must agree on the sender. The ordinary job signature lets the existing worker validate the queued job without trusting the inbox or learning a peer transport format. HTTP receive returns 202 and status returns 200, both with `status: received`, `scope: inbox`, routing identities, canonical envelope `digest`, `acceptedAt`, and `retainedUntil`. The unsigned receipt is not evidence of worker completion. To inspect publication status, extract `{ version: 1, target, requestId, expiresAt, message, requestSignature }` from the saved envelope and use the ordinary signed `/v1/status` API.

Version 1 was receipt-only and is not accepted by this corrected publication protocol. Existing version-1 rows are not promoted or rewritten: they lack publication consent and an independent message signature. Preserve any historical records and prepare a fresh version-2 request only with the sender's authorization. This is a pre-merge protocol change, not an automatic database migration.

Keep the saved envelope after any network error: acceptance may already have committed. Submit retries send the identical saved bytes and return the original receipt. A different signed envelope with the same target/UUID conflicts (409). After expiry, submit fails (400); signed status still works while retained and membership remains current. Lowering `maxTextBytes` restricts submissions but does not block status for retained envelopes within the 8,192-byte protocol ceiling. Unknown/revoked/self senders or bad signatures/bindings fail (403). Capacity fails (429). Missing, pruned or mismatched status fails (404); service/database failure returns 503. Disabled peer paths return 404. Existing global inbox rate, body and connection bounds also apply.

The inbox stores at most `maxMessages` per target (default 1,000, maximum 100,000). It retains each acceptance until the later of signed expiry and acceptance plus `retentionMs` (default seven days, maximum thirty days). Capacity counts receipts as well as text, so accepted deduplication records are never evicted early. A new receive prunes retention-expired records before checking capacity; the existing inbox `prune` command also reports `peers.deleted` when enabled. Status never extends retention. After retention or database loss, missing status means unknown history, not proof of non-reception. Back up PostgreSQL using your existing inbox procedure. Network/receiver identity is bound durably to the target: changing it requires a new target and deliberate migration, not reusing old receipts.

Peer and ordinary queue capacity both apply. Admission locks the peer target then the inbox target, writes both records in one PostgreSQL transaction and acknowledges only after commit. An ordinary job with the same UUID and exact signed payload is reused; a conflicting payload rejects admission. Peer pruning never deletes publication jobs or checkpoints. The normal worker owns publication, transaction signing, retries and completion. IPFS mode publishes only; Ledger mode also logs. There is no scheduler, automatic reply or forwarding loop. Do not delete live records to make room while claiming durable deduplication.
