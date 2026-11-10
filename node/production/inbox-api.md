# Inbox API and recovery contract

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

The timestamp above is illustrative; use a future Unix timestamp in milliseconds. Submission permits at most seven days into the future. The client defaults to 24 hours. IDs are lowercase UUIDv4. `message.signature` is an Ethereum personal-message signature of the exact text. The outer signature uses the same signer and signs this UTF-8 string, with no trailing newline:

```js
'Oya inbox job v1\n' + JSON.stringify([
  target, requestId, expiresAt,
  message.text, message.signer.toLowerCase(), message.signature
])
```

Message text must be nonempty ASCII without NUL (`U+0000`) and at most 8,192 bytes under the default inbox limit. PostgreSQL cannot store NUL in the inbox's `jsonb` payload; the API rejects it as `invalid_signed_job` before storage. The bundled client's `prepare` command rejects unsupported text before writing a signed job file; it preserves whitespace and trailing newlines in accepted text.

Use `signJob` in `src/inbox/protocol.mjs` or the bundled client to avoid encoding differences. The server rejects extra envelope/message fields. The stored payload fingerprint is independent of object key order. Exact re-submission under the same target/ID returns the existing job. Different contents under that ID return 409. An expired submission returns 400; use status to inspect an already accepted expired envelope. Anyone possessing the complete signed file can replay/read that same request until access is revoked; keep it private before intended publication.

Public results contain request ID, state, attempts, timestamps, and available CID/transaction hash/result/error. They exclude leases, tokens, raw transaction bytes, and message content. States are `queued`, `processing`, `published`, `logged`, `failed`, and `expired`. `processing` may include `execution_retry` or `awaiting_reconciliation`. The attempt counter counts claims, including crash recovery.

## Verify Ledger evidence

Use the existing saved job file and independently obtain the expected target, chain, Ledger address and publishing node address from your operator. Create a private `evidence.json` (replace the example endpoints and addresses):

```json
{
  "target": "my-node",
  "inboxUrl": "https://inbox.example.com",
  "chainId": 11155111,
  "ledgerContract": "0xe6DeB4B3c31E15DBeA0f932830e2f20Ba2EddAa3",
  "nodeAddress": "0x2222222222222222222222222222222222222222",
  "rpcUrl": "https://rpc.example.com",
  "ipfsUrl": "http://127.0.0.1:5001"
}
```

From the repository root, with production dependencies installed:

```sh
node node/production/src/inbox/client.mjs evidence job.json evidence.json
```

The command requires no private key or worker token. It verifies both original signatures, allowing historical expiry, reads `/v1/status` using that exact job, and checks the logged result against the expected chain, receipt sender/destination, Ledger event and retrieved signed-message fields. The result's checkpoint CID/hash must agree with its completion record. The original signed target scopes the status request; v1 status itself does not carry a target. The configured inbox remains trusted for the job-to-result association.

| JSON `status` / exit code | Meaning |
| --- | --- |
| `verified` / `0` | All snapshot consistency checks passed. |
| `mismatch` / `2` | Invalid inputs, malformed evidence, or contradictory signatures, identities, receipt/event or content. |
| `unavailable` / `3` | Unreadable input files, not-yet-logged or publication-only status, missing evidence, HTTP/RPC failure, timeout or body limit. |

Reports include a fixed `reason`, `stage`, local UTC `observedAt`, and validated public identifiers. After receipt validation, `block` identifies the receipt block; its `timestamp` is Unix seconds from the RPC block lookup, and its `number` is decimal. A failed report can include partial evidence: only `verified` means all checks passed. Reports omit message content, signatures, endpoints, credentials and raw errors.

**Trust boundary:** this is a snapshot against your chosen inbox, RPC and Kubo, not a finality guarantee, trustless UnixFS CID/DAG proof, or proof that this request caused the transaction. Exact returned message fields and signatures must match the saved job; Kubo is trusted to return the bytes for the CID. The receipt block hash must agree with a block-by-number lookup at observation time; later reorganizations remain possible. Verify the Ledger implementation separately. This command does not establish long-term pinning or peer availability.

Only operator-supplied endpoints are used. Use HTTPS remotely (HTTP is permitted on loopback), an inbox origin without path/query, an RPC URL, and the Kubo base URL (without `/api/v0` or query). Optional `rpcAuthorization` and `ipfsAuthorization` strings go only to their respective endpoint; store them in this private file, not shell arguments. Environment credentials are ignored, URL userinfo is rejected, and redirects are refused. Kubo `cat` may retrieve/cache blocks as part of a read; the command never uploads or pins, submits jobs, signs, broadcasts, or calls worker mutation routes.

Each file is limited to 65,536 bytes and each response to 131,072 decoded bytes. `requestTimeoutMs` defaults to 10,000 (maximum 30,000); `timeoutMs` bounds the whole verification at 30,000 by default (maximum 120,000). Both are positive integers and cover response-body streaming. There are at most five HTTP requests with no polling or retries. Re-run explicitly for a new observation after inspecting a failure.

## Worker endpoints

All `/v1/worker/*` endpoints require `Authorization: Bearer TOKEN` and return HTTP 200 on success. Claim takes `{target, execution}` matching the target's persisted identity and returns `{work, leaseMs}`, where `work` is null when unavailable. A work object includes the signed envelope, request ID, random lease UUID, deadline, and `{cid, transaction}` checkpoint. The worker verifies signatures/allowlist again. Ledger transaction checkpoints contain `rawTransaction` and `transactionHash`; raw bytes are visible only to the authenticated worker/database, not public job status.

Worker request bodies must be JSON objects (not null, arrays, or scalars); claim also requires an `execution` object. Invalid shapes return HTTP 400 `invalid_worker_request`, after worker authentication and before store access. Object-shaped execution identities that differ from the configured identity still return 409 `execution_identity_mismatch`; unexpected store failures remain 503 `inbox_unavailable`.

Renew takes `{requestId, lease}`. Checkpoint takes `{requestId, lease, checkpoint}` where checkpoint contains only `cid` or only `transaction`. Completion takes `{requestId, lease, result}`. Retry takes `{requestId, lease}` and lets the database decide whether to retry, fail after ten pre-transaction attempts, or keep a transaction awaiting reconciliation. Stale/expired leases return 409. Worker tokens are privileged: a holder can read queued messages and report execution results. This is operator-controlled infrastructure, not proof of work by an untrusted executor.

## Transaction safety

Claims and mutations lock a PostgreSQL target row, and an index permits only one `processing` job per target. Retry delays retain that job at the head of the queue. A new lease cannot replace a saved CID or signed transaction. The worker publishes, saves the CID, prepares a transaction, commits its signed bytes, and only then broadcasts. A lost checkpoint acknowledgement causes no broadcast in that attempt. Recovery reads the committed checkpoint and reuses the same bytes and hash. A delayed worker can at most rebroadcast that same transaction; its stale lease cannot alter state.

The worker checks chain/contract configuration, verifies prepared transactions against its identity and fee/gas ceilings, and checks Ledger receipt events before success. A mined revert ends the job as failed. Timeout, malformed receipt, missing event, or unknown broadcast result preserves the transaction and blocks subsequent jobs. There is no automatic fresh nonce, fee bump, cancellation, or fail-open. Use a dedicated node account and do not concurrently send through another target or direct API. Lowering fee limits below a pending checkpoint can pause recovery; restore compatible limits before resuming.

PostgreSQL is the source of truth for retry protection. Keep durable commits and reliable storage enabled, and reconcile before restoring older backups. This protocol does not guarantee safety after loss or manual mutation of committed database state. A `logged` result is receipt verification at observation time, not a guarantee against future chain reorganizations. IPFS publication may repeat after a crash before its checkpoint; publishing the same canonical signed bytes is content-addressed and does not incur another Ledger transaction.

## Validation

From the repository root, run `npm --prefix node/production test` and `npm --prefix node/production run test:inbox`. The latter starts an isolated PostgreSQL container and tests durable offline acceptance, service/database restart, lease races, signature/authentication rejection, capacity, retention, and Ledger recovery with lost acknowledgements/receipts. Kernel transports in the fault tests are controlled fixtures, with real signing and receipt verification. Run `test:inbox:docker` for the packaged services against PostgreSQL, Kubo, and Anvil.
