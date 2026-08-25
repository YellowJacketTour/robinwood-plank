# Grok findings: capstone research on unified cross-chain indexing (2026-08-25)

Response to `GROK-RESEARCH-BRIEF-unified-global-indexing-2026-08-25.md`.
Preserved verbatim below. See the bottom for the synthesized recommendation.

---

**Capstone findings: unified cross-chain indexing under free-tier constraints**

---

## 1. Is there a real "universal" blockchain indexing abstraction?

### Verdict: **Shared control plane, chain-specific extractors -- not one decoder**

Production systems that work at scale do **not** collapse EVM logs, Solana accounts, and Bitcoin UTXO spends into one physical event parser. They share **orchestration, storage, and query** while keeping **extract adapters** chain-native.

| System | What is unified | What stays chain-specific |
|--------|-----------------|---------------------------|
| **The Graph** | Graph Node store (Postgres), GraphQL, indexer agent, Horizon "data services" | Network endpoints, Firehose/Substreams vs RPC, mapping ABIs per chain |
| **Envio HyperIndex** | TypeScript handlers, schema, multi-chain config | HyperSync only where supported; else RPC; event shapes per contract |
| **Goldsky** | Streaming pipeline (Flink/Redpanda), customer DB delivery | Direct ETL vs subgraph WASM per source |
| **Ponder** | TS handlers + SQL/GraphQL | EVM-oriented; historical path is RPC-bound |

Independent benchmarks (Sentio OBIB / Envio-promoted Uniswap V2 factory) show **HyperSync-class bulk extract** dominates backfill speed; subgraph/RPC paths lag by 10-150x. That advantage is **EVM-log shaped**. Solana (`getProgramAccounts`, geyser) and Bitcoin (UTXO + witness + mempool) are different physical APIs.

**Practitioner pattern (not an anti-pattern):**
*Universal = cursor + reorg policy + idempotent write + coverage labels.*
*Not universal = log topics vs account discriminators vs inscription spends.*

Your codebase already matches the proven shape: HyperSync dual-cursor scanners per protocol, Solana GPA/logs, Bitcoin settlement via mempool.space -- then shared Postgres legs (`plank_market_event_*`).

**Classification:** Adopt proven pattern as-is (shared mesh + per-chain extractors). A single "decode any chain" engine is a known fantasy that real teams avoid.

---

## 2. Verifiable indexing without a trusted operator

### Space and Time / Proof of SQL, Axiom, Lagrange, Herodotus

| Tech | What it proves | Fit for Marketplank today |
|------|----------------|---------------------------|
| **Proof of SQL (SXT)** | Query result + table commitments match committed index | Needs their network/validators/provers; not a drop-in on one InMotion box |
| **Axiom** | Ethereum historical state/logs/slots | Narrow, paid-ish proving; Ethereum-centric |
| **Lagrange / Herodotus** | Provable DB / storage proofs for contracts | Preprocessing heavy; multi-chain still infra-heavy |

These are real and maturing, but they solve **"smart contract can trust a query result"**, not **"small free-tier aggregator builds a complete NFT book on one VPS."** Indexing still happens off-chain; the novelty is cryptographic commitment + proof of query. Running validator/prover stacks or paying per proof is outside free-tier-first + single-instance constraints.

**Honest verdict:** Research-grade / specialized infra for 2026 free-tier Marketplank.
**What you can adopt without their stack:**

- **Fail-closed + source chips** (you have this).
- **Deterministic extractors + content-addressed job outputs** (hash of normalized fill rows).
- **Optional later:** publish Merkle roots of daily fill tables to a cheap public log -- **not** full Proof of SQL.

**Classification:** Do not adopt SXT/Axiom as core. Adapt the *idea* of commitments as optional audit artifacts only.

---

## 3. Historical backfill on free infrastructure

| Chain family | Best free/cheap prior art | Your position |
|--------------|---------------------------|---------------|
| **EVM** | HyperSync (Envio) bulk filtered logs -- industry leader for speed | Already strongest lane |
| **Solana** | Public RPC + GPA snapshots; DAS for assets; no HyperSync equivalent for free full history | Tensor GPA + logs + DAS pool is the right free approach; history stays thinner |
| **Bitcoin** | mempool.space API, electrs/fulcrum (need node), ord index (heavy) | Settlement scan + UniSat free path; full inscription history needs OPI-class storage (ruled out) |

There is **no free Solana/Bitcoin analogue of HyperSync** that delivers years of marketplace history in minutes on public tiers. Yellowstone gRPC is excellent but assumes a node or paid provider.

**Practical maxim:**
Backfill **depth where free bulk extract exists (EVM HyperSync)**; for Solana/Bitcoin, prioritize **forward completeness + targeted historical windows** (viewport/demand-driven), not genesis-to-tip on free RPC.

**Classification:** Keep EVM HyperSync path; adapt "demand-gated historical depth" for Solana/Bitcoin (ties to viewport brief).

---

## 4. Real-time freshness without infrastructure spend

**Confirmed limitation:** Most free tiers are **pull**, not push. Helius webhooks, etc., are paid or quota-gated. Public Solana/Bitcoin RPCs do not give you a free global "notify me of every NFT sale" stream.

**Prior art that fits free pull:**

- **Adaptive polling + coalescing** (your `singleflight-cache` + `freshness-budget`) -- correct.
- **Idle / viewport prioritization** (Quicklink-style attention) -- open design in your viewport brief.
- **Cursor continuity** -- never restart full scans; dual-cursor / checkpoint in Postgres (you already do this on HyperSync scanners).
- **Mempool as weak real-time** (Bitcoin): mempool.space free API for pending spends -- probabilistic, labeled.

**Not available free:** Kafka/Redpanda-style always-on streams (Goldsky's internal architecture assumes paid infra).

**Classification:** Adopt your FBC + singleflight as the production pattern; add visibility demand scheduling; do not invent a free global webhook layer that does not exist.

---

## 5. Novel synthesis: **Unified Extract-Normalize-Attest Mesh (UENAM)**

No off-the-shelf "free-tier NFT multichain indexer" product matches your niche (between full node and Goldsky/Dune). Synthesis below is **new packaging** of known patterns for *this* constraint set.

### Core model (first principles)

Treat every chain as:

```text
Append-only observations -> Finalized facts -> Labeled uncertainty
```

| Stage | Meaning | Storage |
|-------|---------|---------|
| **Observation** | Raw extractor output (log, GPA account, UTXO spend) | Optional short retention / job payload hash |
| **Fact** | Normalized fill / listing / collection membership after deterministic decode | Existing `plank_*` tables |
| **Uncertainty** | `confidence`, `source`, `coverage` | Registry + row-level columns you already use |

Reorg policy: EVM/Solana use tip distance / commitment level; Bitcoin uses confirmations. Same **control** code, different **parameters** per adapter.

### Shared control plane (build once)

```text
mesh/
  cursor_store          -- chain, lane, cursor blob (Postgres)
  job_queue             -- existing enqueueDataJob + priority bands
  source_budget / jail  -- existing
  singleflight + FBC    -- existing live path
  coverage_registry     -- venue-registry + capability cells
  normalize()           -- map chain facts -> shared event legs
```

### Extract adapters (keep / extend -- do not merge into one decoder)

| Adapter family | Status | Notes |
|----------------|--------|-------|
| HyperSync EVM protocol scanners | Mature | Template for all EVM books |
| Solana GPA + logs (Tensor, etc.) | Built | Same mesh jobs |
| Solana DAS pool | Built | Metadata, not book |
| Bitcoin settlement (mempool.space) | Built | Labeled confidence |
| Bitcoin listings (UniSat free, etc.) | Partial | Opportunistic |

### What is genuinely new vs adapted

| Piece | Classification |
|-------|----------------|
| Shared mesh + per-chain extractors | **Proven** (Graph/Envio/Goldsky shape) |
| HyperSync-first EVM | **Proven** (adopt) |
| GPA listings without API key | **Adapt** known Solana pattern (you did) |
| Settlement-first BTC with confidence tiers | **Adapt** (honest heuristic) |
| FBC + singleflight on free quotas | **Adapt** adaptive TTL / coalescing |
| Viewport -> demand priority | **Adapt** Quicklink/attention scheduling |
| UENAM as named free-tier NFT aggregator architecture | **Novel synthesis** (packaging + honesty model) |
| Full zk Proof of SQL on one VPS | **Not adoptable** now |
| Decentralized SASL shard network | **Separate decision** (custody/incentive/trust) |

### What "unified completeness" means here

Same **standard of truth**, not same **depth**:

- Every number has `source` + `as_of` + coverage chip.
- Every lane has a cursor and reorg rule.
- Every gap is `partial` / `unavailable` / `planned`, never silently filled.
- Hydration priority follows **user attention + aging**, not only fixed cadence.

That is the achievable unified vision on one Postgres instance and free tiers.

---

## Concrete build order (value / effort)

| Priority | Work | Needs new money/custody? |
|----------|------|---------------------------|
| 1 | Finish **viewport visibility -> `prioritizeVisibleCollections`** (open brief) | No |
| 2 | **Normalize write path**: one helper mapping EVM/Solana/BTC facts -> shared event legs + confidence | No |
| 3 | **Cursor registry table** if not fully unified (chain, lane, cursor, updated_at) for all scanners | No |
| 4 | Extend Solana **forward** scanners (more programs as needed) via same GPA/log pattern | No |
| 5 | Bitcoin **settlement depth** + UniSat free book only; no OPI | No |
| 6 | Optional **daily Merkle root** of fill table counts/hashes for self-audit | No |
| 7 | zk/SXT/Axiom integration | **Yes -- separate decision** |
| 8 | Federated community indexers / staking | **Yes -- separate decision** |

---

## Direct answers to the five questions

1. **Universal abstraction?** Shared **mesh + policy + schema**; chain-specific **extractors**. Bespoke scanners are correct; unification fantasy is not.
2. **Verifiable indexing?** Real (SXT, Axiom, ...) but **not free-tier / single-box adoptable** as the core. Use honesty labels + optional commitments.
3. **Historical backfill?** HyperSync for EVM is state of the art; Solana/Bitcoin free history stays demand-scoped.
4. **Real-time on free tiers?** Pull + FBC + singleflight + visibility priority; no free global push bus.
5. **Novel synthesis?** **UENAM**: one control plane, N extractors, settlement-first where books are gated, attention-driven hydration, strict fail-closed coverage -- the architecture that matches production indexer *lessons* without production indexer *budgets*.

---

### One paragraph for the repo

Marketplank should not wait for a universal chain decoder or a zk warehouse. It should **double down on the architecture it already proved on EVM HyperSync**: deterministic extractors, dual cursors, shared Postgres facts, and explicit uncertainty -- then extend that **control plane** to Solana GPA/logs and Bitcoin settlement, schedule work by **what users actually see**, and refuse to fake parity where free infrastructure cannot prove it. That is the globally informed, constraint-honest path to a unified cross-chain index.

---

## Synthesized recommendation (Sonnet 5, 2026-08-25)

This is a strong, well-grounded result — it correctly identified that this
codebase already independently arrived at the proven production pattern
(shared mesh + control plane, chain-specific extractors) without having
been told that's what The Graph/Envio/Goldsky actually do. That's real
validation, not flattery: the architecture built across today's session
(HyperSync EVM scanners, Solana DAS/GPA/settlement, Bitcoin settlement
index, singleflight cache, FBC) matches real industry practice, not a
naive amateur pattern.

**Two items explicitly ruled correctly out of scope, not deferred:**
zk-proof-based verifiable indexing (Proof of SQL/Axiom/Lagrange) is real
technology but genuinely not adoptable on free-tier/single-instance
infrastructure today — this isn't a "someday" item, it's a "wrong tool for
this budget" verdict. Same for a federated community-indexer network
(SASL) — flagged as a separate decision requiring new trust/incentive
design, consistent with how it was already treated in the free-remedies
findings.

**What's actually actionable now, in order:**
1. Viewport visibility → demand priority (already spec'd in the companion
   findings doc, building now).
2. A shared normalize-write helper mapping EVM/Solana/Bitcoin facts into
   one consistent event-leg shape with confidence/source/coverage — this
   is genuinely new, real, scoped work worth doing as the connective
   tissue between the three chain families' otherwise-separate scanners.
3. A unified cursor registry table, if the three chain families' scanners
   don't already share one consistent cursor-tracking shape (worth
   auditing before building this — may already substantially exist).

Items 2 and 3 are real, valuable, no-new-resource follow-on work — noted
here for a future session rather than bundled into today's build, since
today's concrete deliverable is the viewport hydration system.
