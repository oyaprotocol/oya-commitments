# Optional batch logging (direct runtime, source milestone)

The default remains one IPFS publication and one Ledger log per message. This opt-in feature is for `src/main.mjs` in Ledger mode only. The PostgreSQL inbox and local worker do **not** batch: worker entrypoints reject this setting. IPFS-only mode rejects it too. Published images and the older direct setup guide do not imply support for this source milestone.

## Configure

Add this object to an otherwise valid direct-node JSON configuration:

```json
{
  "batchLogging": {
    "stateDirectory": "./private-batch-state",
    "maxMessages": 20,
    "maxWaitMs": 60000
  }
}
```

Start using the normal direct entrypoint, `node node/production/src/main.mjs CONFIG_JSON SECRETS_FILE`. Paths are relative to the process working directory; use a stable private persistent directory outside Git. The process creates a new directory with mode 0700 and files with mode 0600. Secure permissions on an existing directory yourself. Use a local filesystem supporting atomic rename and file/directory fsync, not a shared/network filesystem. Back up the entire directory consistently while stopped, along with Kubo storage. Only this process may use the dedicated node signer; the directory lock does not detect another process using the same signer with another directory.

`maxMessages` is an integer from 2 through 100. `maxWaitMs` is an integer from 1,000 through 86,400,000. All three fields are required; unknown fields fail startup. A message is limited to the smaller of `maxTextBytes` and 8,192 bytes in this mode. Oversized batch text returns 413 with `started: false`; it is not a retryable provider failure.

## Publication and status

The usual signature and explicit `allowedSigners` checks still precede IPFS publication. Peer-directory membership grants no authority. Every message gets its own ordinary signed-message IPFS envelope, unchanged from immediate mode. Only after that CID is durably saved does `POST /v1/messages` return HTTP **202**, for example:

```json
{
  "status": "pending",
  "signer": "0x...",
  "publication": {
    "status": "pending",
    "cid": "bafk...",
    "uri": "ipfs://bafk...",
    "batchId": "a UUID"
  }
}
```

202 means publication and local batch admission, **not** an onchain log. Clients must understand this asynchronous result; the existing `send-message.mjs` helper expects immediate 200 and is not a batch client. Use `GET /v1/batches` to observe `pending`, `recent`, `busy`, and `blocked`. Batch summaries include the batch ID, ordered `messageCids`, eventual `manifestCid` and `transactionHash`. Terminal status is `logged` after receipt/event verification or `failed` for a verified revert. Pending status is `pending_transaction` once signed transaction bytes are checkpointed. Status is public, like the underlying IPFS/chain content, but omits text, signatures and raw signed transactions. Restrict exposure with the same local/reverse-proxy access policy as the direct API.

Only one operation runs at once. Concurrent work or a full/sealed/blocked batch receives a sanitized 503; there is no unbounded request queue. A failed admission can return 502 after IPFS has accepted bytes or after an uncertain journal write. Inspect status and preserve the journal; do not infer that an error means no side effect. Exact message duplicates within the pending batch reuse its admission without another upload. After completion, a repeat is a new admission: this API does not promise global exactly-once delivery, replay expiry or infinite deduplication. Poll promptly and retain the receipt/manifest; only the most recent 100 terminal summaries remain locally.

## Flush policy and manifest

A timer checks at most once per second. A nonempty batch flushes when the count threshold is reached **or** elapsed wall-clock time since the last locally verified successful log reaches `maxWaitMs`. On first initialization the clock starts at journal creation. Idle time counts, so the first message after a long idle interval can flush at the next tick. The timestamp survives restart. Wall-clock corrections, sleep, active operations and provider failures can delay a flush; this is a scheduling target, not a delivery deadline. Empty batches never publish. A failed or interrupted sealed batch retries on later ticks without admitting new members. Each attempt is bounded by `operationTimeoutMs`; provider retry/receipt settings and gas/fee limits still apply.

Before publishing the manifest, the runtime durably freezes batch membership and rechecks the current explicit signer policy. The manifest is UTF-8 JSON with this shape:

```json
{
  "type": "oya-message-batch",
  "version": 1,
  "batchId": "a UUID",
  "execution": {
    "mode": "ledger",
    "chainId": 11155111,
    "ledgerContract": "0x...",
    "nodeAddress": "0x..."
  },
  "messages": [
    { "cid": "bafk...", "messageDigest": "64 lowercase hexadecimal characters" }
  ]
}
```

Addresses are lowercase; message order is admission order. `messageDigest` is SHA-256 of UTF-8 JSON of the signed-message object with keys recursively lexicographically sorted (`signature`, `signer`, `text`); string values are preserved exactly. The listed CID points to the independent signed envelope. The node uploads/pins the manifest and logs **its** CID, not each member CID. A manifest may contain one message when the timer fires. `batchId` distinguishes otherwise identical publications.

The existing evidence verifier can verify the logged manifest bytes, just as any logged content. It does not recursively validate member CIDs, message signatures, manifest context or semantic truth. Those are separate consumer checks. Logging is not independent proof of availability; arrange IPFS replication separately. The local journal is bounded to one pending batch plus 100 summaries; historical IPFS pins and chain history are not pruned by this feature.

## Recovery and stopping

The private journal and configured IPFS provider are trusted integrity boundaries: recovery validates signatures, digests, execution identity and transaction-to-CID binding, but does not independently recompute stored CIDs from message/manifest bytes or refetch content. A locally altered canonical manifest CID can therefore be signed if no transaction has yet been checkpointed. Do not edit or accept an untrusted journal; recover only from a trusted consistent backup.

The journal records each message CID, frozen membership, manifest CID and exact signed transaction bytes in order. Atomic replacement and fsync precede broadcasting. Recovery reuses the stored transaction/hash and existing inbox receipt-verification machinery; an ambiguous send, timeout or malformed receipt never causes a newly signed replacement. A journal write failure blocks further work until restart reloads disk. Provider failures retain membership and retry; health reports `503 / batch_blocked` while blocked and the direct status CLI reports failure.

A changed chain, contract or node account fails journal identity validation. Keep existing fee limits sufficient to validate a pending transaction. A revoked signer blocks a batch that has not yet checkpointed a transaction; restore authorization only after an explicit local decision. Once a transaction was durably signed, it may already have broadcast: recovery reconciles/rebroadcasts those exact bytes even if the message signer was subsequently removed. It does not authorize new messages from that signer or sign a replacement. A verified revert is terminal and visible; it is not automatically charged another transaction.

SIGINT/SIGTERM stops the timer, drains active operations and releases the directory lock. It leaves underfilled batches durable rather than forcing an extra transaction during shutdown. Restart with the same configuration to resume; to drain before disabling batching, stop admissions and leave the runtime running until `pending` is null. Save recent receipt summaries before switching modes or clearing old state.

A crash leaves `batch.lock`. Startup deliberately refuses to steal it. Confirm every process using this directory and signer is stopped, inspect the saved checkpoint and then remove **only** `batch.lock`. Restart with the same directory and identity. Never delete/reset `batch.json`, abandon a pending raw transaction, or switch signers to escape an unknown outcome. A crash between IPFS publication and its checkpoint can leave an orphan pin; retry can upload the same immutable bytes again. The journal contains signed messages and broadcast-capable raw transactions: protect it as private operational state.

## Validation

`node --test node/production/test/batch-logging.test.mjs` exercises real HTTP, signatures, disk persistence, transaction preparation and receipt validation against **synthetic mocked IPFS/RPC transports**. `npm --prefix node/production test` includes the existing immediate and inbox/worker regressions. These tests do not constitute funded-chain, Docker, deployment, replication or power-loss filesystem acceptance.
