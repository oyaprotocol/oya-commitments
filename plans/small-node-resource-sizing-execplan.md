# Size a small hosted Oya node

This research ExecPlan follows `PLANS.md`. The user requested memory/storage research and cheaper Kubo hosting on 2026-09-23. Production behavior and deployment settings remain outside this research change.

## Purpose / Big Picture

Determine a defensible starting server size for the existing Node/Kubo/Caddy stack, explain storage growth, and compare cheaper deployment options while preserving message publication and public content availability. Deliver a cited report at `node/production/resource-sizing.md`, clearly separating measurements, estimates, and untested configurations.

## Progress

- [x] 2026-09-23: Read the current deployment, message bounds, pinning/import semantics, and plan requirements. The working tree was clean; no running containers were listed.
- [x] 2026-09-23: User clarified 100 small text messages/day initially, with US hosting and planned growth. Indefinite retention remains the sizing assumption.
- [x] 2026-09-23: Researched version-specific Kubo profiles, resource limits, retention, remote-provider compatibility, and US hosting prices. Drafted the report with explicit sizing assumptions and source links.
- [x] 2026-09-23: Measured two online Kubo configurations, Node/Caddy during the passing HTTPS integration, installed image files, and allocated storage for 4,000 synthetic messages. Removed the disposable measurement containers and volumes.
- [x] 2026-09-23: Completed the cited report, checked calculations and Markdown, and documented the remaining cloud-validation limits.

## Surprises & Discoveries

- The existing integration fixture runs Kubo offline. Its successful runs establish correctness but cannot determine public-network resource requirements.
- Every publication requests pinning, so retained unique envelopes accumulate. Repeated identical envelopes share their content-addressed block even though they create distinct Ledger transactions.
- Kubo 0.43's `lowpower` profile preserves announcements. Its connection watermarks do not prevent temporary peer counts far above those thresholds. A Docker restart can reassign a dynamic API port; the measurement fixture must rediscover it.
- Managed IPFS free tiers can exhaust their 500-file allowance in five days at the selected volume. Filebase documents Kubo-style endpoints but not every import option required by this repository; compatibility remains untested.
- Both online Kubo configurations peaked around 250 MiB in the short experiment. The low-power settings did not materially reduce peak memory; neither configuration establishes a long-term cloud minimum.
- Allocated disk growth was about 10–16 KiB per unique envelope with 1–8 KiB text, substantially above logical payload size. At 100/day, the measured allocation extrapolates to approximately 0.36–0.57 GiB/year before backups.

## Decision Log

- 2026-09-23 / Codex: Use public vendor documentation and the pinned Kubo 0.43.0 source. Older low-memory recommendations changed across versions and must not be copied blindly.
- 2026-09-23 / Codex: Use generated test accounts, synthetic data, and isolated Docker resources for measurements. No production credentials, real transactions, paid resources, or changes to existing deployments are needed.
- 2026-09-23 / Codex: Recommend a monitored 1 GB US VM pilot at $5–7/month, or 2 GB at $12/month for more margin, with colocated Kubo. Reserve approximately 1 GiB/year for the initial message volume until measured growth establishes a better allowance.

## Outcomes & Retrospective

The research deliverable is complete in `node/production/resource-sizing.md`. It includes component budgets, measured resource usage, storage growth, version-specific Kubo controls, US provider pricing, and managed-storage tradeoffs. No runtime code, production settings, or cloud resources changed.

The HTTPS integration passed in 348 seconds. Two online Kubo experiments ran for roughly 4.5 minutes with no recorded OOM events; selected uploaded files were read back byte-for-byte. An offline experiment measured filesystem allocation separately. These runs support testing a smaller VM but do not establish a production minimum. Host overhead, long-term reannouncements, inbound public-host load, external retrieval, and the complete stack on a 1 GB host still require a 48–72 hour cloud pilot before relying on that size. Managed IPFS compatibility also remains untested.

## Context and Orientation

`node/production/compose.yaml` runs Node and Kubo 0.43.0 with the `server` profile; `docker/compose.http.yaml` adds Caddy. The application uses an external Ethereum RPC, not a locally synchronized chain. `src/server.mjs` permits one active publication and up to 64 connections. Default request/text limits are 16 KiB/8 KiB. `packages/ipfs/README.md` specifies canonical, pinned, raw single-block imports for these small envelopes. Docker logs rotate independently for each service.

## Plan of Work

First resolve exact Kubo defaults and low-memory options. Next measure image/container footprints and synthetic storage growth, comparing ordinary networking with the supported low-power profile if Docker permits. Finally model daily message volumes and compare small VMs with managed IPFS alternatives, including API compatibility and availability tradeoffs.

## Concrete Steps

From the repository root, inspect `node/production/compose.yaml`, `node/production/src/config.mjs`, `node/production/src/server.mjs`, and `packages/ipfs/README.md`. Read the upstream `v0.43.0` config/profile source and current provider prices. Use `docker stats --no-stream`, selected `docker image inspect` fields, Kubo `repo stat`, and `du` on disposable repositories. Reuse `npm --prefix node/production run test:http -- --verbose` when observing actual Node/Caddy operations. Record exact settings, workload, sampling periods, and measurement scope in the report.

## Validation and Acceptance

Recommendations must account for host memory, background IPFS networking, application operations, image/build storage, unique pinned data, metadata/allocation, logs, backups, and disk headroom. Verify synthetic data through the API and distinguish logical bytes from allocated disk usage. Short local measurements cannot prove a cloud VM size, public reachability, or long-term reliability. Run `git diff --check` and inspect all new material before handoff.

## Idempotence and Recovery

Use uniquely named research containers and volumes, and clean up only those resources. The existing integration harness cleans up its own resources. Never prune unrelated Docker data or apply profiles to a real IPFS repository. Keep generated data out of version control.

## Artifacts and Notes

The report retains aggregate public measurements, workload assumptions, and source links, not generated keys, private settings, local absolute paths, or fixture identifiers. Size the initial deployment for 100 small messages/day in the US, with 1,000 and 10,000/day growth scenarios and indefinite retention.

Validation included `npm --prefix node/production run test:http -- --verbose`, Kubo add/cat round trips, cgroup memory/OOM counters, `docker stats`, and `du` versus `repo stat`. The report records settings, sample counts, observation windows, and reproduction steps. Markdown whitespace and repository-relative links were checked for both new documents.

## Interfaces and Dependencies

Use existing Docker, Compose, Node 24, Foundry, pinned service images, and HTTP IPFS interfaces. Remote alternatives must be assessed against the kernel's complete `/api/v0/add` import recipe and pinning behavior; a pin-by-CID API alone cannot replace uploading bytes.
