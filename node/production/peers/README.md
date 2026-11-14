# Testnet peer registry

`testnet-directory.json` is the public address book maintained through reviewed PRs to `oyaprotocol/oya-commitments`. We trust the addresses and endpoints accepted into this repository. The list starts empty because no roster has been supplied; do not enroll example identities.

Each entry contains the node's public Ethereum `nodeAddress`, its HTTPS `receiveUrl` ending in `/v1/jobs`, and its inbox `target` (the destination name required by the existing signed-job protocol). For example, **not an enrolled node**:

```json
[
  {
    "nodeAddress": "0x1111111111111111111111111111111111111111",
    "receiveUrl": "https://node.example/v1/jobs",
    "target": "example-node"
  }
]
```

To add, remove or update a node, edit the list and open a normal PR. Include only public routing information, never keys, worker tokens or private service URLs. There are no registry revisions, hashes, enrollment proofs or custom CI gates.

## Load the bundled list

From the repository root or the root of an extracted deployment bundle, with Node.js 24:

```sh
node node/production/scripts/peer-directory.mjs
```

This loads the included list by default and prints JSON. To read another copy:

```sh
node node/production/scripts/peer-directory.mjs list ./testnet-directory.json
```

No dependency installation is needed. Release bundles include the registry, this guide and the helper. The bundled list reflects that release and may lag upstream; older releases without the helper can use a current source checkout. Use the updated upgrade helper for bundles containing these new public files.

## Fetch the updated list

Once this feature is merged into upstream `main`, new or existing operators can retrieve the current list with:

```sh
node node/production/scripts/peer-directory.mjs fetch
```

`fetch` reads only the fixed official GitHub source, with a ten-second timeout and no redirects. It prints the list only after a successful HTTP response and basic JSON/record checks. It does not contact listed nodes. Exit codes are 0 for success, 1 for loading failure and 2 for incorrect arguments.

To save a refreshed copy without losing an existing copy on a failed download, run this from the directory where you keep the public registry:

```sh
# Set this to your checkout or extracted bundle root.
OYA_SOURCE=/path/to/oya-source
candidate=$(mktemp ./testnet-directory.XXXXXX) && {
  if node "$OYA_SOURCE/node/production/scripts/peer-directory.mjs" fetch > "$candidate"; then
    mv "$candidate" ./testnet-directory.json
  else
    rm -f "$candidate"
  fi
}
```

The command itself writes no files; the shell saves and replaces the public list. Retry a failed fetch later or continue using the previous copy.

## Routing is separate from authorization

Loading or fetching this address book does **not** change `allowedSigners`, node keys, inbox/worker configuration or running services. Current inbox and worker startup do not consume it. Keep existing explicitly configured signer permissions; do not paste this array into an allowlist or add the future `peers` configuration. Signed jobs still require the existing signature, target and authorization checks. Runtime peer-policy integration and outbound node messaging are separate follow-up work.
