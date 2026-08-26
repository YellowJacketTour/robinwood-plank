# One-shot research brief: bulk NFT collection enumeration at extreme throughput

You are being handed this brief with **zero prior context** about any specific codebase, company, or stack. Treat this as a fresh, first-principles research and design problem. Do not assume any particular vendor, library, or architecture is already in use — research broadly, then invent the best possible bespoke solution from what you find. Cite real, current sources (docs, benchmarks, changelogs) wherever you make a claim about a real system's real limits.

## The problem, plainly

We operate a live web application that displays NFT collections across multiple EVM-compatible blockchains (Ethereum mainnet plus several L2s/sidechains), and in principle should support Solana and Bitcoin Ordinals collections too. For any given collection (identified by its contract address / mint authority), we need to build and continuously maintain a **complete membership index**: every token that exists in the collection, its current owner, its metadata (name, image, animation), and its trait/attribute list for rarity scoring.

Collections range from a few hundred items to over 90,000 items (a real example: a large virtual-land collection with 92,598 total tokens, ~8,600 unique holders).

**The requirement**: when a real visitor opens a collection page — especially one that has never been indexed before, or one that's only partially indexed — we want the missing data to backfill *extremely fast*. The target experience, which we have achieved before in an earlier version of this system and are trying to recover, is: **thousands of tokens ingested per batch, with a new batch landing every one to two seconds**, so a 90,000-item collection can go from 0% to fully indexed within a couple of minutes of a visitor looking at it, not hours.

## What we've tried, and the hard wall we hit

Our current implementation enumerates collection membership by paginating a well-known NFT marketplace's public REST API (the kind that returns `{ nfts: [...], next: cursor }`, capped at 50 items per page, requiring a `next` cursor to walk forward). We built a fairly sophisticated demand-priority job queue, several layers of rate-limiting/backoff/circuit-breaker logic, and scaled up to 7 separate API keys from 7 distinct accounts on this vendor.

Even with all of that, we are hard-capped by the vendor's own documented and *empirically reconfirmed* real limit: **~600 requests per hour per account** (~1 request per 6 seconds per key), and we have directly observed real HTTP 429 responses when this is exceeded even with multiple accounts' traffic combined. At 50 items per page and one page per ~6 seconds per key, even 7 keys running flawlessly in parallel caps out at roughly **3,400–4,000 items per minute** in the best case — and in practice, with many collections and job types sharing the same 7-key pool concurrently, real sustained throughput is far lower, sometimes stalling out near 90–95% complete for hours.

This is a hard, real, vendor-side rate limit on a REST enumeration API. No amount of client-side cleverness (retry tuning, backoff, priority queues, more accounts within reason) can turn a ~1 req/sec-per-key REST API into "thousands of items every 1–2 seconds." We are confident this specific approach has a real ceiling we've now hit in practice, not just in theory.

## The clue we're chasing

We have a strong suspicion that our own *previous* version of this system — which really did achieve "thousands of tokens per batch, every 1–2 seconds" — was **not** using this marketplace's REST pagination API as its primary bulk-enumeration mechanism at all. We believe it (or some other real, achievable approach) was reading **directly from on-chain data** — e.g., raw `Transfer` event logs via a high-throughput chain indexer, rather than through any rate-limited third-party REST API. A raw event-log scan of a single collection's full history is a fundamentally different kind of operation than paginating a REST API one page at a time: it can process an entire chain's relevant historical logs for a contract in one or a few large, fast queries, is not subject to that marketplace's account-level rate limit at all, and independent tests in our own environment showed a comparable indexer (used elsewhere in our stack for a narrower purpose) scanning over 100,000 real blocks in about 33 seconds.

We are not certain this reconstruction is correct, and we don't want you to just confirm our own hypothesis — we want you to independently verify it and go further: is a raw on-chain event-log scan really the fastest, most reliable, most cost-effective way to achieve "thousands of tokens per batch, every 1–2 seconds" for arbitrary EVM collections at production reliability? What else exists in 2026 that could do this as well or better?

## What we need from you

Research state-of-the-art, bleeding-edge, currently-real (not speculative/vaporware) techniques and services for **bulk, high-throughput NFT collection membership + metadata + trait enumeration**, across:

1. **Direct on-chain / event-log scanning approaches.** High-throughput EVM log indexers (e.g. the class of tools sometimes called "hypersync"-style indexers, but also look at anything comparable — QuickNode/Alchemy/Ankr/others' bulk log APIs, direct `eth_getLogs` batching strategies, purpose-built indexing services). What are the REAL current throughput numbers, cost models, and reliability trade-offs of each? Which chains do they actually support well? What are the gotchas (reorg handling, missing-metadata-on-chain problem for ERC-721/1155 requiring a `tokenURI`/IPFS fetch per token, rate limits of the underlying RPC providers themselves)?

2. **NFT-specialized aggregator/indexer APIs** (the class of services that already do this professional indexing as a product — research current real options, their real rate limits/pricing/coverage, and how their throughput compares to both the REST-pagination approach we're stuck on and to raw on-chain scanning).

3. **Subgraph / streaming / webhook-based approaches** — is there a real, current best-practice for standing up your own indexer (self-hosted or managed) that ingests Transfer events in real time and serves a always-fresh membership + ownership index, decoupled entirely from any third-party marketplace API?

4. **Metadata + trait hydration at the same throughput** — enumerating token IDs and owners fast is only half the problem; each token also needs its metadata (name/image/animation) and trait list, which for most collections lives off-chain (IPFS, Arweave, or a centralized API) and is fetched via `tokenURI()`. What's the state-of-the-art for hydrating metadata at thousands-per-batch speed without that becoming the new bottleneck? (Batch IPFS gateway strategies, on-chain metadata standards that avoid this entirely, provider-side bulk metadata APIs, etc.)

5. **Hybrid architectures** — is the best real answer a combination (e.g., raw on-chain scan for membership + ownership at extreme speed, with metadata/trait hydration as a separate, still-fast-but-different-shaped pipeline; or a marketplace REST API used only for supplementary data like floor price/listings rather than membership at all)?

## What to actually produce

Don't just summarize options — **invent a bespoke, best-imaginable target architecture** for this exact problem, as if designing it fresh in 2026 with no legacy constraints. Be concrete: name real services/tools/techniques, real numbers, real trade-offs, and a real recommended design (data flow, what runs where, how membership/ownership/metadata/traits each get hydrated, how it stays live/continuously updated after the initial backfill, and how it degrades gracefully for a chain or collection where your first-choice method isn't available). Assume the target deployment is a real production web app with real but modest budget constraints (a small team, not unlimited enterprise spend) — so cost-effectiveness and free/cheap-tier viability matter, not just raw theoretical throughput.

Explicitly call out anywhere your recommended approach could plausibly hit its own real rate limit or cost ceiling at scale (many collections, many chains, real concurrent visitor demand), and how to handle that gracefully — we do not want to trade one hidden ceiling for another without knowing about it up front.
