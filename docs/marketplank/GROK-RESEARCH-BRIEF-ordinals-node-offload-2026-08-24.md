# Research brief for Grok: offloading a Bitcoin Ordinals full-node/indexer stack without compromising legitimacy

Status: **research brief, not a spec.** Hand this to Grok specifically because it has live X/Twitter search and broad forum access that this session's model (Sonnet 5) does not — use that advantage. Come back with real, cited, implementable options, not a summary of the first few generic results. Written by Sonnet 5 with direct, current, first-hand knowledge of this exact codebase and the research already done today, 2026-08-24.

## The problem, precisely

Marketplank (repo: `robinwood-plank`) is a multichain NFT marketplace tracking Bitcoin Ordinals collections among 11 chains. Its Bitcoin coverage today is five real, wired vendor/marketplace sources — UniSat, OrdinalsWallet, ord.net, Satflow (key requested, pending), OKX (keys requested, pending) — all of which are per-marketplace listing feeds, not a canonical, vendor-independent, complete record of every real inscription, its metadata, its transfer history, and its holder.

**OPI (Open Protocol Indexer, `bestinslot-xyz/OPI` on GitHub, Apache-2.0)** is the real, correct, self-hosted answer to that gap — already speced (not built) in this repo at `deploy/opi/README.md`, explicitly marked "planned, never silently promoted to complete." It requires:
- A full, non-pruned Bitcoin Core node with `-txindex=1` (pruning is incompatible with txindex) — confirmed real requirement via OPI's own `INSTALL.ubuntu.md`, no documented remote-RPC-only mode.
- Their `ord` protocol fork's own inscription index on top of that.
- OPI's own PostgreSQL tables (base index, plus optional BRC-20/Bitmap/SNS/Runes modules).

**Real, verified numbers gathered today**, not guesses:
- Bitcoin mainnet full chain + txindex: realistically **750–850 GB** in 2026, growing ~50–80 GB/year.
- `ord`'s inscription index on top: **100–300+ GB** given inscription volume by 2026.
- OPI's own Postgres tables: size not documented publicly (a real open question — see below).
- Combined realistic estimate: **1–1.5+ TB**, continuously growing.
- OPI's maintainers DO publish periodic pre-synced Postgres dump snapshots via GitHub Releases (`.sql.gz`, e.g. tag `snapshot_20260204_934907`) — confirmed real, this skips weeks of initial indexing COMPUTE time, but does not reduce the eventual STORAGE footprint once restored.

**The available local machine has ~27.7 GB free** (single drive, 1.9TB, 99% full) — nowhere close, confirmed via direct `df`/`Get-PSDrive` checks today. Any real solution needs either freed-up local space, a new dedicated drive, or a remote host.

## Already investigated and ruled out today, with real findings — don't re-litigate these unless you find a genuine correction

- **GitHub as a host**: real for one-time snapshot bootstrap downloads (see above), but Actions/repo storage/runtime limits make it structurally unsuitable for hosting a live, 24/7, multi-TB blockchain daemon. Not viable as the actual host.
- **Google Colab or similar ephemeral compute "workbooks"**: sessions are ephemeral (~12h typical, disk wiped after) — a full node must run continuously to stay synced. Structural dead end for hosting the live node itself, though possibly usable for a one-off batch job (e.g., processing a downloaded snapshot) if that angle turns out useful.
- **Mesh networks**: Bitcoin's own P2P network already IS a mesh (every full node, including a self-hosted one, participates in it). No existing way found to shard OPI's single logical Postgres index across a mesh of consumer devices — nobody's built that distributed-database layer for this specific software. Confirm or refute this with real evidence; don't just assert it's impossible if a real project has since solved it.
- **Arweave**: genuine fit for archiving IMMUTABLE data permanently (inscription content itself is immutable; a periodic OPI snapshot export could be archived there as a permanent, pay-once backup/distribution layer instead of/alongside GitHub Releases). NOT a live, queryable, continuously-mutable database replacement — Arweave is write-once storage, no SQL against it.
- **Xverse Ordinals API** (the real 2026 successor to Hiro's now-deprecated Ordinals API, `docs.xverse.app`): real and partially free, but structurally different — without an API key it runs on Lightning micropayments (pay-per-request), not a traditional free tier. Whether a genuinely free signup-gated key tier exists was NOT confirmed — worth you checking directly, including any X/Twitter posts from Xverse's own account about pricing/free-tier changes.
- **Best In Slot API** (`docs.bestinslot.xyz`): real, tiered (Basic/Pro/Dedicated). Confirmed the specific data this app wants (`listed_count`, `floor_price` aggregated across marketplaces) is gated to Pro tier, likely paid. Basic tier's real free scope (inscription metadata? rarity?) was not fully explored — worth checking.

## What this brief is actually for — the real open questions

### 1. Cheapest legitimate way to actually stand up OPI, if the owner decides to

Real cost research, not vibes: current (2026-08-24) pricing from storage-optimized VPS providers (Hetzner, OVH, DigitalOcean, Vultr, Contabo) for a box with 1.5–2TB usable SSD/NVMe storage, enough RAM (OPI/ord indexing is memory-hungry during initial sync — find the real recommended minimum), and enough CPU to keep up with ongoing chain growth without falling behind. Cite real, current prices — they change. Note which providers explicitly allow running a Bitcoin full node (some budget/shared hosts prohibit it in ToS) — real, cited ToS findings, not assumptions.

### 2. Does a genuinely cheaper/smaller "Ordinals-only" indexing path exist?

This app doesn't need BRC-20/Runes/SNS/Bitmap coverage today, only real NFT-collection inscription data (content, metadata, transfers, ownership). Research whether:
- A stripped-down OPI config (main module only, no BRC-20/Runes/Bitmap/SNS) meaningfully reduces the Postgres footprint, and by how much (real numbers if findable).
- A lighter-weight alternative to `ord`'s own reference-implementation index exists specifically for NFT/collectible inscriptions (not fungible-token protocols) that trades completeness for a smaller footprint — search recent (2026) GitHub activity and X posts from Bitcoin Ordinals infra builders (e.g. people who've worked on `ordinals-api`, `ord`, OPI, Electrs/Fulcrum forks) for anything newer/leaner than OPI itself.
- Whether Bitcoin Core's own pruning + a SEPARATE lightweight UTXO/inscription-only tracker (rather than full txindex) could work for this app's specific use case (NFT-style single-inscription-per-token tracking, not full historical BRC-20 balance replay) — this may be a real architectural shortcut nobody's cleanly documented, or may be a dead end because inscription content still requires witness data any pruned node discards. Find out which, with evidence.

### 3. Real community-run public OPI/ord mirrors this app could use as a stopgap

Does anyone run a real, publicly-queryable OPI/ord instance with generous or free access — not a commercial marketplace API, but a genuinely open community indexer instance? Check X/Twitter posts from verified Ordinals-ecosystem accounts (Casey Rodarmor/@rodarmor for `ord` itself, the OPI/Best-in-Slot team, Ordinals Wallet, Xverse, Magic Eden's Bitcoin team, Trac Systems, and similar) for any mention of a public/free-tier hosted OPI endpoint, a grant/sponsorship program for indexer hosting, or a decentralized/community-funded node-sharing effort. Cite real posts/threads, not paraphrases you can't source.

### 4. Snapshot distribution hardening

Given OPI's own GitHub Releases snapshot mechanism is real: is there a real, current practice (from OPI's own docs/Discord/X, or from similar projects) of ALSO mirroring these snapshots to Arweave, IPFS, or a torrent for resilience against GitHub rate-limits/outages/repo changes? If not, is this a reasonable thing for Marketplank to do itself once it has a working node (archive ITS OWN synced snapshot to Arweave periodically, both as a personal backup and a potential community contribution)? Estimate a real current Arweave storage cost for a ~1.5TB one-time permanent archive (Arweave pricing is pay-once; get a real current AR-token-to-USD estimate for this size).

## Non-negotiable invariants (same as this session's prior briefs)

- Never fabricate data. A missing number stays `null`, never estimated or interpolated to look complete.
- No paid vendor API subscriptions as the primary path — infrastructure hosting cost (a VPS) is a different, acceptable category from a recurring paid API subscription, but flag clearly which of your recommendations fall into which bucket.
- Real, first-party/self-hosted data preferred over third-party APIs wherever genuinely feasible — this is the whole point of pursuing OPI at all.
- Cite real, current (2026) sources for every cost/capability claim — pricing and product offerings in this space move fast; a 2023-2024-dated source is not good enough on its own without confirming it's still accurate.

## Deliverable format

A prioritized, cited list of real options (not a single recommendation dressed as many), each with: real current cost (if any), real setup complexity, what it does and does NOT solve, and your honest confidence level in the finding. Flag anything you could not verify as unverified, explicitly — do not present a plausible-sounding guess as a confirmed fact.
