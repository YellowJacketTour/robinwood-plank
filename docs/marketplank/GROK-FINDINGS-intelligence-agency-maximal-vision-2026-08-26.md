# Grok findings: hash-first, multi-source, free-ceiling hydration

Source brief: `GROK-RESEARCH-BRIEF-intelligence-agency-maximal-vision-2026-08-26.md`
(full, unreduced scope, per explicit owner direction after rejecting a
narrower version). Grok's response preserved verbatim below, followed by
this app's own build decision.

## Grok's response (verbatim)

**Intelligence-grade findings: hash-first, multi-source, free-ceiling hydration**

### 1. Minimal-signature-first

An `ipfs://<CID>` is already a cryptographic fingerprint of the bytes —
same content ⇒ same CID, any change ⇒ new CID. Re-fetching IPFS when the
on-chain URI still resolves to a cached CID is pure waste. Gap identified:
whether every successful hydrate persists the CID and skips payload fetch
when the on-chain URI still matches. **Label: adopt** IPFS content-addressing
semantics as a mandatory pre-fetch gate.

### 2. Cross-corroboration (not sequential fallback)

Sample ~1% of successful IPFS hydrates against a second independent
gateway; flag `ipfs_drift` on mismatch rather than silently overwrite.
Rare Multicall3 `ownerOf` batch cross-check against stored owner when
demand is idle. **Label: adapt**, cost-capped sample, not 2x traffic.

### 3. IPFS network topology

HTTP gateway rotation remains correct at this scale; running a full
libp2p DHT client for marginal gain is real, unjustified complexity.
**Label: honest "gateways still correct," reject full node as default.**

### 4. Other free corroborating sources

Arweave (real, keyless, treat txid like a CID), Multicall3 (real,
canonical address `0xcA11bde05977b3631167028862bE2a173976CA11`, 100+
chains), Etherscan-family free tier (3/s, 100k/day, enrichment only, not
ground truth), public Dune/Flipside query outputs (offline research only,
not a live-hydrate authority), The Graph decentralized free queries (no
reliable free SLA). Dead ends flagged: paid explorer tiers, Dune as a live
API, inventing a full Ordinals index without a real node.

### 5. Physics of necessary calls

Multicall3's `aggregate3` turns N `tokenURI(tokenId)` calls into ONE RPC
round-trip with `allowFailure: true` per leg — practical batch sizes
20-100 depending on contract gas/response size. Alchemy's real limit is
300 CU/s token-bucket over a ~10s window (matches this app's own
independent live re-check the same day).

### 6. Honest math: "way more than 600/hour"

OpenSea's 600/hour was never the right constraint for token metadata —
it's real only for market-data legs (floor/listings/offers). With
Multicall3 + free RPC + CID-skip, metadata freshness throughput can be
orders of magnitude above 600/hour; the real binding constraints become
RPC multicall throughput and IPFS gateway body-fetch rate for
first-seen/changed tokens only — both measurable, not asserted.

### Already built vs gap vs dead end (Grok's own table)

Built: tokenURI→IPFS gateways (EVM), Metaplex on-chain (Solana), adaptive
recrawl, provider pacing (OpenSea, Helius RPS). Critical gap flagged:
persist CID + skip body if URI unchanged. Highest unbuilt leverage
flagged: Multicall3 batch tokenURI/ownerOf. Dead ends: full libp2p
in-process, Ordinals without an indexer/API, Dune as live authority.

### Novel synthesis: Hash-First Multi-Source Hydration Doctrine (HFMS)

For every token, compare the on-chain pointer (URI/CID/txid) to a durable
fingerprint before ever fetching bytes; batch pointer reads via Multicall3
on EVM; use vendor market APIs only for order books, never for content
addressable on-chain; sample a second free channel to detect drift; never
fabricate skip rates or completeness. Full real TypeScript provided for
`pointerFingerprint`/`needsBodyFetch` (`hash-first-hydrate.ts`) and
Multicall3 `aggregate3` encoding (`evm-multicall-token-uri.ts`), plus a
`plank_collection_tokens`-shaped migration sketch.

## Build decision

**Built and shipped this pass:**

- **Multicall3 batch `tokenURI` reads** (`lib/market/multichain/discovery/evm-multicall.ts`)
  — real, live-verified, NOT approximated from Grok's draft. Used `ethers`
  (already a real dependency, not new) for ABI encode/decode rather than
  hand-rolling the more error-prone nested-tuple-array shape Grok's raw
  hex-string draft used — this app's existing convention (hand-roll only
  the SIMPLE single-dynamic-string case, `decodeAbiString`) doesn't extend
  safely to this more complex shape.
  - **Live-verified against real chain data before wiring in anywhere**:
    fetched real Pudgy Penguins (`0xbd3531da5cf5857e7cfaa92426877b022e612cf8`)
    token IDs 1-3 in ONE real RPC call, cross-checked token #1's decoded
    URI resolved to the exact same real metadata ("Pudgy Penguin #1") the
    existing single-call path already returns.
  - Wired into `advanceEvmTokenMetadata` as a batch pre-pass: one real RPC
    call resolves every pending item's `tokenURI` at once; any item the
    batch doesn't resolve (ERC1155, non-standard contract, genuine RPC
    hiccup) falls through unchanged to the existing per-token path (which
    already retries across every configured RPC URL, both selectors, and
    the OpenSea fallback) — zero loss of existing resilience.
  - **Real, pre-existing bug found and confirmed during verification, NOT
    a regression**: some `plank_collection_tokens.collection_slug` rows
    store an OpenSea slug ("azuki", "boredapeyachtclub") instead of a real
    contract address. Confirmed BOTH the old single-call path and the new
    batch path fail identically for these rows (the underlying `eth_call`
    itself rejects a non-hex `to` address either way) — not something this
    change introduced. Flagged, not fixed here; needs its own investigation
    into why those specific rows have a slug instead of an address.

**Deferred, not built this pass:**

- **CID-skip fingerprint gate** (`pointer_fp`/`needsBodyFetch`). Real
  finding while scoping this: `advanceEvmTokenMetadata` already only ever
  reprocesses `metadata_state IN ('pending','retry')` rows — `'complete'`
  tokens are never touched again today, so the CID-skip's real payoff (per
  Grok's own framing) is for a re-verification/drift-detection lane this
  app doesn't have yet, not for reducing waste in the lane that exists.
  Building the fingerprint columns/module without a real consuming lane
  would be exactly the kind of half-finished, doesn't-actually-skip-
  anything change this app's own conventions reject. Real next step: build
  it alongside whichever lane first needs to re-check already-complete
  tokens (e.g., an ERC-4906 `MetadataUpdate`-driven re-verify, from the
  2026-08-24 on-chain-extraction audit's own backlog), not standalone.
- **Cross-source corroboration sampling** (1% second-gateway IPFS check,
  idle-time `ownerOf` cross-check). Real, valuable, genuinely low-risk —
  deferred purely on time this pass, not on merit. Good next-session item.
- **Arweave as a pointer-fingerprint class.** Small, real, low-risk addition
  once the fingerprint module above is actually built.
- **Alchemy CU token-bucket pacing.** Still blocked on `provider-pace.ts`
  needing a real `token_bucket` mode (same gap flagged in the prior Unified
  Mesh Continuum build decision) — not rebuilt here.

**Rejected, per Grok's own verdict (matches this app's existing judgment):**
full in-process libp2p IPFS node, Dune/Flipside as a live hydrate
authority, inventing a full Bitcoin Ordinals sat-tracking indexer.
