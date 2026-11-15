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

Before publishing the manifest, the runtime durably freezes batch membership and rechecks the current explicit signer policy. The manifest is UTF-8 plain text: canonical CIDs in admission order, separated by a single LF (`\n`), with no trailing newline, header or JSON wrapper. For example (abbreviated CIDs):

```text
bafk...
bafk...
```

Canonical CIDs contain no line breaks, so the separator is unambiguous. The list is independent of the originating node or any logging chain or Ledger; batch IDs, execution identity and message digests stay in the private journal. Identical ordered CIDs produce identical manifest bytes across nodes and batches. Each CID points to the independent signed envelope; no prior Ledger log is required. The node uploads/pins the manifest before logging **its** CID, not each member CID. A manifest may contain one message when the timer fires.

The generic evidence verifier checks logged manifest bytes. Use [Review one batch member](#review-one-batch-member) to verify membership and the original signed message as well. The manifest itself makes no claim about a chain, contract or publishing node; those belong to the separately verified Ledger event. Logging is not independent proof of availability; arrange IPFS replication separately. The local journal is bounded to one pending batch plus 100 summaries; historical IPFS pins and chain history are not pruned by this feature.

## Review one batch member

From a source checkout with the production dependencies installed, run:

```sh
node node/production/src/verify-batch.mjs batch-record.json evidence-settings.json
```

The command reads only those two files, makes bounded read-only IPFS/RPC requests, and prints a JSON review. It loads no keys, environment credentials, worker configuration or journal. Library consumers import `verifyBatchEvidence(record, settings)` from `src/batch-evidence.mjs`. The generic `verify-ledger.mjs` interface retains its arbitrary-content behavior.

Create `batch-record.json` with full canonical CIDs from publication/batch status (replace the abbreviated placeholders):

```json
{
  "manifestCid": "REPLACE_WITH_MANIFEST_CID",
  "memberCid": "REPLACE_WITH_MESSAGE_CID"
}
```

Create private `evidence-settings.json` with an explicitly trusted Kubo API, for example:

```json
{
  "ipfsUrl": "http://127.0.0.1:5001",
  "timeoutMs": 30000,
  "requestTimeoutMs": 10000
}
```

Use HTTPS for non-loopback endpoints. Optional `ipfsAuthorization` is a complete Authorization header. Protect credential-bearing files outside Git. URLs embedded in content are never followed. Only the selected member is fetched; neighboring members need not be available. To require a known message author, add `"signer": "REPLACE_WITH_MESSAGE_SIGNER_ADDRESS"` to the record. Without it, the report recovers the signer but makes no claim that this signer was expected or authorized by a node.

For an additional Ledger snapshot check, add both objects below to their respective files:

```json
{
  "ledger": {
    "transactionHash": "REPLACE_WITH_TRANSACTION_HASH",
    "logIndex": 0,
    "nodeAddress": "REPLACE_WITH_IMMEDIATE_LEDGER_CALLER"
  }
}
```

```json
{
  "ledger": {
    "chainId": 11155111,
    "ledgerContract": "0xe6DeB4B3c31E15DBeA0f932830e2f20Ba2EddAa3",
    "rpcUrl": "https://REPLACE_WITH_APPROVED_RPC"
  }
}
```

Use the selected event's **block-global** `logIndex`, not its array position. `nodeAddress` is optional and means the immediate caller recorded in `Log.node`; it is neither the transaction signer nor the message author. Calls through forwarding contracts are supported. Optional `ledger.rpcAuthorization` is sent only to the configured RPC. The expected logged CID is always the manifest CID. Supplied Ledger settings/record must appear together and pass validation before any request.

### Interpret the review

The report distinguishes `checks.manifest` and `checks.member` (exact raw CID/byte integrity), `manifestFormat`, `membership`, `signature`, optional expected `signer`, and optional `ledger`. `memberIndexes` contains all matching zero-based positions in the ordered manifest. Repeated CIDs are preserved. After signature and any expected-signer check, `message` contains the original parsed `{text, signer, signature}` for review. Original downloaded bytes, not reserialized JSON, establish the CID. Treat message text as untrusted content; the report intentionally includes it on stdout. `semantics: not_assessed` means the signer's claims have not been judged true.

Exit codes are **0 verified**, **2 mismatch**, **3 unavailable**, **4 partial**. A receipt failure keeps already-established member/signature checks and supplies the nested `ledger` report. A verified result without Ledger inputs proves membership and signature only. Ledger verification is a configured-provider snapshot, not independent chain consensus, finality, publisher provenance or durable replication.

Both manifest and member require canonical lowercase Base32 CIDv1 with SHA-256 and the **raw** codec for complete verification. Non-raw codecs (including UnixFS/DAG-PB) return partial before fetching that object, and no signature-only integrity claim is made. There is no digest override for this adapter. The generic verifier's separate expected-content-digest option remains available for its different use case. The pinned signed-message kernel requires nonempty ASCII text and an EIP-191 signature; this command preserves that schema rather than inventing a new envelope.

The only supported manifest format is 1–100 LF-separated canonical CID lines (no header, whitespace or trailing LF). JSON manifests are rejected with `invalid_manifest`. Receipt expectations come only from the explicit record/settings.

Each input file is limited to 65,536 bytes. Each network body, including streamed bodies, is limited to 131,072 bytes. Overall timeout defaults to 30 seconds (maximum 120), with a per-request timeout of 10 seconds (maximum 30). There are no redirects, retries, recursive fetches, publication, pinning or chain writes. A successful content-only review makes two `cat` requests. With Ledger inputs it makes at most six reads total: two content reads plus chain ID, receipt, block and an independent manifest reread through the existing generic evidence verifier. Any failed check stops further work.

## Recovery and stopping

The private journal and configured IPFS provider are trusted integrity boundaries: recovery validates signatures, digests, execution identity and transaction-to-CID binding, but does not independently recompute stored CIDs from message/manifest bytes or refetch content. A locally altered canonical manifest CID can therefore be signed if no transaction has yet been checkpointed. Do not edit or accept an untrusted journal; recover only from a trusted consistent backup.

The journal records each message CID, frozen membership, manifest CID and exact signed transaction bytes in order. Atomic replacement and fsync precede broadcasting. Recovery reuses the stored transaction/hash and existing inbox receipt-verification machinery; an ambiguous send, timeout or malformed receipt never causes a newly signed replacement. A journal write failure blocks further work until restart reloads disk. Provider failures retain membership and retry; health reports `503 / batch_blocked` while blocked and the direct status CLI reports failure.

An already checkpointed manifest CID and any signed transaction are retained exactly on restart. Pending work without a manifest CID publishes the CID list, including a sealed batch whose upload was not checkpointed. A one-member manifest is just that CID, with no newline. The private journal retains its execution-identity checks.

A changed chain, contract or node account fails journal identity validation. Keep existing fee limits sufficient to validate a pending transaction. A revoked signer blocks a batch that has not yet checkpointed a transaction; restore authorization only after an explicit local decision. Once a transaction was durably signed, it may already have broadcast: recovery reconciles/rebroadcasts those exact bytes even if the message signer was subsequently removed. It does not authorize new messages from that signer or sign a replacement. A verified revert is terminal and visible; it is not automatically charged another transaction.

SIGINT/SIGTERM stops the timer, drains active operations and releases the directory lock. It leaves underfilled batches durable rather than forcing an extra transaction during shutdown. Restart with the same configuration to resume; to drain before disabling batching, stop admissions and leave the runtime running until `pending` is null. Save recent receipt summaries before switching modes or clearing old state.

A crash leaves `batch.lock`. Startup deliberately refuses to steal it. Confirm every process using this directory and signer is stopped, inspect the saved checkpoint and then remove **only** `batch.lock`. Restart with the same directory and identity. Never delete/reset `batch.json`, abandon a pending raw transaction, or switch signers to escape an unknown outcome. A crash between IPFS publication and its checkpoint can leave an orphan pin; retry can upload the same immutable bytes again. The journal contains signed messages and broadcast-capable raw transactions: protect it as private operational state.

## Validation

`node --test node/production/test/batch-logging.test.mjs node/production/test/batch-evidence.test.mjs` exercises real HTTP, signatures, disk persistence, transaction preparation and receipt validation against **controlled IPFS/RPC transports**. It includes publication through the direct runtime followed by retrieval of the actual uploaded bytes and guarded CLI review. `npm --prefix node/production test` includes the existing immediate and inbox/worker regressions. These tests do not constitute funded-chain, EVM, Docker, deployment, replication or power-loss filesystem acceptance.
