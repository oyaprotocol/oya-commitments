# Resource sizing for a small US deployment

Research date: 2026-09-23. Starting workload: 100 small text messages/day, US hosting, with growth planned. Retention is assumed indefinite until an explicit policy is chosen. This report covers the existing Node 24 / Kubo 0.43.0 / Caddy 2.11.4 Compose stack. Recommendations are provisional sizing decisions, not a cloud capacity certification.

The likely economical choice is a single 1–2 GB Linux VM with 25–60 GB SSD, keeping Kubo beside the application. A 1 GB VM is a candidate for a monitored pilot; 2 GB offers more operating margin. The earlier 4 GB recommendation was an unmeasured estimate. The smallest 512 MiB VM leaves much less room for the operating system, updates, and IPFS bursts.

## What actually consumes resources

The application calls an external Ethereum RPC. It does not synchronize an Ethereum chain, run a database/indexer, or keep a local copy of Ledger history. Anvil and Foundry belong to development/deployment tooling, not the continuously running production stack.

| Component | Memory drivers | Persistent storage |
| --- | --- | --- |
| Node application | Node/V8, ethers, HTTP connections, signature verification, one active publication | Container image and rotated result logs; private settings are small |
| Kubo | Peer connections, routing, announcements, uploads/downloads, pin metadata | Pinned message blocks, indexes, identity, and cached retrieved blocks |
| Caddy | TLS, active connections, request forwarding | Certificates/configuration and rotated logs |
| Linux and Docker | Kernel, services, daemon, filesystem cache, updates/builds | OS, images, package/build caches, journals, optional swap |
| Backups | Temporary buffers during copying | Separate protected copies of IPFS data and private settings |

The [server](src/server.mjs) permits one active publication, with no work queue, and caps node connections at 64. Defaults cap text at 8,192 bytes and the request body at 16,384 bytes. The 60/minute message budget counts valid allowlisted attempts; it is not a guaranteed throughput rate. Concurrent body/signature validation and IPFS peer traffic can still consume resources while one transaction is pending.

## Measurements and their limits

Measurements used Docker Desktop's Linux arm64 daemon, Engine 27.4.0, with 10 host CPUs and 7.65 GiB host RAM. No production credentials or paid chain were used. The repository HTTPS integration passed in 348 seconds. Separate online Kubo containers used the production image digest and newly initialized repositories; a third offline container isolated disk allocation from network activity.

| Component/case | Observed Docker memory | Highest recorded cgroup memory | Scope |
| --- | ---: | ---: | --- |
| Node | 71.4–71.7 MiB | Not measured | 15 samples during the integration's final receipt-wait/drain phase |
| Caddy | 16.5–18.7 MiB | Not measured | 16 samples during that phase |
| Kubo, `server` profile | 54–223 MiB | 240 MiB | 20 samples over 267 seconds; 1 GiB hard limit |
| Kubo, `server,lowpower` plus memory settings | 39–232 MiB | 249 MiB | 20 samples over 269 seconds; 512 MiB hard limit |

Each Kubo case had a one-CPU limit and no container swap, connected to public peers, and received two bursts of 20 unique synthetic envelopes with 1 KiB and 8 KiB text respectively. The final file in each burst was read back byte-for-byte. These storage envelopes had dummy signatures; the separate integration used real generated signers and verified Ledger events. No OOM events were recorded. The lower-memory case used `GOMEMLIMIT=320MiB` and `Swarm.ResourceMgr.MaxMemory=128MiB` after restart. Multiple settings differ between cases, so this is a feasibility comparison, not an isolated profile benchmark.

Docker's CLI memory figure excludes some cache; cgroup memory includes additional charged pages and the probe processes. Sampling can miss short CPU/process-memory spikes; the cgroup peak retains memory high-water usage for the observed interval. Node/Caddy samples mostly measure a pending operation, not a sustained request burst or startup/build peak. Host memory overhead was not measured.

The containers were behind Docker Desktop/NAT with only loopback API ports published. This establishes outbound public-peer activity, not inbound public-host DHT-server load or independent internet retrieval. Peer counts temporarily reached roughly 1,000 in both cases despite connection watermarks. Sampled Kubo CPU peaked around 58% and 56% of one core; final samples were about 0.2% and 1.2%. Egress reached approximately 49 MB and 37 MB over the observation window, including bootstrap and announcement bursts. Do not extrapolate these short bursts into monthly costs, or assume bandwidth equals uploaded text size.

The comparison found no material peak-memory saving from `lowpower` in this short run. Both cases operated far below 6 GB; neither is a long-term capacity result. Full reannouncement cycles, larger pinsets, internet retrieval, a US x86 VM, and the complete stack under a 1 GB host limit remain untested.

To repeat the observations, use disposable repositories with those image/profile/limit settings, wait for API readiness, upload 20 unique envelopes at each text size, and collect approximately every 14 seconds using `docker stats --no-stream` and the cgroup counters. For the disk experiment, add 2,000 unique files per size using all query options in `packages/ipfs/README.md`, with four concurrent uploads and Kubo offline. The following read-only commands use placeholder container names supplied by the experiment:

```sh
docker stats --no-stream "$FIXTURE_NODE" "$FIXTURE_PROXY" "$FIXTURE_KUBO"
docker exec "$FIXTURE_KUBO" cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events
docker exec "$FIXTURE_KUBO" ipfs repo stat
docker exec "$FIXTURE_KUBO" du -sk /data/ipfs
```

Selected installed directories occupied approximately 280 MiB in the existing Node image, 86 MiB in pinned Kubo, and 58 MiB in pinned Caddy. These are approximate installed-file measurements, not compressed download sizes or the whole Docker store; shared layers, retained image versions, and build cache change total host disk use. Reserve 1–2 GiB for service images and updates within the host allowance below. The much larger Foundry/Anvil test image is unnecessary on the runtime host.

## A practical memory budget

These are engineering allowances for initial testing, not measured minimums or hard container limits:

| Component | Initial RAM allowance |
| --- | --- |
| Lean Linux host and Docker | 250–400 MiB |
| Node application, including short health-probe processes | 100–200 MiB |
| Caddy | 40–80 MiB |
| Small Kubo with bounded resources | 256–512 MiB |
| Total before extra reserve/builds | Approximately 650–1,200 MiB |

A 1 GB host can fit the lower end, but needs real host measurements. A 2 GB host leaves space for bursts and maintenance. Do not read image size as RAM use. A container-only benchmark also excludes the host and cannot validate an entire 512 MiB VM. Build/update peaks have not been measured; build images on a separate machine/CI from the reviewed repository revision, or schedule builds while services are stopped. Building elsewhere does not remove the need for runtime headroom.

Kubo's general guidance recommends 6 GB and two CPU cores for optimal performance, and explicitly discusses constrained devices. It warns that inadequate resources can impair announcements and availability. That guidance is broader than this workload; it is not evidence that a small publisher permanently consumes 6 GB. [Kubo requirements](https://github.com/ipfs/kubo#minimal-system-requirements)

## Cheaper ways to operate Kubo

**Keep one Kubo on the same VM.** This avoids paying for a second host and uses the existing private Compose connection. Kubo hosts selected content, rather than downloading the entire IPFS network. Start with the pinned release and measure normal operation before making multiple tuning changes.

**Use its supported `lowpower` profile when useful.** In 0.43.0, it selects client routing, turns off NAT/relay services offered to others, and sets connection watermarks to 20/40. Those watermarks are not absolute connection caps. Content discovery can be slower. The profile leaves content announcements enabled; old instructions claiming otherwise describe earlier releases. Keep the existing `server` profile's public-server network filtering when combining profiles. [Exact profile implementation](https://raw.githubusercontent.com/ipfs/kubo/v0.43.0/config/profile.go), [announcement behavior changed in 0.31](https://github.com/ipfs/kubo/blob/master/docs/changelogs/v0.31.md)

**Distinguish three memory controls.** `GOMEMLIMIT` is a soft target for Go-managed memory; it can be exceeded and does not cover everything charged to a container. A smaller target can increase garbage-collection CPU. Docker's memory limit is a hard container boundary and can trigger termination; reserve headroom between them. [Go memory guidance](https://go.dev/doc/gc-guide), [Docker limits](https://docs.docker.com/engine/containers/resource_constraints/)

`Swarm.ResourceMgr.MaxMemory` covers libp2p resources, not the entire daemon. The experiment uses 128 MiB for this setting, `GOMEMLIMIT=320MiB`, and a 512 MiB Docker limit. These are test settings, not changes made to production Compose. Keep accelerated DHT disabled for this workload. Avoid disabling announcements or relying on HTTP-only routing for the sole publisher. The 0.43 documentation calls `lowpower` a legacy profile that modern Kubo often does not need. [Pinned configuration reference](https://raw.githubusercontent.com/ipfs/kubo/v0.43.0/docs/config.md)

For an existing repository, changing `IPFS_PROFILE` in Compose is insufficient: the image applies initialization profiles to a new repository. Applying a profile or resource setting to an existing repository is a deliberate configuration change followed by restart. [Container initialization](https://raw.githubusercontent.com/ipfs/kubo/v0.43.0/bin/container_daemon) Validate retrieval from a genuinely separate network before adopting tuning. Swap can cushion short host spikes but should not be used to justify sustained memory pressure.

## Storage growth

Every upload uses `pin=true`. Small envelopes fit in a single raw IPFS block under the [fixed import recipe](../../packages/ipfs/README.md). For printable ASCII without JSON escapes, the serialized envelope adds **212 bytes** to the text: signer, signature, field names, and punctuation. Escapes add bytes, so 8 KiB of text is not a universal 8.4 KiB envelope ceiling. The HTTP body bound also applies.

The following table counts unique envelopes and shows logical payload only, in GiB per year (365 days). It excludes filesystem allocation, pin/index metadata, cached content, logs, backups, and OS/images.

| Unique messages/day | 256-byte text | 1 KiB text | 8 KiB text |
| --- | ---: | ---: | ---: |
| 100 | 0.016 | 0.042 | 0.286 |
| 1,000 | 0.159 | 0.420 | 2.857 |
| 10,000 | 1.591 | 4.202 | 28.568 |

Formula: `messages_per_day × 365 × serialized_envelope_bytes / 2^30`. This is a storage scenario, not a claim that this serial transaction publisher can sustain every listed rate. At 10,000/day, mean end-to-end operation time must be below 8.64 seconds even before allowing for bursts or downtime.

Actual disk allocation was larger than payload size. On the fresh default repository, 2,000 files with 1 KiB text grew `du` from 108 to 20,752 KiB; a further 2,000 with 8 KiB text grew it to 53,512 KiB. Marginal allocation was **10.32 KiB/file** and **16.38 KiB/file**, including filesystem and repository metadata. Corresponding `repo stat` sizes were 20,333, 7,441,897, and 25,242,712 bytes. This demonstrates why logical payload and repository estimates are insufficient as filesystem-capacity measurements.

Extrapolating those small batches gives roughly **0.36–0.57 GiB/year at 100/day**, **3.6–5.7 GiB/year at 1,000/day**, and **36–57 GiB/year at 10,000/day**, for the tested 1–8 KiB text range. These are allocation estimates, not linear-growth guarantees: indexes, compaction, inode layout, and a different datastore/filesystem can change them. For the starting workload, allow about **1 GiB per year** for unique retained messages and metadata until actual growth is established; backups are additional.

Identical envelope bytes retain one content-addressed object while each submission still creates another Ledger transaction and result log. Different signatures or text can produce different CIDs. An upload can remain pinned even if later Ledger logging fails, so size retention by distinct uploads rather than successful receipts alone.

`StorageMax` is a garbage-collection threshold, not a hard disk quota; automatic collection also requires enabling it. Pins are retained, so garbage collection cannot implement indefinite pin retention within a fixed disk budget. [Kubo storage configuration](https://raw.githubusercontent.com/ipfs/kubo/v0.43.0/docs/config.md), [pinning and persistence](https://docs.ipfs.tech/how-to/pin-files/)

Allow roughly 5–8 GiB for Linux, Docker, images and maintenance, plus retained data and 20–30% free space. These are planning allowances, not measurements of a particular cloud image. A 25 GB disk is a reasonable starting size; a 10 GB disk is possible only with tighter housekeeping and less margin. Keep backups off-host, and leave temporary room for the documented cold backup if writing its archive locally.

The three Compose services each rotate Docker logs at 10 MB × 3 files: approximately 90 MB combined, plus logging metadata and separate host journals. Caddy certificate/configuration volumes are small at one hostname but must persist. Neither log rotation nor IPFS GC removes old Docker images/build caches. Check free bytes and inodes as the pin count grows.

## US hosting options

Prices checked 2026-09-23, before taxes, backups, domain, RPC service, and transaction fees. Choose a US region with the selected plan available. These are regular Linux VMs suitable for the existing Compose deployment.

| Provider/plan | RAM | SSD | Base monthly cost | Role |
| --- | ---: | ---: | ---: | --- |
| Akamai/Linode Nanode | 1 GB | 25 GB | $5 | Lowest verified US candidate in this comparison |
| DigitalOcean Basic | 1 GiB | 25 GiB | $6 | Monitored small-node pilot |
| Lightsail Linux with IPv4 | 1 GB | 40 GB | $7 | Same pilot, more included disk |
| DigitalOcean Basic | 2 GiB | 50 GiB | $12 | More operating margin |
| Lightsail Linux with IPv4 | 2 GB | 60 GB | $12 | More operating margin |

Sources: [Akamai North America pricing](https://www.akamai.com/cloud/pricing/north-america), [DigitalOcean](https://www.digitalocean.com/pricing/droplets), [Lightsail bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html). The $4 DigitalOcean plan has 512 MiB RAM and 10 GiB SSD; saving $2 over its 1 GiB plan sacrifices substantial margin. European Hetzner entry prices do not answer the requested US deployment.

## Managed IPFS alternatives

**Filebase is worth a compatibility trial, but is not yet a verified replacement.** It documents authenticated `/api/v0/add` and `/api/v0/cat`; our node already supports an IPFS endpoint and authorization header. However, Filebase's add documentation lists only a subset of our required import parameters. Test exact CIDs, bytes, pin retention, failures, and independent retrieval before adopting it. The current Compose dependency on local Kubo would also need adjustment. [Filebase RPC API](https://filebase.com/docs/ipfs/rpc-api)

Its pricing page lists Pro at $7.50/month for 500 GB pooled storage, unlimited pinned files, and 250 GB IPFS egress; additional IPFS storage/egress is $0.015/GB. A $6 app VM plus that plan totals $13.50 before extras, so it is primarily an operations/storage choice rather than a clear saving over a small VM running both services. Free has a 500-file limit: five days at 100 unique files/day. Its public pages disagree about free IPFS bandwidth, so confirm account terms rather than budget around free bandwidth. [Current Filebase pricing](https://filebase.com/pricing/), [different free-tier description](https://filebase.com/free/)

**Pinata is another managed option.** Its published Free tier has 1 GB and 500 files; Picnic is $20/month. Uploads use its own API, so supporting it requires an adapter and CID conformance tests. A remote pin-by-CID call cannot replace uploading bytes when no reachable node already has the data. [Pinata pricing](https://pinata.cloud/pricing), [upload API](https://docs.pinata.cloud/api-reference/endpoint/ipfs/pin-file-to-ipfs)

Remote storage moves operational responsibility and availability dependence to a provider. Confirm actual data location if the US requirement extends beyond the VM; a US application server does not establish the residency of managed storage or copies on public IPFS. Sharing one Kubo among several future application instances can amortize its baseline, but introduces a shared dependency and needs per-instance authentication/accounting.

## Decision and scaling criteria

For the stated workload, evaluate a **1 GB US VM at $5–7/month** with Kubo on the same host, using client routing and validated resource settings. Choose **2 GB at $12/month** for more operating margin. The research does not establish a need for a $24/month 4 GB plan, nor certify 512 MiB for production.

Before depending on the smaller VM, run a 48–72 hour pilot including publication bursts, restart, backup/restore, and retrieval from another network. Observe host available memory, container peaks/OOM events, CPU, network transfer, disk bytes/inodes, and completed content announcements. Use the approved synthetic/test environment for paid-transaction simulations. Practical initial escalation triggers are repeated OOMs, sustained low host memory or swapping, growing announcement backlog, or disk usage above 70–80%; these thresholds are operating choices, not vendor guarantees.

At 1,000/day, remeasure latency and storage growth before changing RAM solely because of the count. At 10,000/day or bursts, the application's single active transaction may become the first bottleneck. Do not start multiple containers with the same signing account to scale around it. Vertical resizing needs a drain/backup/reconciliation window. DigitalOcean supports CPU/RAM-only resizing; increasing its disk cannot later be undone by shrinking it. Lightsail scales up by creating a larger instance from a snapshot. [DigitalOcean resizing](https://docs.digitalocean.com/products/droplets/how-to/resize/), [Lightsail resizing](https://docs.aws.amazon.com/lightsail/latest/userguide/how-to-create-larger-instance-from-snapshot-using-console.html)

No production configuration, dependency, or cloud deployment was changed by this research.
