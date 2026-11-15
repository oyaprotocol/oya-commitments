# Informational peer reception

This opt-in inbox feature accepts signed text from an operator-installed [trusted registry](README.md). It returns a durable **inbox receipt**, not a worker-processing result, IPFS publication, Ledger log, or signed receiver evidence. Received text is stored as data. Registry membership never adds publication `allowedSigners`. Receiver-local publication is a possible later feature.

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

Install an operator-reviewed registry snapshot as `peer-registry.json` next to the private inbox settings. The [list/fetch helper](README.md) produces the existing plain `{nodeAddress,url,target}` array. Loading and fetching do not enable reception. Once enabled, all valid listed public addresses except self can send informational messages. This does not authorize those addresses for `/v1/jobs`. The official list may be empty; do not enroll sample identities. The runtime reads at most 1 MiB and 1,000 entries. It validates required strings and public addresses, without registry revisions or enrollment proofs.

For Compose, add `node/production/inbox/compose.peers.yaml` to your existing inbox Compose file list, alongside the base and any PostgreSQL/HTTPS overlays. It mounts `${OYA_INBOX_DIR}/peer-registry.json` read-only at `/config/peer-registry.json`; a missing file fails rather than creating a directory. Keep `OYA_INBOX_DIR`, image digest, project name and selected files in your existing private operation record. Validate with `docker compose config --quiet`, then recreate the inbox in your normal maintenance window. Recreate the HTTPS proxy too when installing the new route allowlist. Host processes resolve `registryFile` relative to the inbox config file.

Startup loads one immutable snapshot, never fetches a list or sends messages. Replacing the file does not affect a running process. To revoke a peer, replace the installed snapshot and deliberately recreate every inbox replica; new reception **and status** then reject that sender, even if separately authorized for publication. Coordinate replicas so they do not retain different snapshots. No worker restart or publication-policy change is needed for peer membership alone. Remove `peers` and the overlay to disable peer reception. Preserve the database when disabling or rolling back. Older runtimes require removing the unknown `peers` setting before startup.

## Prepare once, submit explicitly

With Node 24 and installed production dependencies, from the repository root:

```sh
node node/production/src/peers/cli.mjs prepare NETWORK RECEIVER TARGET TEXT_FILE KEY_FILE EXPIRY_MS ENVELOPE_FILE
node node/production/src/peers/cli.mjs submit https://receiver.example ENVELOPE_FILE
node node/production/src/peers/cli.mjs status https://receiver.example ENVELOPE_FILE
```

Arguments are positional. Replace all uppercase placeholders. `KEY_FILE` contains only the sender's hex private key (with `0x`), protected by owner-only permissions. This is the listed node identity used for signing messages, **not** a worker token. Keep the key on the sender device. `EXPIRY_MS` is an integer Unix timestamp in milliseconds, in the future and at most seven days ahead. Text is exact UTF-8, at most 8,192 bytes (or the receiver's lower `maxTextBytes`); NUL and malformed Unicode are rejected. `prepare` is offline and exclusively creates a mode-0600 envelope file, synchronizes its bytes and directory, and never overwrites an existing file. Use a private output directory. If preparation fails, inspect/remove a partial output before preparing again; never submit an incomplete file.

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

The canonical signed envelope binds operation/version/domain, network, receiver, target, UUID, expiry, exact text and sender. HTTP receive returns 202 and status returns 200, both with `status: received`, `scope: inbox`, those routing identities, canonical envelope `digest`, `acceptedAt`, and `retainedUntil` (millisecond timestamps). Receipt JSON is an unsigned receiver claim delivered over TLS. It is not nonrepudiable evidence or proof of continuing availability.

Keep the saved envelope after any network error: acceptance may already have committed. Submit retries send the identical saved bytes and return the original receipt. A different signed envelope with the same target/UUID conflicts (409). After expiry, submit fails (400); signed status still works while retained and membership remains current. Lowering `maxTextBytes` restricts submissions but does not block status for retained envelopes within the 8,192-byte protocol ceiling. Unknown/revoked/self senders or bad signatures/bindings fail (403). Capacity fails (429). Missing, pruned or mismatched status fails (404); service/database failure returns 503. Disabled peer paths return 404. Existing global inbox rate, body and connection bounds also apply.

The inbox stores at most `maxMessages` per target (default 1,000, maximum 100,000). It retains each acceptance until the later of signed expiry and acceptance plus `retentionMs` (default seven days, maximum thirty days). Capacity counts receipts as well as text, so accepted deduplication records are never evicted early. A new receive prunes retention-expired records before checking capacity; the existing inbox `prune` command also reports `peers.deleted` when enabled. Status never extends retention. After retention or database loss, missing status means unknown history, not proof of non-reception. Back up PostgreSQL using your existing inbox procedure. Network/receiver identity is bound durably to the target: changing it requires a new target and deliberate migration, not reusing old receipts.

Peer tables are independent of worker publication jobs and checkpoints. This milestone has no scheduler, automatic replies, forwarding, worker processing or publication side effects. If enabled peers fill capacity, reduce sender traffic or wait for retention/prune; do not delete live records to make room while claiming durable deduplication.
