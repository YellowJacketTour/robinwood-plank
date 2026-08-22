# EMERGENCY research brief for Grok: free/unlimited EVM RPC fallback, Alchemy stays in the rotation

Status: **emergency, blocking real production work right now.** Hand this
to Grok to search widely and come back with a real, implementable
multi-provider RPC strategy — not a summary of the first few results.
Written by Sonnet 5, 2026-08-20, mid-incident.

## The problem, precisely, right now

This app's `ALCHEMY_API_KEY` just hit its real monthly capacity limit,
confirmed live this session with a real error from a real call:

```
eth_blockNumber: Monthly capacity limit exceeded. Visit
https://dashboard.alchemy.com/settings/billing to upgrade your scaling
policy for continued service.
```

This blocks `eth_blockNumber` and every other RPC call across **all 8 EVM
chains this app trades on** (Robinhood Chain + `eth-mainnet`,
`polygon-mainnet`, `arb-mainnet`, `base-mainnet`, `opt-mainnet`,
`bnb-mainnet`, `avax-mainnet`, `zksync-mainnet` — see
`lib/market/multichain/trading/foreign-chain-registry.ts`'s
`FOREIGN_CHAINS`) — meaning `lib/market/multichain/seaport-fill-indexer.ts`
(which watches Seaport's `OrderFulfilled` event on-chain, the real,
first-party data source for 24h volume/sales this session just wired up)
cannot run at all right now, on any chain, until this is resolved.

## What's needed, precisely

A **free or effectively-unlimited-for-this-app's-real-call-volume**
alternative or supplementary RPC provider, per EVM chain, that this app's
existing RPC-calling code (`lib/market/fetch-rpc.ts`,
`lib/server/rpc-urls.ts` — check both for the current real provider
rotation/fallback logic already in place, if any) can fall back to or
rotate through. **Alchemy must stay in the rotation, not be replaced** --
its free/paid tier resets monthly and its NFT-metadata API
(`alchemy-nft.ts`) is used elsewhere in this app independently of raw RPC
calls; the fix is redundancy, not a rip-and-replace.

## Research questions

1. **What free-tier EVM RPC providers genuinely have a real, sustainable
   free allowance** across the specific 8 chains this app needs (not just
   Ethereum mainnet — Polygon, Arbitrum, Base, Optimism, BNB Chain,
   Avalanche, zkSync, plus Robinhood Chain's own already-known RPC)? Real
   candidates to verify live, not assume from marketing pages: Infura's
   free tier, public chain-foundation-run RPCs (e.g. Polygon's own
   `polygon-rpc.com`, Base's own public RPC, Avalanche's own public RPC),
   Ankr's public/free tier, PublicNode, LlamaNodes/LlamaRPC, Chainstack's
   free tier, dRPC, Blast API, GetBlock, QuickNode's free tier, 1RPC,
   Tenderly's free tier. For each: real documented rate limit (requests/
   sec or /day), whether `eth_getLogs` (the specific call
   `seaport-fill-indexer.ts` needs, with block-range limits that vary
   wildly by provider) is actually supported and at what range-size limit
   on the free tier, and whether it requires signup/a key at all.
2. **Is there a real, already-published rotation/fallback library or
   pattern** for Node.js/viem/ethers that cycles through multiple RPC
   endpoints automatically on rate-limit/quota errors, that this app's
   existing `lib/market/fetch-rpc.ts`/`lib/market/rpc-cache.ts`/
   `lib/market/rpc-budget.ts`/`lib/market/rpc-meter.ts` (all real,
   already-built files in this app — check what they already do before
   proposing something redundant) could be extended to use, rather than
   hand-rolling a new one?
3. **For `eth_getLogs` specifically** (the real bottleneck call for
   Seaport fill scanning): which free providers support large block
   ranges vs. force small ones, and is a "many small ranged calls across
   free-tier rate limits" strategy actually viable at this app's real
   scanning cadence (a `*/2 min` incremental cron, see
   `docs/INMOTION_DEPLOYMENT.md` §13), or does the real answer involve
   self-hosting a light client / using a specialized log-indexing service
   (e.g. checking if Envio HyperSync — already a dependency in this repo,
   `@envio-dev/hypersync-client`, per `hypersync-evm-scan.ts` — has a free
   tier that could take over `eth_getLogs`-class work specifically,
   sidestepping the RPC-quota problem entirely for that one call type)?
4. **What's the real, correct multi-provider architecture**: parallel
   racing (call N providers at once, use whichever answers first), or
   sequential fallback (try provider A, on failure/quota-error try B, then
   C)? What do real, production multichain apps (the ones already
   researched this session — Reservoir, DeFiLlama, dune) do, if
   documented anywhere real?

## Non-negotiable invariants

- Alchemy stays a real, first-class provider in the rotation — this is
  ADDING redundancy, not replacing a working integration.
- Never silently degrade to fabricated/estimated/cached-forever data when
  every provider fails — fail closed (a clear, loud error/skip), same
  discipline this whole codebase already holds everywhere else.
- No new paid dependency presented as "free" without the real, current,
  verified rate limit and pricing cliff clearly stated.

## What "done" looks like

A ranked list of real, verified (rate limit checked against current
provider docs, not assumed) free/low-cost RPC providers per chain, plus a
concrete rotation/fallback code pattern this app's existing
`fetch-rpc.ts`/`rpc-cache.ts`/`rpc-budget.ts` files can actually be
extended with — file-level, not hand-wavy. This directly unblocks the
Seaport fill indexer (and therefore real 24h EVM volume/sales) the moment
it's implemented.
