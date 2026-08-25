# Research brief for Grok: no-stone-unturned research on turning organic visitor traffic into a permanent, self-sustaining global archive

Status: **maximal-breadth research + invention brief.** Search across every
relevant source type — academic (distributed systems, web archiving,
citizen science / volunteer computing, crowd-sensing), real production
systems (web crawlers, package registries, blockchain indexers, P2P
archival networks), and practitioner discussion — then invent a bespoke,
elegant mechanism for this specific app where none of the above already
fits. Written by Sonnet 5, 2026-08-25, from direct, current, first-hand
knowledge of this codebase.

## The real, verified current state (don't re-derive this, it's settled)

Checked directly in code today, not assumed:

- **Durable facts persist forever, automatically, with no expiry logic
  anywhere**: `lib/market/multichain/collection-token-store.ts`'s upsert
  path (metadata, traits, images) and every on-chain fill/settlement table
  built this session (`plank_seaport_fills`, `tensor_onchain_listings`,
  `bitcoin_onchain_settlements`, etc.) write into shared Postgres with no
  deletion/TTL. Once any visitor's action causes a token or a historical
  sale to be written, it is a permanent, global, shared record from that
  moment on — every future visitor benefits, not just the one who
  triggered it.
- **Live market state is intentionally NOT permanent**: `singleflight-
  cache.ts`'s soft/hard TTLs and `collection_visibility_demand`'s 2-hour
  sweep are deliberately short-lived, because floor price/listed count/
  order-book state changes on-chain continuously — treating a 3-day-old
  floor price as a permanent fact would be dishonest, not efficient.
- **Existing organic-traffic-triggers-hydration mechanisms** (all real,
  all built this session): a single token click (`hydrateSpecificToken`/
  `hydrateSpecificSolanaToken`), and the new viewport-visibility system
  (`lib/market/multichain/collection-demand.ts`'s `prioritizeVisibleCollections`,
  drained by `scripts/mesh-tick.ts`, which — also discovered and fixed
  today — had no supervisor keeping it running continuously until now).
  Both already turn "a real person looked at this" into "the mesh queue
  does real work," which already durably writes into the tables above.

## What this brief is actually asking for

The owner's framing: **"act as a community of sustainable archival miners
uncovering every single collection and data point across every chain we
interface with."** Translated honestly into a real research question: is
there a way to deliberately, elegantly amplify the *permanent accumulation*
side of what already happens today — not just "hydrate what's visible
right now" (already built), but **treat every real visitor's organic
browsing as a distributed, opportunistic archival/discovery process that
makes the platform's total stored knowledge strictly larger and more
complete over time, approaching (never claiming to reach) full coverage
of every collection on every chain the platform touches** — without
custody, without asking visitors to run software, without new user trust
assumptions, and without contradicting the app's fail-closed/never-
fabricate discipline.

## What to research (exhaustive, every relevant source type)

1. **Web archiving at scale**: the Internet Archive's Wayback Machine and
   Common Crawl — both are real, decades-proven systems for "opportunistic,
   ever-growing, never-shrinking archives of what the web looked like."
   What are their real, documented architectural decisions for handling
   staleness, deduplication, and prioritizing what to crawl next? Is there
   a real concept in this space directly analogous to "a visitor's real
   request is itself a signal of what's worth archiving" (this is
   distinct from a scheduled crawler — research whether any real archival
   system uses *organic user traffic* as its discovery signal, versus
   purely scheduled/link-graph-based crawling).
2. **Citizen science / volunteer computing**: SETI@home, Folding@home,
   Zooniverse, eBird/iNaturalist (crowd-sourced observation platforms with
   real, published research on data quality, deduplication, and
   incentive-free sustained participation). eBird/iNaturalist in
   particular are real precedent for "ordinary people's organic activity
   (birdwatching, hiking) becomes a permanent, growing scientific
   archive" — is there real published methodology from these projects
   that transfers to "ordinary people's organic activity (browsing an
   NFT marketplace) becomes a permanent, growing data archive"?
3. **Package registry / dependency-graph archival precedent**: npm,
   PyPI, and Software Heritage (a real, academic-grade project
   specifically dedicated to "archive all source code, forever" —
   research their real architecture and stated mission/methodology
   deeply, since "archive every collection on every chain, forever" is
   structurally similar to their actual stated goal for source code).
4. **Blockchain-specific opportunistic archival**: is there real,
   documented prior art for a marketplace/indexer treating live user
   traffic itself (not just scheduled indexer sweeps) as a primary
   discovery mechanism for what to index — e.g., any real Graph Protocol,
   Dune, or block-explorer engineering write-up describing "we discovered
   this contract/collection because a user queried it first, before our
   scheduled crawler would have found it"? This app already has this in
   miniature (per-collection detail page = discovery trigger) — research
   whether this is a named, recognized pattern elsewhere or something
   built ad hoc everywhere it exists.
5. **Data quality / anti-poisoning research for crowd-sourced discovery**:
   since real visitors (not vetted contributors) triggering writes into a
   permanent archive is a real attack surface (could a malicious actor
   cause bogus/wasteful writes by crafting requests?), research real
   academic or production techniques for validating organically-triggered
   writes before they become permanent — this app's own discipline
   (never fabricate, fail closed, always derive facts from a real,
   independently-verifiable on-chain or API source, never trust a
   client-supplied claim directly) is already a strong defense; confirm
   whether real prior art agrees this is sufficient or identifies a
   real gap.
6. **Priority/completeness modeling for "eventually archive everything"**:
   is there real, citable research on how an opportunistic (traffic-
   driven) archival system estimates or reports its own completeness
   (e.g., "we've archived what real visitors have shown us, but that is
   NOT the same claim as 'we've archived everything that exists'") — this
   directly matters for this app's honesty discipline (`venue-registry.ts`'s
   coverage field, the `/known-limitations` page): an opportunistic
   archive must never imply completeness it hasn't earned.

## Concrete design questions for the invention half

1. Should this be purely an amplification of what's already built (every
   visibility/click signal already durably writes real facts — is there
   a real gap in HOW MUCH gets captured per visit that's worth widening,
   e.g. capturing more of a token's real trait/rarity/history data per
   organic hydration event than is captured today), or is there a
   genuinely new mechanism worth inventing (e.g., a real "archival
   completeness score" per collection that's visibly tracked and grows
   over time as organic + background hydration accumulates real data,
   surfaced honestly in the product rather than only internally)?
2. Should "every visitor is an archival contributor" be made an explicit,
   visible product idea (e.g., a real, honest "N real data points
   discovered by real visitors today" counter) or should it stay purely
   an internal architecture detail? Research real precedent for both
   choices (Wikipedia is explicit about crowd contribution as its
   identity; most CDN/cache-driven systems are not) and recommend one,
   reasoned from what fits an NFT marketplace's actual audience.
3. Is there a real, principled way to distinguish "this collection is
   fully archived because real, cumulative visitor + background traffic
   has actually covered it" from "this collection merely hasn't been
   looked at yet, we have no idea how complete it is" — i.e., should
   `venue-registry.ts`'s coverage model gain a per-collection (not just
   per-venue) completeness signal driven by real accumulated hydration
   history (e.g., "% of known token ids that have ever been successfully
   hydrated, ever") separate from the venue-level classification that
   already exists? This would be a real, new, honestly-labeled metric —
   propose the real schema/computation if it's worth building.
4. How does this compose with the "never fabricate" rule at scale — if
   the goal is "no stone unturned," is there a real, honest way to
   proactively widen coverage BEYOND pure organic-traffic-triggering
   (e.g., a low-priority, budget-respecting background sweep that visits
   collections nobody has looked at yet, specifically to fill gaps
   organic traffic alone wouldn't reach) without this becoming
   indistinguishable from "just run the existing background scanners
   more" (which already exists) — is the "archival miners" framing
   asking for something structurally new, or for continued investment in
   what's already built? Give an honest verdict.

## Constraints (same as every other brief this session — do not relax)

- PostgreSQL only, `PGPOOL_MAX=4`, free-tier-first, single Next.js
  standalone instance.
- Never fabricate; every archived fact must trace to a real, independently
  verifiable source (on-chain read or real API response), never a guess.
- No custody, no new user trust assumptions, no asking visitors to install
  or run anything.
- Compose with, don't bypass, `singleflight-cache.ts` and
  `freshness-budget.ts` for any live-path work; background archival work
  goes through the existing mesh/job-queue infrastructure
  (`collection-demand.ts`, `control-plane.ts`, `mesh-tick.ts`).

## Deliverable

Same format as prior briefs: real citations per research question, a
concrete architecture/mechanism proposal, and explicit labeling of
"adopt known pattern," "adapt known pattern," or "genuine new synthesis"
for every recommendation — plus an honest verdict on whether "community of
sustainable archival miners" is a real, novel thing worth building, or
essentially already what this session built today under a different name.
