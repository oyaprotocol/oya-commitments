# Oya Node

`node/` is the primary home for standalone Oya node daemons.

These daemons are separate from the commitment-serving agent loop in `agent/`:

- the message publication node archives signed agent-authored messages to IPFS
- the proposal publication node archives signed proposal bundles to IPFS
- the proposal publication node can also run in `propose` mode and submit proposals onchain

The underlying publication/auth/IPFS/config libraries are still shared from `agent/src/lib/` in this version. This workspace owns the process entrypoints, node-oriented runtime helpers, and node-focused tests. `node/package.json` depends on the shared agent package, and the node scripts prefer local repo imports while falling back to that installed package so the daemons can still boot when `node/` is installed from its own manifest.

## Commands

From the repository root:

```bash
node node/scripts/start-message-publish-node.mjs --module=<agent-name>
node node/scripts/start-proposal-publish-node.mjs --module=<agent-name>
```

For dry-run config resolution:

```bash
node node/scripts/start-message-publish-node.mjs --module=<agent-name> --dry-run
node node/scripts/start-proposal-publish-node.mjs --module=<agent-name> --dry-run
```

Focused regression entrypoints:

```bash
node node/scripts/test-message-publication-api.mjs
node node/scripts/test-message-publication-store.mjs
node node/scripts/test-message-publish-runtime.mjs
node node/scripts/test-proposal-publication-api.mjs
node node/scripts/test-proposal-publication-store.mjs
```

## Compatibility

The old startup paths under `agent/scripts/` still exist as compatibility wrappers during the migration:

- `agent/scripts/start-message-publish-node.mjs`
- `agent/scripts/start-proposal-publish-node.mjs`

Use the `node/` paths for new docs, new operator instructions, and future node work.
