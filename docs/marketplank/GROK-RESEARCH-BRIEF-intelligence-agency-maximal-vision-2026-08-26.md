# Research brief for Grok: intelligence-agency-grade research + Nikola-Tesla-grade invention — the full vision, every chain, every source, no ceiling

Status: **maximum-effort research + invention brief. No scope reduction.**
Written by Sonnet 5, 2026-08-26, at the owner's explicit direction after
rejecting a narrower brief as "absolutely unacceptable." Go as far as real,
buildable, honest engineering allows — exhaustive sourcing, first-principles
invention, zero self-imposed timidity. The only ceiling is reality itself:
free-tier infrastructure, real chain physics, and this app's own
never-fabricate rule (below). Within that ceiling, there is no cap on
ambition, scope, or the number of angles pursued.

## The owner's own words, verbatim, both asks combined

"do we have the most optimal efficiency on all api calls where if ever
possible all we scrape is identifying id hashes or other give away data and
then immediately network across any and all corroborating free sources like
ipfs and otherwise to pull together way more than say 600 per hour? if this
hasnt been considered in any angles we need a one shot for grok to do
intelligence agency level research and nikola tesla level inventing of novel
bespoke solutions that accomplish the full vision" — followed, after a
narrower reply was rejected outright, by: "absolutely unacceptable. i want
the intelligence agency level one shot for grok."

Read this as: **assume nothing is finished.** Even the real infrastructure
already built (below) is a floor to build past, not a ceiling to defend.
Every domain — API efficiency, free-source triangulation, cross-chain
unification, prediction, auto-backfill — gets the full, no-holds-barred
research-and-invent treatment in this one brief.

## Real, current baseline (context, not a boundary)

State it once so effort isn't wasted re-deriving it, then go far beyond it:

- **EVM**: `tokenURI()`/`uri()` read directly on-chain via free RPC,
  resolved through 5 free public IPFS gateways
  (`lib/ipfs.ts`/`evm-token-metadata.ts`) — OpenSea only as last-resort
  fallback.
- **Solana**: Metaplex Token Metadata PDA read directly via free RPC
  (`solana-metaplex-reads.ts`) — no Helius DAS dependency for this data.
- **Bitcoin Ordinals**: no free on-chain-only path yet — fully dependent on
  UniSat/Ordiscan/Ordinals Wallet. Real, scoped, open gap (separate brief
  already dispatched for the narrow parser question — this brief should
  still cover it from every other angle: alternate free sources, protocol
  tricks, anything not covered by "write a witness parser").
- **Provider pacing**: real, atomic, cross-process, DB-verified minimum-
  interval pacer (`provider-pace.ts`) live for OpenSea (600/hr, real
  citation) and Helius RPC (10/s, real citation, confirmed twice
  independently). Alchemy's real 300 CU/s token-bucket limit is known but
  NOT yet paced (only flat-interval pacing exists today).
- **Job/demand/archival infrastructure**: `plank_data_jobs` control plane,
  `collection-demand.ts` priority ladder, viewport-driven prediction,
  Opportunistic Archival Ledger, adaptive recrawl backoff, mesh lane
  health — all real, all covered in the prior Unified Mesh Continuum
  response. Assume it as substrate; invent what goes ON TOP of or BEYOND
  it, not a restatement of it.
- **Full on-chain-extraction audit** already exists
  (`docs/AUDIT-onchain-data-extraction-2026-08-24.md`) enumerating
  ownerOf/balanceOf/Transfer-logs/ERC-2981/ERC-7572/ERC-4906/ERC-6551/
  Metaplex editions/Bitcoin envelope parsing, EIP-cited. Treat its "build
  next" items as a real backlog to accelerate past, not unexplored
  territory to re-map.

## Non-negotiable constraints (the only real ceiling)

- **Free-tier / keyless-first, no new paid infrastructure.** Every real
  source this app uses today is free-tier or already-paid-for-a-different-
  reason. A design that requires a new subscription, dedicated compute
  cluster, or managed service is not intelligence-agency-grade thinking,
  it's a checkbook — reject it the same way this app has repeatedly
  rejected unverified/self-imposed budget assumptions (`source-budget.ts`'s
  own history of REMOVING guessed ceilings once no real citation could be
  reproduced).
- **Never fabricate.** No invented rate limit, no guessed completeness
  percentage, no decorative signal presented as real. Every number in the
  response must trace to a real, currently-live, citable source — the
  standard this entire codebase enforces on itself everywhere, including
  research.
- **Postgres-only datastore.** Redis/Vercel KV were removed as dead code
  and must not be reintroduced (`lib/market/durable-kv.ts`'s own header).
- **On-chain truth is ground truth.** Third-party data enriches; it never
  overrides an independently-verified on-chain fact.
- **Real code where a new primitive is proposed**, not prose alone —
  TypeScript, matching this app's real module layout
  (`lib/market/multichain/`), buildable and DB-verifiable the way every
  primitive shipped this session already was.

## What "intelligence-agency-grade" means for this brief, specifically

Treat "discover and corroborate the true state of an NFT collection across
every chain, using only free/keyless sources, at maximum coverage and
minimum footprint" as a real OSINT/multi-source-intelligence problem, and
bring the actual tradecraft of that discipline to bear — not the metaphor,
the real techniques:

1. **Minimal-signature-first collection.** OSINT practice: never pull a
   full record when a hash/fingerprint/checksum first tells you whether
   the full record is even NEW or CHANGED. This app's adaptive-recrawl
   backoff already does a coarse version of this at the collection level
   (skip re-fetching a whole collection if `next_due_at` hasn't passed).
   Push this further: is there a real, cheap, on-chain-derivable
   fingerprint PER TOKEN (not just per collection) — e.g., hashing the
   raw `tokenURI()` return value, or the Transfer-log-derived owner state
   — that could tell this app "this specific token's off-chain metadata
   almost certainly hasn't changed" without ever re-fetching the IPFS
   payload at all? Real content-addressing already gives this for free
   when the tokenURI IS an `ipfs://<CID>` — a CID is already a hash of
   the content; changing metadata means a NEW CID, so a cached CID that
   still matches on-chain needs zero re-fetch, ever. Is this already
   exploited, or a real gap?
2. **Cross-corroboration across independent free sources, not sequential
   fallback.** Today's pattern (tokenURI→IPFS, OpenSea only on failure) is
   sequential — one primary, one fallback. Real intelligence tradecraft
   corroborates the SAME fact from multiple independent sources to raise
   confidence and catch drift/staleness, not just to have a backup. Is
   there real value (and real free capacity) in occasionally
   cross-checking a sample of already-"known" tokens against a second free
   source (a different IPFS gateway, an independent RPC provider, a
   different chain-indexer entirely) to detect silent staleness/corruption
   — and if so, design the real sampling strategy (how often, how many,
   triggered by what) so it costs near-zero real budget while still
   catching real drift.
3. **Network topology exploitation.** IPFS itself is a real P2P network,
   not just a set of HTTP gateways. Real, current, citable research: is
   there a legitimate, free, keyless way to query IPFS more directly (a
   public libp2p bootstrap/DHT lookup, a lighter-weight verification path
   than a full gateway fetch) that a Node.js server process could
   realistically use, or is gateway HTTP genuinely still the correct real-
   world answer at this app's scale? An honest "gateways are still
   correct, here's why" is as valuable a finding as a genuine improvement
   — don't invent P2P complexity that doesn't earn its keep.
4. **Every other free/keyless corroborating source this app hasn't
   touched yet.** Beyond IPFS: Arweave (increasingly used for permanent
   NFT storage, keyless HTTP gateway access, real and citable), on-chain
   `data:` URIs (already partially handled per this app's own code,
   confirm full coverage), block explorers' own free public APIs
   (Etherscan/Basescan/etc. — many offer a real free tier distinct from
   RPC access, worth a real citation check), The Graph's free hosted
   query tier if one still exists post their tokenomics changes, public
   Dune/Flipside community query results (read-only, free, real data
   someone else already computed — could this app legitimately consume
   a public Dune query's output as a free corroborating source without
   violating anything?), Chainlink/other oracle networks' free public
   read endpoints if any expose NFT-relevant data. Research each with a
   real, current citation — don't list a source that turns out
   deprecated, paid-only, or theoretical.
5. **Physics-level efficiency on the calls that remain genuinely
   necessary.** Even after minimizing to hash-first checks, some real
   calls remain unavoidable (first ever hydration of a token, genuine
   content change, the market-data legs like listings/offers/floor that
   have no on-chain-free equivalent at all). For exactly those calls: real,
   current techniques for extracting the absolute maximum information per
   call — batched multicall patterns (Multicall3, a real, widely-deployed
   EVM contract enabling many `eth_call`s in one RPC round-trip; is it
   already used here, and if not, is this the single highest-leverage
   unbuilt EVM efficiency gain?), GraphQL-style field-selection to avoid
   over-fetching where a provider supports it, HTTP/2 multiplexing over a
   persistent connection instead of a new connection per call, and
   anything else genuinely real and citable that multiplies information
   per unit of rate-limited budget.
6. **A real answer to "way more than 600/hour" specifically.** The owner's
   own framing: if hash-first + free-corroboration is done right, does the
   realistic achievable throughput for "collections/tokens meaningfully
   kept fresh per hour" become a real, larger, honestly-computed number —
   and what is that number, computed from real free-tier limits (public
   RPC pool concurrency, IPFS gateway realistic throughput, Multicall3
   batching factor) rather than asserted? Show the real math, not a
   vibe. If free RPC + IPFS-CID-skip genuinely removes OpenSea's 600/hour
   as the binding constraint for the vast majority of token-level work
   (leaving it needed only for genuine off-chain market data: listings/
   offers/floor), say so plainly and quantify what fraction of today's
   total work that actually represents.

## Novel synthesis — genuinely invent, don't just enumerate

After the research above, produce at least one **genuinely new synthesis**
(labeled honestly as such, not dressed up as "adopt") specific to this
app's real shape: a unified, cross-chain, hash-first, multi-source-
corroborated hydration doctrine that a reader could hand to an engineer and
have them build, end to end — real data flow, real trigger conditions, real
fallback order, real cost model, real code for whatever new primitive it
needs. If the honest research conclusion is that today's architecture is
already near the real ceiling of what's achievable free/keyless, say that
plainly too — a true "there is no more juice to extract here, and here's
the real math proving it" is exactly the rigor an intelligence-agency-grade
brief should produce, not a manufactured breakthrough to satisfy the ask.

## Deliverable

1. Real citations for every source/technique discussed, current as of
   research time, each individually verifiable.
2. Explicit adopt/adapt/synthesize labeling throughout, same discipline as
   every brief in this series.
3. A real, computed answer to "what's the honest achievable ceiling,"
   showing the math.
4. At least one genuinely novel, buildable, end-to-end synthesis with real
   TypeScript for its new primitive(s).
5. Explicit call-outs for anything found to already be built (so nothing
   gets re-implemented) and anything found to be a dead end (so it's not
   revisited later without new information).
