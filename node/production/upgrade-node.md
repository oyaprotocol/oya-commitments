# Upgrade an existing inbox and worker

Use `scripts/upgrade-node.py` to select a **published, stable node release**, inspect the proposed change, and replace the application image without initializing another installation. It preserves existing configuration, execution mode, target, keys, Compose project, Docker context, private mounts and named volumes. It does not copy new example configuration over your settings. An IPFS-only node therefore stays IPFS-only when upgrading to a release whose new-installation default is Sepolia.

The helper is for the released Compose **worker + Kubo** and **inbox + bundled PostgreSQL**, optionally with the HTTPS proxy. It requires Python 3.9+, Docker Compose 2.30+, a local Linux Docker engine or Docker Desktop, and access to GitHub/GHCR. Run it on each role's own host. It does not administer SSH hosts, managed databases, direct HTTP nodes, scaled workers, or schema/storage migrations. Custom application argument paths are rejected so the configuration and database being checked are the ones the runtime uses. Unsupported topology or changed dependency settings stop before application replacement; use a reviewed manual migration for those cases.

Use this guide and helper from a trusted, reviewed checkout or a subsequent release that packages them. The already-published **node-v0.4.0 archive does not contain this new helper**; it can be selected as an upgrade target without republishing that immutable release. Run commands below from the checkout/bundle root containing `node/production/`.

## 1. Review the release and preview both hosts

Choose an exact tag, for example `node-v0.4.0`, and read its compatibility, migration and rollback notes on the project's GitHub Releases page. The helper does not infer that an arbitrary release is schema-compatible. Resolve any migration requirements before using the application-only procedure.

Use the **existing** private `compose.env` for each role. Its saved selectors must include absolute bundle/private paths, the immutable image, project name, and Compose files, plus any custom interpolation overrides. Use literal exported values as produced by the setup guides' `printf %q` commands. The helper parses these settings without executing shell code; general shell commands and substitutions are rejected. Put Docker on your invoking shell's `PATH` if necessary.

Worker host:

```sh
python3 node/production/scripts/upgrade-node.py preview \
  --role worker --env-file "$HOME/oya-private/local-inbox-node/compose.env" \
  --release node-v0.4.0
```

Inbox host:

```sh
python3 node/production/scripts/upgrade-node.py preview \
  --role inbox --env-file "$HOME/oya-private/inbox/compose.env" \
  --release node-v0.4.0
```

Preview fetches the selected release metadata and three public assets into an automatically cleaned temporary directory. It checks GitHub asset SHA-256 digests, the archive checksum and manifest in the release notes, the selected Git tag's resolved commit against the manifest revision (including annotated tags), matching archive/image identities, safe archive paths and file types, and the image's source/revision/version labels directly from GHCR. It compares the rendered old/new Compose configuration with the actual local containers and storage. The image must have a manifest for the selected platform; retain your existing amd64 override on ARM hosts.

Preview **does not pull an image, stop/start services, change saved settings, read Keychain, or create installation recovery records**. It is not offline: GitHub/GHCR and Docker inspection must be available. The normal command requires an explicit action; there is no implicit apply or `latest` selection.

## 2. Prepare recovery and stop every worker

Back up configuration, sender/node keys and IPFS storage using your established protected backup procedure. The application update preserves Kubo and its volume; it does not create an IPFS snapshot or an off-device backup. A consistent Kubo copy requires stopping its sole owning daemon first. Keep its peer identity private and never run a restored copy concurrently with the original. Test recovery on isolated storage, not by overwriting the live volume.

On **every worker host** connected to the inbox:

```sh
python3 node/production/scripts/upgrade-node.py quiesce \
  --role worker --env-file "$HOME/oya-private/local-inbox-node/compose.env"
```

Quiesce stops the selected worker and verifies shutdown. It leaves Kubo and its volume available. It rejects a forced/failed shutdown rather than assuming in-flight work finished. Save the reported recovery directory. Confirm that no other machine, service manager or operator can restart a worker during maintenance. Local container inspection cannot prove remote workers are stopped.

The queue retains work while workers are offline, subject to deadlines and capacity. Saved CID and signed-transaction checkpoints remain authoritative. An unresolved Ledger transaction must resume from its original checkpoint; do not delete its row, reset its nonce, replace its fees, or create another request ID to make an upgrade pass.

### Keychain-managed workers

For a worker already managed by `keychain-worker.py`, append both existing references to **preview, quiesce and apply**:

```sh
--keychain-account oya-deploy --keychain-service oya-deploy-worker
```

These are item names, not credential values. Detection of a helper-managed/missing token mount requires the explicit references. Quiesce and apply use the existing helper's stop/start lifecycle, retain `restart: "no"`, and remove temporary token files after startup or cleanup. Startup may request macOS approval; the upgrader does not weaken access controls or move the token into a persistent plaintext file. Never substitute ordinary `docker compose up` for Keychain startup. Changing credential modes is a separate operation.

## 3. Upgrade the inbox first

After **all** workers have stopped, run on the inbox host:

```sh
python3 node/production/scripts/upgrade-node.py apply \
  --role inbox --env-file "$HOME/oya-private/inbox/compose.env" \
  --release node-v0.4.0 --workers-stopped
```

`--workers-stopped` is your explicit acknowledgement, not a claim that the command found remote workers. Apply acquires a per-installation lock, retains verified release assets, and saves private configuration copies and old/new selections. It pulls only the verified Oya image and rechecks its immutable identity and labels. Then it stops the inbox, takes a consistent PostgreSQL custom-format dump, and checks that `pg_restore --list` can read it. This catalog check is **not** a full restore test.

The helper atomically updates only the saved bundle/image/Compose selectors, recreates **only `inbox`** with `--no-deps`, and checks its image and container health. PostgreSQL and proxy containers and volumes are retained. Other settings and private files must remain unchanged. Keep the retained old bundle because an unchanged proxy may still mount its public Caddyfile.

Before proceeding, verify existing job status and execution identity, private inbox health, and public HTTPS with normal certificate validation. For the standard port:

```sh
curl -fsS http://127.0.0.1:8788/healthz
```

The public `/healthz` route deliberately returns 404; use the inbox API and an existing signed job for external checks. Stop if records/checkpoints differ unexpectedly. Do not resume workers until the inbox is verified at the selected release.

## 4. Upgrade and resume the worker

On each worker host, after checking its counterpart inbox:

```sh
python3 node/production/scripts/upgrade-node.py apply \
  --role worker --env-file "$HOME/oya-private/local-inbox-node/compose.env" \
  --release node-v0.4.0 --inbox-ready node-v0.4.0
```

Add the two Keychain references when applicable. `--inbox-ready` acknowledges that you verified the matching inbox release and existing state; it is not remote version discovery. The helper recreates only `node`, retaining Kubo, its volume and all execution settings. Worker health requires a recent successful inbox poll. The helper does not submit messages or broadcast test transactions.

Check retained job results and IPFS content, then perform a harmless end-to-end test within your established publication/broadcast scope. Save one signed request and reuse it for status and duplicate checks; do not prepare another ID to retry an uncertain result. IPFS-only completion is `published`; Ledger completion is `logged` with a verified receipt/event. A local pin does not prove independent replication.

In later shells, source the **updated** saved `compose.env` before using your existing monitoring commands. An already-open shell retains its old environment until you source it again. `docker compose start` alone does not upgrade an image.

## Recovery records and failures

Each mutating operation records an attempt under the private installation's `.oya-upgrades/` directory. Apply records include the selected release/source/image, phase, original and new selectors, configuration fingerprints and protected copies of mounted settings, Keychain references when used, and inbox backup/checksum when completed. The recovery root is synced through its parent before services stop; backup files, release assets and their directory entries are synced before the saved selectors are committed. Quiesce records its project/context, configuration fingerprints, credential references and shutdown phase; it does not make release/configuration/database backups. They can contain credentials and broadcastable signed transaction data: retain owner-only access and protect any off-device copies.

The active bundle is retained inside its attempt directory. **Do not delete successful attempt directories or old bundles just because an upgrade completed.** Inspect the current saved selectors and actual mounts before any deliberate retention cleanup. The helper performs no automatic pruning.

Failures return nonzero. Journaled attempts retain `failed_stage` plus a sanitized `error_category` rather than child output. Once mutation begins, the helper tries to stop the affected application and records whether shutdown was confirmed; it does not automatically start an old image or restore PostgreSQL. If Docker is unavailable, shutdown may be unconfirmed: inspect and stop affected workers manually. A failure after saving selectors may leave them pointing at the new image while its service is stopped. Inspect the journal and actual containers rather than blindly sourcing an older file and restarting.

An unresolved `.oya-upgrades/active.json` blocks another mutating attempt. After inspecting the retained attempt, reconciling transaction/checkpoint state and confirming stopped services, the operator can archive the marker and deliberately retry; retain the entire attempt directory. Read-only previews remain available. A successful quiesce clears its active marker but keeps its journal.

Never use an older database dump as an ordinary image rollback. A transaction may have been broadcast after that dump, so restoring it can lose replay protection even if an old image starts successfully. A different image cannot reverse a schema migration. Retain the latest database, keys, queue records and IPFS state; decide any rollback from the release's compatibility rules and observed transaction state. The helper deliberately has no automatic rollback or row-deletion command.
