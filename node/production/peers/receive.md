# Registered nodes use ordinary publication jobs

An operator can authorize an installed [trusted registry](README.md) on both inbox and worker. Registered nodes then submit the same **version-1 signed jobs** as any other sender: `POST /v1/jobs` queues work and `POST /v1/status` reports execution. The worker publishes the original independently signed `{ text, signer, signature }` to IPFS and logs its CID in Ledger mode, using the existing checkpoints and retry policy. A `queued` response is not completed publication or a confirmed Ledger log.

## Enable registry authorization

Use an image and matching deployment bundle containing this feature. For upgrades, use the reviewed upgrader containing the registry guide and overlay allowlist entries; older helpers reject these new bundle files. Preserve your target, execution settings, explicit `allowedSigners` and worker credentials. Add this optional object to private `inbox.json` and private `worker.json` (not `node.json`):

```json
"peers": { "registryFile": "peer-registry.json" }
```

Install an operator-reviewed registry snapshot next to each configuration file. The [list/fetch helper](README.md) produces the plain `{nodeAddress,url,target}` array. `registryFile` resolves relative to its inbox or worker settings file. Enabling it adds **every listed address** to the effective allowlist while preserving explicit local grants. There is no special self exclusion or receiver/network binding. Keep a nonempty explicit `allowedSigners` list as required by ordinary startup. Registry reads are limited to 1 MiB and 1,000 entries. Missing, malformed or oversized files fail startup.

This is a publication and, in Ledger mode, **spending grant**. Review membership before enabling it on both roles. Downloading a directory alone does not enable authorization. The official list may be empty; do not enroll sample identities. **No private node key goes on the inbox.** The worker independently verifies the two ordinary signatures and authorization. Its existing execution identity, node signer, gas/fee limits and transaction checkpoints still govern logging.

For Compose, add `node/production/inbox/compose.peers.yaml` alongside the existing inbox base and selected PostgreSQL/HTTPS overlays. It mounts `${OYA_INBOX_DIR}/peer-registry.json` read-only at `/config/peer-registry.json`, refusing a missing file. Mount the worker's reviewed snapshot read-only at its configured path using a private Compose override with `bind.create_host_path: false`. Keep paths, image digest and Compose file selection in the existing private operation record. Validate `docker compose config --quiet`, then deliberately recreate both roles in a maintenance window. The ordinary HTTPS route allowlist needs no new routes.

Startup loads a fixed snapshot and never fetches or sends messages. To revoke a member, replace the snapshot and restart **all inbox and worker replicas**. Any explicit grant for that address still applies, including status access. Removing `peers` removes registry-derived grants only. It does not erase jobs or checkpoints or cancel broadcast transactions. Preserve PostgreSQL and reconcile pending work with the ordinary operator recovery procedure. Older runtimes require removing the unknown `peers` object before startup.

## Prepare once, submit explicitly

With Node 24 or newer and installed production dependencies, run from the repository root:

```sh
node node/production/src/inbox/client.mjs prepare KEY_FILE TARGET TEXT_FILE JOB_FILE
node node/production/src/inbox/client.mjs submit https://receiver.example JOB_FILE
node node/production/src/inbox/client.mjs status https://receiver.example JOB_FILE
```

Replace the positional placeholders. Choose the receiver and `TARGET` from the reviewed directory. Directory `url` values end in `/v1/jobs`; pass only the HTTPS origin to the CLI. It rejects origins with credentials, paths, queries or fragments and refuses redirects. Loopback HTTP is permitted for local tests. Discovery never auto-selects a recipient or initiates a send.

`KEY_FILE` holds the sender's hex private key, protected by owner-only permissions on the sender device. `prepare` works offline, independently signs the exact message and the ordinary job, then exclusively writes a synchronized mode-0600 output. It preserves whitespace and accepts nonempty ASCII up to 8,192 bytes, excluding NUL (or the receiver's lower admission limit). It defaults to a 24-hour expiry; the protocol permits at most seven days. Keep the job in a private directory. A failed preparation can leave partial output: inspect it rather than submitting or overwriting it blindly.

For an extracted bundle, use the reviewed digest-pinned image from `image.txt`. Set `OYA_NODE_IMAGE` to that digest and `PEER_PRIVATE_DIR` to the private directory holding the inputs:

```sh
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" --mount "type=bind,src=$PEER_PRIVATE_DIR,dst=/peer" \
  --entrypoint node "$OYA_NODE_IMAGE" /app/src/inbox/client.mjs \
  prepare /peer/key.txt TARGET /peer/text.txt /peer/job.json
```

Online commands mount only the saved job, not keys or worker secrets:

```sh
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" --mount "type=bind,src=$PEER_PRIVATE_DIR/job.json,dst=/peer/job.json,readonly" \
  --entrypoint node "$OYA_NODE_IMAGE" /app/src/inbox/client.mjs \
  submit https://receiver.example /peer/job.json
```

Change `submit` to `status` to inspect progress. These are ordinary inbox client commands, with the same ten-second request deadline and bounded response as other senders.

## Retry, status and compatibility

Keep the original saved job after any error: admission may have committed. Exact retries before expiry reuse the existing job and return its **current execution status**, not a separate receipt. Changed content under the same target/UUID conflicts (409). Expired submissions fail (400); signed status remains available while the job is retained and the sender is currently authorized. Status uses the protocol's 8,192-byte ceiling even if admission `maxTextBytes` is lowered. Invalid signatures, unauthorized senders and wrong targets fail (403). Ordinary `maxJobs`, rate/body/connection limits, pruning and backup rules apply. See the [inbox API](../inbox-api.md) for states, retention and recovery. Missing status is not proof of non-publication.

The pre-merge peer-specific envelopes, CLI, receipt tables and `/v1/peers/*` handlers have been removed. The `peers` object accepts only `registryFile`; remove `networkId`, `nodeAddress`, `maxMessages` and `retentionMs` from earlier candidate settings. Existing experimental receipt tables are left untouched but no longer read or written. Do not convert historical receipt-only requests into publication jobs. Reconcile any already queued ordinary work before preparing a newly authorized request, to avoid duplicate publication. Old peer envelopes are rejected rather than silently unwrapped.

A v1 job binds target, request ID, expiry and the independently signed message, not a unique receiver or network. Multiple authorized inboxes with the same target can accept it: select destinations deliberately and do not assume cross-node deduplication. This feature adds no scheduler, automatic reply, forwarding or instruction execution.
