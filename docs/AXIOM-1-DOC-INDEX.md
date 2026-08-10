# AXIOM-1 document index

**Verified at:** branch `integrate/dev-hh3`, PR [#62](https://github.com/YellowJacketTour/robinwood-plank/pull/62) into `dev` (**mergeable**), Hardhat 3.
**Status of the system:** 913 tests passing / 0 failing; never deployed to
any network; never independently audited. Contracts are byte-identical to
the earlier `feat/cvi-sota-axiom-1` (PR #61, not mergeable — toolchain
conflict) audited state; only the test/build toolchain changed.

---

## Start here

| Doc | Purpose |
|-----|---------|
| **BULLISH-HANDOFF.md** | **Read this first.** The master handoff: what the system is, its architecture and the reasoning behind it, its security posture, **the open risks**, what an auditor should attack first, the repo map, and the deployment gate. Everything else is detail beneath it. |

## Current, authoritative

| Doc | Purpose | Relationship |
|-----|---------|--------------|
| DESIGN-HONEST-INDEX-2026-08-09.md | Canonical design authority — two-door redemption, realizable-value pricing, predicate vaults, `R ≤ C` weight, EIP-170 constraint. | Supersedes **all** earlier design docs. |
| AUDIT-2026-08-09-FULL-SOLIDITY.md | The full Solidity audit of commit `1525597`: 6 CRITICAL / 8 HIGH / 5 MEDIUM, the PoCs, the remediation table, the NFTX-D2 strategic finding, the meta-finding on hollow tests, and the external research basis. | Findings marked remediated on this branch; **the remediation itself is unaudited.** |
| SLITHER-TRIAGE-2026-08-09.md | Every static-analysis finding on the post-redesign code, with the argument for dismissing it, so a reviewer can challenge the reasoning rather than repeat it. | **Its "Toolchain note" is superseded by BULLISH-HANDOFF.md §5.2**: a whole-project run *does* complete via `python -m slither .` (the crash is specific to the `slither` console script). |
| AXIOM-1-AS-BUILT.md | Plain-language as-built summary of the delivered system. | Current, with one stale figure: it cites **809** passing; the suite is at **913**. Numbers of record are in BULLISH-HANDOFF.md §2. |
| BULLISH-AXIOM1-RUNBOOK.md | Deploy runbook: verified genesis constants (and the drift found against the old template), real operator commands and env-var names, soak checklist. | Network / Addresses / Incidents deliberately blank — **nothing has been deployed.** |
| TEST-MATRIX-AXIOM-1-ADVERSARIAL.md | The adversarial/invariant matrix the suite is built against. | Written 2026-08-08, i.e. **before** the honest-index redesign. Its §7 "PM-1 mintSingleAsset disabled in pure flag" and its gas targets predate the current design; treat it as coverage intent, not as a current spec. |
| GAS-SNAPSHOT-AXIOM-1.md | Measured `route()` gas on local Hardhat. | Local figures only — cost *ordering*, not absolute mainnet cost. |
| SPEC-AXIOM-1-ENERGY-BUS-AND-ADAPTERS.md | Energy Bus / adapter spec. | Carries a retirement notice. **Its parameter section is superseded** — the live constants are in BULLISH-AXIOM1-RUNBOOK.md, read from source. Do not take `W_MAX_BPS` or the `MAX_IMPACT_BPS` guard from it; both are gone from the contracts. |
| mockups/index-fund-marketing/index.html | Visual/marketing brief (also `public/x/iv.html`). | **Contains superseded terminology (`xToken`).** Not a design source. |

---

## Retired planning history

Everything below predates the honest-index redesign and describes a system
that was **not** built as written. None of it is a design source. Read it
only as historical context for *why* the current design exists.

**Carrying an explicit retirement/supersession notice:**

- DESIGN-CVI-SOTA-VAULT-OF-VAULTS-2026-08-08.md
- DESIGN-DIAMOND-UNIFIED-ARCHITECTURE.md
- DESIGN-MAXIMAL-COMPOUND-EV-2026-08-08.md
- ONESHOT-OPUS-AXIOM-1-BULLISH-DELIVERY.md
- HANDOFF-BULLISH-FULL-2026-08-06.md
- ARCHITECTURE_MAP.md

**Retired but carrying no retirement notice of their own** — each does say
"design only" / "does not authorize deploy" in its header, but none points
forward to the current design, so a reader can mistake them for live specs.
**Treat every one of these as superseded by DESIGN-HONEST-INDEX-2026-08-09.md:**

- DESIGN-AUDIT-AXIOM-1-2026-08-08.md
- DESIGN-AXIOM-0-NESTED-CLAIM-LATTICE-2026-08-08.md
- DESIGN-AXIOM-1-AUTOGENESIS-COMPOUNDING-MACHINE-2026-08-08.md
- DESIGN-CAKE-EAT-IT-SHARE-ATOM-2026-08-08.md
- DESIGN-COLLECTION-VAULT-NATIVE-LP-AND-ZAP-MINT-2026-08-08.md
- DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md
- RESEARCH-ORACLE-FREE-MAXIMUM-VISION-2026-08-08.md

---

## Superseded terminology — do not use as live concepts

The following appear in retired docs and in the marketing mockup, and
describe things that **do not exist in the shipped contracts**:

| Term | Reality |
|---|---|
| `xToken` | Deleted. There is no separate compounding wrapper token. |
| `InventoryStake` | Deleted. There is no staking token and no staking step — holding the vault share `S` *is* the compounding position. |
| A vault keyed by `collection` alone | A vault is `(collection, merkle predicate)`. The predicate is immutable at creation. |
| `W_MAX_BPS = 2500` | Removed from the contracts. Concentration is capped by measured **exit capacity** (`EXIT_HAIRCUT_BPS = 1,000`), plus `ROBINWOOD_FLOOR_BPS = 810`. |
| `MAX_IMPACT_BPS` as a live slippage guard | The guard was **deleted, not repaired** (audit C-2). Live bounds are `MAX_LEG_POOL_FRACTION_BPS = 200` and `QUOTE_TOLERANCE_BPS = 50`. |

---

## Non-AXIOM-1 docs in this folder

`DEPENDABOT_INMOTION.md`, `DEPENDENCY-STATUS.md`, `INMOTION_DEPLOYMENT.md`,
`RELEASES.md`, `RELEASE_NOTES-2026-07-30.md`, `README.md`,
`TRADE_PAGE_SPEC.md`, `WALLET_REOWN_EVALUATION.md`, `api-audit.md`,
`design-md-audit.md`, `design-md-tokens.md`, `learn-content-audit.md`,
`learn-redesign-plan.md`, `surface-contracts.md`, `marketplank/` — frontend,
infrastructure, and dependency concerns. Out of scope for the AXIOM-1
contract handoff.
