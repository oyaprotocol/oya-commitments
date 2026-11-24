# Sign and verify a retrieval receipt

## Purpose / Big Picture

An operator can sign for a single successful read and give a reviewer a receipt CID. The reviewer can verify the signature against an independently chosen node address and content CID without the signing key. This is a statement about one read at a signer-reported time, not a guarantee of retention.

## Progress

- [x] 2026-11-22 21:35Z: Replaced the unsigned CLI entry in the production image allowlist with the CLI and receipt module.
- [x] 2026-11-22 21:37Z: Exercised the README create and verify invocations with an isolated Kubo daemon and a throwaway signer. Checked the pin and a wrong-content failure.

- [x] 2026-11-22 21:40Z: Rebuilt the release image with the guarded installation signer and repeated create, keyless verify, pin and wrong-content checks using only a disposable mode-0600 `node.env`.

## Surprises & Discoveries

The pinned Node base and production dependencies were cached locally, but a build with `--network=none` missed the npm layer and failed with `EAI_AGAIN`. The build below reused the existing layer without running npm. The CLI containers themselves shared only the offline Kubo container’s loopback network.

## Decision Log

2026-11-22, signer integration: reuse the peer installation reader so receipt creation checks ownership, permissions, file type, link count and size without reading peer configuration. Verify never selects an installation.

2026-11-22, implementation review: use a signed raw IPFS block rather than unsigned text tied to a Ledger event. The recipient can check both the exact bytes and who signed without a chain lookup. Pin the receipt separately so creating it does not change the source block’s retention policy.

## Outcomes & Retrospective

The packaged commands returned identical JSON for creation and keyless verification. Changing the expected content made verification fail even though both requested reads were available. A cached read qualifies; a receipt is not evidence that a remote peer served the bytes.

## Export verified blocks for offline handoff

- [x] 2026-11-24 22:35Z: Traced `verifyStoredRetrieval`: it already reads and verifies both raw blocks but returns only parsed metadata. Ledger save requires a different record. #239 consumes files rather than producing them.
- [x] 2026-11-24 22:37Z: Added `verify ... --export NEW_DIR`. The verifier passes the two checked buffers to the CLI before returning its usual JSON. The CLI reserves the destination and renames a private staging directory to `blocks/` after both writes finish.
- [x] 2026-11-24 22:38Z: Both new tests initially failed with the old CLI usage error. On Node 24 the receipt suite then passed. Separately exercised the README recipient command with only the exported files, expected signer and content CID; the permanent round-trip test uses the same verifier without needing the README in a packaged test image. The failure cases leave existing paths unchanged and remove an interrupted export.

Repeat from `node/production` with installed dependencies: `node --test test/retrieval-attestation.test.mjs`. The fixture supplies the Kubo reads in memory. See the export and recipient commands in `node/production/README.md`.

Decision (2026-11-24, Gardener): export the existing wire bytes, not a new archive format or an additional Kubo read. Q031 and Q032 distinguish checking the data from knowing how a node stored it. A reviewer needs the two files and independent expectations, not the sender's settings.

## Context and Orientation

Kubo is the local IPFS service. A raw CID identifies one block by the hash of its bytes. In `node/production/src`, `attest-retrieval.mjs` handles the command line, `retrieval-attestation.mjs` signs and verifies, and `ledger-evidence.mjs` supplies bounded reads and validation helpers. Neither a Ledger record nor an RPC endpoint is needed.

## Plan of Work

Keep both modules in `node/production/.dockerignore`’s allowlist. Document the expected signer and CID, create-only key, Kubo permissions, and both image entrypoint invocations in `node/production/README.md`. Exercise the packaged modules, not a mounted source tree.

## Concrete Steps

From the repository root with Docker, Bash, Python 3, cached release build inputs and local `ipfs/kubo:v0.43.0`, build the release Dockerfile without pulling images or downloading dependencies:

    docker build --pull=false --build-arg HTTPS_PROXY=http://127.0.0.1:9 --build-arg HTTP_PROXY=http://127.0.0.1:9 --build-arg NO_PROXY= -t oya-pr226-retrieval:offline-check node/production

Run the focused tests from the repository root:

    docker run --pull=never --rm --network none --mount "type=bind,src=$PWD/node/production/test,dst=/app/test,readonly" --entrypoint node oya-pr226-retrieval:offline-check --test test/retrieval-attestation.test.mjs test/peer-send-local.test.mjs

Then run this disposable smoke check in Bash. Keep shell tracing off; the generated key stays in a throwaway installation file. No ports are published.

    set -eu
    umask 077
    work=$(mktemp -d); cd "$work"
    image=oya-pr226-retrieval:offline-check
    ipfs_id=$(docker run --pull=never -d --network none ipfs/kubo:v0.43.0 daemon --offline)
    trap 'docker rm -fv "$ipfs_id" >/dev/null; rm -rf "$work"' EXIT
    for i in $(seq 1 30); do docker exec "$ipfs_id" ipfs --api /ip4/127.0.0.1/tcp/5001 id >/dev/null 2>&1 && break; sleep 1; done
    cid=$(printf 'retrieval smoke test\n' | docker exec -i "$ipfs_id" ipfs block put --cid-codec=raw --mhtype=sha2-256 --pin)
    OYA_LOCAL_DIR="$PWD/installation"; mkdir -m 700 "$OYA_LOCAL_DIR"
    addr=$(docker run --pull=never --rm --network none --user "$(id -u):$(id -g)" --mount "type=bind,src=$OYA_LOCAL_DIR,dst=/fixture" --entrypoint node "$image" -e 'const w=require("ethers").Wallet.createRandom(); require("node:fs").writeFileSync("/fixture/node.env","OYA_NODE_PRIVATE_KEY="+w.privateKey+"\n",{mode:0o600,flag:"wx"}); process.stdout.write(w.address)')
    printf '{"nodeAddress":"%s","ipfsUrl":"http://127.0.0.1:5001"}\n' "$addr" >settings.json
    attest() {
      docker run --pull=never --rm --read-only --user "$(id -u):$(id -g)" \
        --network "container:${ipfs_id:?Set the Kubo container ID}" \
        --mount "type=bind,src=$PWD/settings.json,dst=/settings.json,readonly" \
        "$@"
    }
    attest_create() (
      # Docker follows host bind-source symlinks; check the source before mounting it.
      case ${OYA_LOCAL_DIR:-} in /*) ;; *) return 1 ;; esac
      dir=${OYA_LOCAL_DIR%/}
      test -n "$(find "$dir" -prune -type d -user "$(id -un)" -perm 0700 -print)" &&
        test -n "$(find "$dir/node.env" -prune -type f -links 1 -user "$(id -un)" -perm 0600 -print)" || return 1
      attest --tmpfs "/identity:rw,noexec,nosuid,nodev,mode=0700,uid=$(id -u),gid=$(id -g)" \
        --mount "type=bind,src=$dir/node.env,dst=/identity/node.env,readonly" \
        -e OYA_LOCAL_DIR=/identity --entrypoint node "$image" src/attest-retrieval.mjs create "$cid" /settings.json
    )
    attest_create >created.json
    receipt_cid=$(python3 -c 'import json; print(json.load(open("created.json"))["receiptCid"])')
    attest --entrypoint node "$image" src/attest-retrieval.mjs verify "$receipt_cid" "$cid" /settings.json >verified.json
    cmp created.json verified.json
    python3 -c 'print(open("verified.json").read())'
    docker exec "$ipfs_id" ipfs pin ls "$receipt_cid"
    if attest --entrypoint node "$image" src/attest-retrieval.mjs verify "$receipt_cid" "$receipt_cid" /settings.json >wrong.out; then exit 2; else rc=$?; fi; wc -c <wrong.out; printf "negative exit=%s\n" "$rc"; test "$rc" = 1; test ! -s wrong.out

## Validation and Acceptance

Both commands must exit 0 and `cmp` must find their JSON byte-identical. Kubo must report a pin for the returned receipt. Substituting the receipt CID as the expected content must exit 1 with empty stdout. The focused suite also checks signature recovery, corrupt reads, size limits and publication failures.

## Idempotence and Recovery

Each smoke run starts an empty repository and a new identity; expect a different receipt CID. The exit trap removes the Kubo container and its anonymous volumes and deletes test files. If readback fails after a successful put, the receipt may already be pinned; exit 2 supplies the locally calculated receipt CID for keyless verification before retrying creation.

## Artifacts and Notes

The final full production suite passed 686 tests with a private scratch temporary directory.

On 2026-11-22 the packaged retrieval and peer-local suites passed 22/22. The 21-byte test block was `bafkreifgalwpj54m4yyn5wvpk7pksqudsrdlmcgggxn7q5kgskseoazqcm`. The receipt completed at `2026-11-22T21:40:28.731Z`; Kubo listed `bafkreiaqyhzcl3pidlmc5wewhw6q4z62gragl37zaeo7wmadjcszrw4tam recursive`. The wrong-content run exited 1 with zero stdout bytes.

## Interfaces and Dependencies

`create CID SETTINGS` checks the configured identity against the signer from the guarded `$OYA_LOCAL_DIR/node.env`; inherited private keys are ignored. The signed digest covers compact metadata, a NUL separator and the source bytes. `verify RECEIPT_CID CID SETTINGS` fetches both raw blocks and checks the signature without writing. Both return `{receiptCid,receipt}`. The CLI limits content to 1 MiB and receipts to 1024 bytes.

## Next feature — candidate when capacity permits

`retrieval-cli-from-any-directory-v1`: a reviewer in #239 asked to run scripts without changing to a particular directory. The previous Ledger discovery candidate shipped in #228. Start with one task: from a directory containing evidence or settings, invoke the installed receipt verifier by name and resolve all input and export paths against that directory.

Inventory the existing operator launcher and release packaging first. If an installed command already forwards these arguments, test and document it rather than adding a second launcher. Otherwise add one thin dispatch entry to the existing distribution, forwarding argv, stdout, stderr and exit status to the production CLI. Keep signing, verification and path interpretation in the existing modules. Test from an unrelated working directory whose path contains spaces, including relative arguments, usage errors and an unavailable input. Exercise the packaged command with a fixture, without installing a service. Depends on the production CLI and a supported local distribution, not on Ledger or an offline file mode. Estimate 40–120 changed code/test lines; defer if it would require a new distribution just for this command.
