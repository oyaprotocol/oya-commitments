# Inbox API and recovery contract

For opt-in signed publication requests between registered nodes, see [peer reception](peers/receive.md). Enabling an installed registry grants all its members ordinary publication authority.

Version 1 uses JSON over HTTPS. It is implemented by `src/inbox/`, with PostgreSQL as the durable queue and execution journal. The supplied image has three entrypoints: `main.mjs` serves the inbox, `worker.mjs` polls and publishes locally, and `client.mjs` creates/submits/reads signed jobs. The synchronous `src/main.mjs` remains available separately.

## Agent endpoints

`POST /v1/jobs` accepts a signed envelope and returns HTTP 202 after database commit. This is acceptance, not IPFS or Ledger completion. `POST /v1/status` accepts the same envelope and returns its public status. Neither endpoint needs the worker token. They verify the inner message signature, outer request signature, and allowed signer. Status is available after expiry but still requires an authorized signer and the exact envelope; an ID alone is insufficient. Both use `Content-Type: application/json` and no redirects.

```json
{
  "version": 1,
  "target": "my-node",
  "requestId": "a4f282ce-7571-421e-9315-ce276a5f45fb",
  "expiresAt": 1790000000000,
  "message": {"text": "example", "signer": "0x...", "signature": "0x..."},
  "requestSignature": "0x..."
}
```

The timestamp above is illustrative; use a future Unix timestamp in milliseconds. Submission permits at most seven days into the future.

New client jobs default to exactly seven days (604800000 milliseconds). `prepare KEY_FILE TARGET TEXT_FILE JOB_FILE --expires-in SECONDS` selects 1–604800 integer seconds. The command prints the absolute signed `expiresAt` in Unix milliseconds. Existing signed jobs retain their original deadlines. Synchronize sender/inbox clocks: a sender clock ahead of the inbox can exceed the seven-day admission maximum. Choose a shorter lifetime when needed; never edit a signed deadline.

IDs are lowercase UUIDv4. `message.signature` is an Ethereum personal-message signature of the exact text. The outer signature uses the same signer and signs this UTF-8 string, with no trailing newline:

```js
'Oya inbox job v1\n' + JSON.stringify([
  target, requestId, expiresAt,
  message.text, message.signer.toLowerCase(), message.signature
])
```

Message text must be nonempty ASCII without NUL (`U+0000`) and at most 8,192 bytes under the default inbox limit. Status uses the 8,192-byte protocol ceiling even after admission `maxTextBytes` is lowered, with the same signature, current authorization and stored-envelope checks. PostgreSQL cannot store NUL in the inbox's `jsonb` payload; the API rejects it as `invalid_signed_job` before storage. The bundled client's `prepare` command rejects unsupported text before writing a signed job file; it preserves whitespace and trailing newlines in accepted text.

Use `signJob` in `src/inbox/protocol.mjs` or the bundled client to avoid encoding differences. The server rejects extra envelope/message fields. The stored payload fingerprint is independent of object key order. Exact re-submission under the same target/ID returns the existing job. Different contents under that ID return 409. An expired submission returns 400; use status to inspect an already accepted expired envelope. Anyone possessing the complete signed file can replay/read that same request until access is revoked; keep it private before intended publication.

Public results contain request ID, state, attempts, timestamps, and available CID/transaction hash/result/error. They exclude leases, tokens, raw transaction bytes, and message content. States are `queued`, `processing`, `published`, `logged`, `failed`, and `expired`. `processing` may include `execution_retry` or `awaiting_reconciliation`. The attempt counter counts claims, including crash recovery.

## Verify Ledger evidence

When all three expectations `cid`, `nodeAddress` and `contentSha256` are supplied, `logIndex` may be omitted. The verifier then requires exactly one matching nonremoved Ledger event in the receipt and returns its block-global index. Missing or ambiguous matches fail closed. This is the selection mode used by the [finite chosen-node diagnostic](peers/send.md#finite-publication-diagnostic). The JavaScript API also accepts a third `{signal}` argument to cancel bounded reads.

Verify a Ledger log from **any submitting application**, without an inbox, saved job, private key or node installation. Obtain the expected chain and Ledger address independently. Save a `log.json` identifying the transaction and its **block-global log index** (the receipt's `logIndex`, converted to a JSON integer, not its array position):

```json
{
  "transactionHash": "0xabababababababababababababababababababababababababababababababab",
  "logIndex": 7
}
```

Replace this illustrative hash/index with the real record. Optional `cid` and `nodeAddress` constrain the recorded CID and immediate Ledger caller. The caller may be a contract wallet; transaction sender/destination need not equal the event caller/Ledger. Optional `contentSha256` is a 64-character lowercase hex SHA-256 digest (without `0x`) of the exact expected retrieved bytes, obtained independently of the retrieval endpoint. This works for binary data and any payload format. For example, `shasum -a 256 expected.bin` computes that expectation; whitespace and serialization differences change it.

Create a private `evidence.json` with operator-approved endpoints:

```json
{
  "chainId": 11155111,
  "ledgerContract": "0xe6DeB4B3c31E15DBeA0f932830e2f20Ba2EddAa3",
  "rpcUrl": "https://rpc.example.com",
  "ipfsUrl": "http://127.0.0.1:5001"
}
```

From the repository root, with production dependencies installed:

```sh
node node/production/src/verify-ledger.mjs log.json evidence.json
```

`node node/production/src/inbox/client.mjs evidence log.json evidence.json` is an alias of the same job-independent verifier. The former PR interface accepting a saved job and inbox settings is replaced; old job/settings files fail validation. Programmatic consumers import `verifyLedgerEvidence(record, settings)` from `src/ledger-evidence.mjs`. Neither interface reads inbox status or checks job association. A later node-specific adapter can supply independently known expectations.

To keep the exact bytes from this check, append `--export DESTINATION`:

```sh
node node/production/src/verify-ledger.mjs log.json evidence.json --export "$PRIVATE_DIR/content.bin"
```

Choose a new filename in an existing private directory outside Git on a local filesystem that supports hard links. Only a `verified` observation exports bytes, without a second retrieval. The completed file has owner-only permissions and never replaces an existing entry. A local write or cleanup failure reports `stage: export`, `reason: export_failed` (exit 3); inspect the directory before retrying. An interruption can leave a private `.ledger-export-*` temporary file; remove it once the command has stopped.

### Correctness and availability levels

Reports use schema `version: 2` and distinguish these `checks`:

| Check | Meaning of success |
| --- | --- |
| `ledger: verified` | Expected RPC chain, successful receipt, exact transaction/log identity, emitting Ledger, ABI event/CID hash, optional expected caller/CID, and receipt block hash matching a block-by-number lookup. |
| `availability: available` | The selected Kubo returned a complete, bounded response body for the recorded CID during this observation. This is endpoint availability, not peer replication or durable pinning. |
| `content: verified` | Retrieved bytes match the raw CID SHA-256 digest and/or the independently supplied `contentSha256`. `contentVerification` names the performed comparison: `cid_sha256`, `expected_sha256`, or `cid_sha256_and_expected_sha256`. All applicable comparisons must pass. |
| `cidBinding: verified` | Retrieved bytes cryptographically match a raw CID. For non-raw codecs this remains `not_checked`, even when an independent expected-byte digest passes. |
| `semantics: not_assessed` | Always: byte identity does not establish the truth of arbitrary claims, application correctness, agent authorization, or a job-to-log association. |

The published Ledger decoder accepts canonical CIDv1 lowercase unpadded Base32 with a 32-byte SHA-256 multihash. Other representations, including CIDv0, fail validation; Ledger itself permits opaque strings, so this is a verifier format restriction. For the raw codec, `cat` bytes are hashed directly. For UnixFS/DAG-PB and other codecs, a cat response is not a root-block/DAG proof: supply an independent `contentSha256` to check expected bytes, or receive `partial` with `content: unsupported`. Kubo remains trusted for non-raw CID-to-content resolution. The verifier does not infer signatures or payload schemas from JSON.

| JSON `status` / exit code | Meaning |
| --- | --- |
| `verified` / `0` | Ledger identity, retrieval and the stated byte-integrity comparison passed; inspect `cidBinding` and `contentVerification` for the exact guarantee. |
| `mismatch` / `2` | Invalid input, malformed evidence, or contradictory identity, receipt/event, block or bytes. |
| `unavailable` / `3` | Unreadable input, missing receipt/block, HTTP/RPC failure, timeout or body limit. |
| `partial` / `4` | Ledger and retrieval checks passed, but this non-raw CID has no independent expected digest; content integrity is unsupported. |

Reports include a fixed `reason`, `stage`, local UTC `observedAt`, validated public identifiers, `contentBytes` after retrieval, and per-check results. `block.number` and `block.timestamp` are decimal strings; timestamp is Unix seconds from RPC. Earlier successful checks remain visible on failure: corrupt bytes can be `available` while content is `mismatch`. Payloads, signatures, content digests, endpoints, credentials and raw errors are omitted.

**Trust boundary:** the RPC is trusted for chain/receipt/block observations; verify the Ledger implementation separately. These are snapshot checks, without finality or protection against later reorganizations. Availability does not prove long-term pinning or independently reachable peers.

Only operator-supplied endpoints are used. Use HTTPS remotely (HTTP is permitted on loopback), an RPC URL, and a Kubo base URL (without `/api/v0` or query). Optional `rpcAuthorization` and `ipfsAuthorization` strings go only to their respective endpoint; store them in this private file, not shell arguments. Environment credentials are ignored, URL userinfo is rejected, and redirects are refused. Kubo `cat` may retrieve/cache blocks; verification never uploads, pins, signs, submits jobs, broadcasts, or calls worker routes.

Each input file is limited to 65,536 bytes and each response to 131,072 decoded bytes. Large otherwise-valid receipts/content report `unavailable` rather than being partially accepted. `requestTimeoutMs` defaults to 10,000 (maximum 30,000); `timeoutMs` bounds verification at 30,000 by default (maximum 120,000). Both are positive integers and cover streaming. At most four HTTP requests are made, with no polling or retries. Re-run explicitly for a new observation after inspecting a failure. Unknown record/settings keys are rejected before HTTP.

## Worker endpoints

All `/v1/worker/*` endpoints require `Authorization: Bearer TOKEN` and return HTTP 200 on success. Claim takes `{target, execution}` matching the target's persisted identity and returns `{work, leaseMs}`, where `work` is null when unavailable. A work object includes the signed envelope, request ID, random lease UUID, deadline, and `{cid, transaction}` checkpoint. The worker verifies signatures/allowlist again. Ledger transaction checkpoints contain `rawTransaction` and `transactionHash`; raw bytes are visible only to the authenticated worker/database, not public job status.

Worker request bodies must be JSON objects (not null, arrays, or scalars); claim also requires an `execution` object. Invalid shapes return HTTP 400 `invalid_worker_request`, after worker authentication and before store access. Object-shaped execution identities that differ from the configured identity still return 409 `execution_identity_mismatch`; unexpected store failures remain 503 `inbox_unavailable`.

Renew takes `{requestId, lease}`. Checkpoint takes `{requestId, lease, checkpoint}` where checkpoint contains only `cid` or only `transaction`. Completion takes `{requestId, lease, result}`. Retry takes `{requestId, lease}` and lets the database decide whether to retry, fail after ten pre-transaction attempts, or keep a transaction awaiting reconciliation. Stale/expired leases return 409. Worker tokens are privileged: a holder can read queued messages and report execution results. This is operator-controlled infrastructure, not proof of work by an untrusted executor.

## Inspect the queue without claiming work

An operator can inspect the complete queue's counts and its next blocking job without a client's signed job file. `POST /v1/worker/inspect` requires the existing worker bearer token, `Content-Type: application/json`, and exactly `{"target":"my-node"}`. A different target returns 409 `target_mismatch`; extra or missing fields return 400 `invalid_worker_request`. The response is not public. **The worker token still grants full worker authority; this endpoint does not make that credential read-only.** Keep it on operator-controlled machines and send it only to the approved inbox origin.

With production dependencies installed, run from the repository root:

```sh
node node/production/src/inbox/client.mjs inspect https://inbox.example.org my-node TOKEN_FILE
```

Replace the example origin, target and `TOKEN_FILE` with your installation's values. The protected token file contains only the existing worker token, optionally followed by a newline; do not supply an environment file or a signing key. The command never reads signing keys or sends the token in command-line arguments. HTTPS is required except on loopback; redirects are rejected. Exit 0 means a valid snapshot was retrieved, **not** that the worker is running or the queue is healthy. Invalid inputs, unavailable services and malformed responses exit 1 with a generic error. An older inbox without this endpoint returns HTTP 404; upgrade through the ordinary reviewed release process rather than using `claim` to inspect it.

The bounded JSON response includes:

| Field | Interpretation |
| --- | --- |
| `target`, `observedAt` | Queue identity and database statement time, not a worker heartbeat. |
| `capacity.maxJobs`, `retainedJobs`, `availableJobs` | Configured capacity, all retained records, and nonnegative remaining slots. Terminal replay records occupy capacity until ordinary pruning. Reducing capacity below retained rows reports zero available slots. |
| `counts` | Stored counts for `queued`, `processing`, `published`, `logged`, `failed`, `expired`. These are database results, not independently verified chain/content evidence. |
| `queued.ready` | Queued records whose deadline has not passed; they can still be blocked by processing work. |
| `queued.expiredPendingSweep` | Queued records whose deadline has passed but the next worker claim has not yet marked them expired. Inspection does not expire them. |
| `queued.oldestCreatedAt` | Oldest unexpired queued record's creation time, or null. Compare with `observedAt` to assess waiting time. |
| `head` | The processing record, otherwise the oldest unexpired queued record (creation time then request ID), or null. Includes request ID, status, attempts, creation/update/expiry times, lease deadline and the indicators below. |
| `head.leaseState` | `active`: a lease ID and future deadline exist; `backoff`: a future deadline without a lease ID; `available`: no future deadline. Active does not prove a live worker; available does not authorize skipping this job. |
| `head.checkpoint` | `none`, `cid`, or `transaction`: the furthest saved execution stage. A transaction checkpoint does not establish broadcast, mining or success. |

The response excludes signed payloads, signatures, lease IDs, CIDs, transaction hashes/bytes, credentials and arbitrary error text. It is safe to repeat the read, but operational identifiers and timing can still be private. Use the existing signed-job status and Ledger evidence tools when more specific evidence is required.

All fields come from one SQL snapshot in a read-only transaction. The query scans retained rows with a two-second statement deadline and does not acquire the target's mutation lock. Each inbox process permits one inspection in flight; concurrent requests receive 503 `inspection_busy`. Other database failures return 503 `inbox_unavailable`. The client bounds the HTTP exchange at ten seconds and the response at 131,072 bytes, validates the response shape and makes no automatic retries. Avoid frequent polling on large queues; inspect again after a failure or a meaningful worker transition.

An inspection never claims, expires, prunes, retries or repairs work and does not contact IPFS or Ethereum. The view can become stale immediately. A processing transaction checkpoint continues to block later jobs even after its lease or original job deadline expires. Keep the original worker identity and checkpoint, and use the existing reconciliation procedure; never delete or replace a transaction to make the queue appear healthy.

## Transaction safety

Claims and mutations lock a PostgreSQL target row, and an index permits only one `processing` job per target. Retry delays retain that job at the head of the queue. A new lease cannot replace a saved CID or signed transaction. The worker publishes, saves the CID, prepares a transaction, commits its signed bytes, and only then broadcasts. A lost checkpoint acknowledgement causes no broadcast in that attempt. Recovery reads the committed checkpoint and reuses the same bytes and hash. A delayed worker can at most rebroadcast that same transaction; its stale lease cannot alter state.

The worker checks chain/contract configuration, verifies prepared transactions against its identity and fee/gas ceilings, and checks Ledger receipt events before success. A mined revert ends the job as failed. Timeout, malformed receipt, missing event, or unknown broadcast result preserves the transaction and blocks subsequent jobs. There is no automatic fresh nonce, fee bump, cancellation, or fail-open. Use a dedicated node account and do not concurrently send through another target or direct API. Lowering fee limits below a pending checkpoint can pause recovery; restore compatible limits before resuming.

PostgreSQL is the source of truth for retry protection. Keep durable commits and reliable storage enabled, and reconcile before restoring older backups. This protocol does not guarantee safety after loss or manual mutation of committed database state. A `logged` result is receipt verification at observation time, not a guarantee against future chain reorganizations. IPFS publication may repeat after a crash before its checkpoint; publishing the same canonical signed bytes is content-addressed and does not incur another Ledger transaction.

## Validation

From the repository root, run `npm --prefix node/production test` and `npm --prefix node/production run test:inbox`. The latter starts an isolated PostgreSQL container and tests durable offline acceptance, service/database restart, lease races, signature/authentication rejection, capacity, retention, and Ledger recovery with lost acknowledgements/receipts. Kernel transports in the fault tests are controlled fixtures, with real signing and receipt verification. Run `test:inbox:docker` for the packaged services against PostgreSQL, Kubo, and Anvil.
