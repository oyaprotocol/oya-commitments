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

Use `signJob` in `src/inbox/protocol.mjs` or the bundled client to avoid encoding differences. The server rejects extra envelope/message fields. The stored payload fingerprint is independent of object key order. Exact re-submission under the same target/ID returns the existing job. Different contents under that ID return 409. An expired submission returns 400; use status to inspect an already accepted expired envelope. Anyone possessing the complete signed file can replay/read that same request until access is revoked; keep it private before intended publication.

Public results contain request ID, state, attempts, timestamps, and available CID/transaction hash/result/error. They exclude leases, tokens, raw transaction bytes, and message content. States are `queued`, `processing`, `published`, `logged`, `failed`, and `expired`. `processing` may include `execution_retry` or `awaiting_reconciliation`. The attempt counter counts claims, including crash recovery.

## Worker endpoints

All `/v1/worker/*` endpoints require `Authorization: Bearer TOKEN` and return HTTP 200 on success. Claim takes `{target, execution}` matching the target's persisted identity and returns `{work, leaseMs}`, where `work` is null when unavailable. A work object includes the signed envelope, request ID, random lease UUID, deadline, and `{cid, transaction}` checkpoint. The worker verifies signatures/allowlist again. Ledger transaction checkpoints contain `rawTransaction` and `transactionHash`; raw bytes are visible only to the authenticated worker/database, not public job status.

Renew takes `{requestId, lease}`. Checkpoint takes `{requestId, lease, checkpoint}` where checkpoint contains only `cid` or only `transaction`. Completion takes `{requestId, lease, result}`. Retry takes `{requestId, lease}` and lets the database decide whether to retry, fail after ten pre-transaction attempts, or keep a transaction awaiting reconciliation. Stale/expired leases return 409. Worker tokens are privileged: a holder can read queued messages and report execution results. This is operator-controlled infrastructure, not proof of work by an untrusted executor.

## Transaction safety

Claims and mutations lock a PostgreSQL target row, and an index permits only one `processing` job per target. Retry delays retain that job at the head of the queue. A new lease cannot replace a saved CID or signed transaction. The worker publishes, saves the CID, prepares a transaction, commits its signed bytes, and only then broadcasts. A lost checkpoint acknowledgement causes no broadcast in that attempt. Recovery reads the committed checkpoint and reuses the same bytes and hash. A delayed worker can at most rebroadcast that same transaction; its stale lease cannot alter state.

The worker checks chain/contract configuration, verifies prepared transactions against its identity and fee/gas ceilings, and checks Ledger receipt events before success. A mined revert ends the job as failed. Timeout, malformed receipt, missing event, or unknown broadcast result preserves the transaction and blocks subsequent jobs. There is no automatic fresh nonce, fee bump, cancellation, or fail-open. Use a dedicated node account and do not concurrently send through another target or direct API. Lowering fee limits below a pending checkpoint can pause recovery; restore compatible limits before resuming.

PostgreSQL is the source of truth for retry protection. Keep durable commits and reliable storage enabled, and reconcile before restoring older backups. This protocol does not guarantee safety after loss or manual mutation of committed database state. A `logged` result is receipt verification at observation time, not a guarantee against future chain reorganizations. IPFS publication may repeat after a crash before its checkpoint; publishing the same canonical signed bytes is content-addressed and does not incur another Ledger transaction.

## Validation

From the repository root, run `npm --prefix node/production test` and `npm --prefix node/production run test:inbox`. The latter starts an isolated PostgreSQL container and tests durable offline acceptance, service/database restart, lease races, signature/authentication rejection, capacity, retention, and Ledger recovery with lost acknowledgements/receipts. Kernel transports in the fault tests are controlled fixtures, with real signing and receipt verification. Run `test:inbox:docker` for the packaged services against PostgreSQL, Kubo, and Anvil.
