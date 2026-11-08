---
name: deploy-node
description: Deploy, verify, resume, or operate a local Oya node with a separately hosted PostgreSQL inbox. Use when an operator asks an agent to set up IPFS-only or full Ledger execution, provision inbox hosting, connect an existing installation, or produce a deployment handoff using secure credential references.
---

# Deploy an Oya node

Read the root `AGENTS.md`, applicable area instructions, and `PLANS.md`. Use a living ExecPlan for deployment across hosts. Read [Deploy with an agent](../../node/production/deploy-with-agent.md), [Run locally](../../node/production/run-locally.md), [Host the inbox](../../node/production/host-inbox.md), and the [release guide](../../node/production/release-image.md) before acting.

## Establish the scope

Use the operator's existing choices and authorization. Determine the execution mode, selected local installation, host or provider, budget, DNS hostname, and credential references. For a new installation, default to the [deployed Sepolia Ledger](../../node/production/README.md#deployed-sepolia-ledger): verify authorized signed messages, publish to IPFS, then log CIDs onchain. Honor explicit IPFS-only choices and preserve existing installations and saved identities. Ask only for missing access or decisions outside established scope; do not repeatedly request permission for authorized provisioning and routine setup. Never treat possession of a provider token or a default RPC/contract as spending authorization. Ledger mode needs approved RPC access, a separate dedicated node signer funded with Sepolia ETH, and explicit broadcast scope in addition to the client's signing key, allowlist, and Kubo.

## Protect and preserve state

- Keep an installation journal outside Git, with private directory permissions, resource IDs, completed stages, and credential references. Record created paid resources immediately. Inspect existing resources after an interrupted request before creating duplicates.
- Inspect only selected configuration fields, containers, volumes, and directories. Preserve keys, targets, project names, and old installations. Back up a stopped IPFS repository before reuse; only one Kubo process may own it.
- Capture Keychain retrieval inside a subprocess/program; never expose its stdout to the model or terminal. Keep provider tokens in memory for requests, and redact authorization headers, credential URLs, and exception details. Do not print or commit secrets.
- Explain runtime storage accurately: current images read protected files mounted read-only. Those files are not Keychain-protected, and the running consumer can read them. For macOS Keychain-backed worker startup, use the human guide's `keychain-worker.py` helper and overlay. It removes the temporary host file after startup and disables automatic worker restart; other signing/SSH keys retain their existing storage. Do not silently weaken access controls to allow unattended startup.
- Generate application credentials only for a new installation, with exclusive writes and mode 0600 in mode-0700 directories. Keep signing keys local and database credentials remote. Transfer the worker token using authenticated SSH. Verify host identity through a trusted channel.

## Deploy and test

Follow the human guides' existing commands and schemas. Use matching, checksum-verified release assets and an immutable image digest on both hosts. Preserve archive permissions with `tar -xzpf`, match private-file ownership to the container user, and inspect the Docker daemon architecture before choosing a platform override. Keep local and remote Compose environments separate.

Use the matching `node-v0.4.0` image and bundle for the Sepolia defaults. Older `node-v0.3.1` assets require explicit canonical mode/chain/contract/RPC values. Use an operator-approved Sepolia RPC. Another chain needs explicit contract/RPC settings. Match inbox execution to the worker and replace sample client allowlists. The inbox template's `REPLACE_WITH_PUBLIC_NODE_ADDRESS` must be replaced with the dedicated node's actual public address. Keep the node key local, not on the inbox host. Preserve existing targets; reconcile pending work and create a new target for a deliberate execution-identity change.

For new hosting, verify current price, capacity, and scope before creation; avoid unrequested paid add-ons. Configure public HTTPS, restricted administration, and private database/health ports. Save a resumable record before starting the stack. Do not bypass TLS or SSH verification to make checks pass.

Complete the human guide's acceptance sequence: public TLS, private health route, unauthorized request rejection, offline submission, database/inbox restart persistence, publication after worker startup, verified Ledger receipt/event in default mode, exact signed-content retrieval, idempotent resubmission, worker restart, resource measurements, and restoration of an independent backup into an isolated database. Test real-chain results only within authorized scope. If broadcast authorization or funding is missing, stop before submission and report Ledger acceptance as incomplete. Distinguish local IPFS retrieval from independent peer availability.

If a check fails, preserve state, capture redacted diagnostics, and fix the identified problem. Do not delete volumes, erase queue records, regenerate identities, or create another transaction to hide uncertain work. Stop workers and reconcile transactions before any database rollback. A different image cannot automatically reverse a schema migration.

## Finish the handoff

Leave private commands for monitoring, submitting messages, restarting, backing up, and recovering. State whether backups and pruning are actually scheduled, the latest verified backup, sleep/offline behavior, provider cost, and remaining limitations. Retain credential references rather than values in the record. Update the ExecPlan with evidence and unresolved checks.

Keep public documentation provider-portable and free of operator-specific hosts, addresses, paths, or resource IDs. If changing the workflow, update human guides, this skill, relevant entry points, and release packaging together. Run focused validation and review the full proposed change under the repository's Before Human Review rules. Report incomplete deployment or verification honestly; do not call a running container a validated installation.
