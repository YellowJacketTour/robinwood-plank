# Grok findings: standing up OPI without compromising legitimacy

Response to `GROK-RESEARCH-BRIEF-ordinals-node-offload-2026-08-24.md`, received 2026-08-24. Preserved verbatim for the record; see that file for the original brief/context.

---

**Research brief: standing up OPI without compromising legitimacy**
Date basis: 2026-08-24. Sources are current pricing pages, OPI's own docs, Contabo/Hetzner ToS, ViewBlock Arweave stats, and GitHub. Unverified items are marked.

## 1. Cheapest legitimate way to run full OPI (Bitcoin Core + ord + Postgres)

**Official OPI requirements (first-party):**
OPI Full Node: ~1.5 TB disk, ~16 GB RAM (includes Bitcoin full node).
Bitcoin Core must run with `-txindex=1`; pruning is incompatible with the ord/OPI path documented in `INSTALL.ubuntu.md`.

**ToS reality (critical):**

| Provider | Bitcoin full node allowed? | Notes |
|----------|----------------------------|--------|
| Contabo | Yes (explicit) | Dedicated Bitcoin Node product page; PoW mining banned on VPS only; nodes allowed on VPS/VDS/dedicated. |
| Hetzner | Risky / historically no | 2022 support: nodes, blockchain storage, trading banned under crypto policy. Current published ToS emphasizes mining/farming/plotting; enforcement on pure full nodes remains ambiguous. Many operators avoid Hetzner for BTC nodes. |

**Practical cost band (storage-heavy, 2026 prices):**

| Option | Approx. monthly | Spec sketch | Fit for OPI |
|--------|-----------------|-------------|-------------|
| Contabo Storage VPS (e.g. 1.8-3.2 TB SSD) | ~€14-€34 | High TB, modest CPU/RAM | Disk OK; pair with higher-RAM Cloud VPS or use larger Storage plan. I/O is weaker than dedicated NVMe -- IBD will be slow. |
| Contabo Cloud VPS L / XL | ~€18-€30 | 30-60 GB RAM, 400-700 GB NVMe | RAM good; disk short -> add Storage VPS volume or move to dedicated. |
| Contabo VDS / dedicated Bitcoin configs | ~€30-€50+ | Explicitly marketed for BTC nodes | Cleanest "allowed + enough disk" path. |
| Hetzner AX Limited (e.g. AX41-1-LTD) | ~€57 | 64 GB RAM, dual NVMe (~1 TB raw) | Hardware good; ToS risk for Bitcoin node. |
| Hetzner AX with 2x1.92 TB+ NVMe (LTD/standard) | ~€77-€157+ | Adequate disk + RAM | Same ToS risk; better hardware. |
| DigitalOcean / Vultr block storage + compute | Higher ($50-150+) | Flexible volumes | Allowed with care; more expensive per TB. |

**Honest recommendation for legitimacy + cost:** Contabo is the clear first choice among major budget hosts because they advertise Bitcoin node hosting. Target ≥1.5-2 TB usable SSD + ≥16-32 GB RAM. Expect roughly €30-50/mo for a workable box if you size storage correctly; cheaper Storage-VPS-only setups may struggle on IBD I/O.

Bootstrap with OPI's GitHub Release Postgres dumps (e.g. tags like `snapshot_20260204_...`) to skip weeks of index compute; storage footprint after restore remains ~full size.

**Confidence:** High on Contabo allow-list and OPI ~1.5 TB / 16 GB; medium on exact Contabo plan SKUs (confirm live configurator). Hetzner "works until support notices" is not a legitimate strategy.

## 2. Cheaper / smaller "Ordinals-only" path?

| Approach | What it solves | What it does not solve | Verdict |
|----------|----------------|----------------------------|---------|
| OPI main module only (skip BRC-20 / Runes / Bitmap / SNS) | Less Postgres growth | Bitcoin chain + ord RocksDB still dominate (~1+ TB). Savings real but secondary. | Worth doing if you only need inscription identity/transfers; does not fix the 1.5 TB problem. |
| OPI Light Client (OPI-LC) | ~30-50 GB, ~1 GB RAM; no full node | BRC-20 event validation only, via OPI Network hashes. Not a catalog of NFT/collectible inscription content, metadata, or ownership history. | Wrong tool for Marketplank's NFT collection use case. |
| Pruned Bitcoin Core + lightweight inscription tracker | Smaller chainstate | Inscription content lives in witness data. Historical inscriptions need historical blocks; pruning discards them. Bitcoin Core still treats txindex + prune as incompatible for the access pattern ord needs. | Dead end for complete historical inscription indexing with current ord/OPI. |
| Third-party lean indexers | Possible smaller footprints | No production, open, NFT-complete alternative to ord/OPI found that avoids full chain + large index while staying vendor-independent. | Unverified as of this search. |

**Bottom line:** For canonical, vendor-independent inscription + transfer + ownership data, you still need full non-pruned Bitcoin + an ord-class index. Skipping meta-protocol modules helps Postgres only. OPI-LC is the wrong product for NFT catalogs.

**Confidence:** High on OPI Full vs Light scope and on prune/txindex constraint; medium on exact Postgres savings from stripping modules (not published as a single number).

## 3. Community-run public OPI / ord mirrors

- opi.network shows a network of indexers ("13 indexers reporting") for BRC-20 / related protocols -- a hash-verification network, not a free public SQL/API dump of full inscription state for arbitrary apps.
- No verified, ongoing, free, publicly queryable full OPI Postgres or ord API suitable as a drop-in Marketplank backend was found in current docs or recent X traffic from OPI/Best in Slot, ord maintainers, or major Ordinals wallets.
- Commercial / tiered APIs (Best in Slot, Xverse, etc.) remain the alternative; they are not self-hosted legitimacy and often gate the exact fields you care about (floors, listed counts) behind paid tiers.

**Confidence:** Medium-high that no generous free full-OPI mirror exists as a primary data plane; low that a quiet community instance exists unannounced.

## 4. Snapshot distribution (Arweave / IPFS / torrent)

- OPI already ships GitHub Release dumps -- the practical bootstrap path.
- Arweave cost (live ~2026-08-24): storage cost ≈ 12 AR/GiB; AR ≈ $2.27 -> ≈ $27/GiB one-time. **1.5 TB ≈ 1,536 GiB ≈ ~$41,000 one-time. Unusable for full node snapshots.**
- Reasonable Arweave use: small derived artifacts only (e.g. collection registry exports, verified collection ID lists), not the chain or full ord index.
- IPFS / torrents: sensible for community redistribution of OPI's own dumps if you host a mirror after you have a node; no evidence OPI officially mirrors dumps to Arweave/IPFS as of this research.

**Confidence:** High on Arweave pricing math; high that full-snapshot-to-Arweave is economically irrational.

## Prioritized options (implementable)

1. **Contabo-sized full OPI** (recommended if self-host is the goal) -- ~€30-50/mo class once disk+RAM are adequate; high complexity; solves true vendor-independent inscription index; does not solve local disk or ongoing ops burden. Confidence: high.
2. **Stay on marketplace feeds + optional paid indexer API** -- $0-Pro tier; low complexity (already wired); solves listings/floors where vendors expose them; does not solve canonical/complete record. Confidence: high.
3. **OPI main-module-only on Contabo** -- marginal storage win, same Bitcoin+ord bulk. Confidence: medium.
4. **OPI-LC** -- reject for NFT catalog use case. Confidence: high.
5. **Hetzner dedicated** -- hardware competitive; ToS risk for BTC nodes. Confidence: high on risk history.
6. **Arweave full snapshot** -- reject on cost (~$40k). Confidence: high.

## Open numbers still null (do not invent)

- Exact current size of OPI Postgres only (main module) after full sync.
- Exact free vs paid surface of Best in Slot Basic vs Pro for listed_count / multi-marketplace floors (confirm on live docs).
- Whether Xverse offers a true free API key tier vs Lightning-only (confirm on docs.xverse.app + account signup).
- Whether any private Discord/community runs an open OPI read replica.

**Net:** The only path that matches "first-party, complete, legitimate Ordinals index" is a Contabo-class (or similarly crypto-node-friendly) host with ≥1.5 TB + ≥16 GB RAM running full OPI, bootstrapped from official dumps. Everything cheaper either fails ToS legitimacy, fails completeness, or is the wrong product (OPI-LC). Marketplace APIs remain the correct stopgap until that box exists.
