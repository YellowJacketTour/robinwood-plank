# Product

<!-- impeccable:product-schema 1 -->

> Provenance: written 2026-08-26 on branch `plankspace-integration`. The
> maintainer asked that users and positioning be derived from the repository
> rather than dictated. Every statement marked **(inferred)** comes from code,
> copy, and docs, not from a confirmed answer, and should be corrected in place
> when someone who knows the intent reads this. Unmarked statements are
> repository facts or were confirmed in the init interview.

## Platform

web

## Users

**(inferred)** Three overlapping audiences, all wallet-holders on Robinhood
Chain (chain ID 4663). No audience has been confirmed as primary.

1. **RobinWood NFT holders and `$PLANK` traders** — the collection is fully
   minted, so their jobs are: check rarity/rank of what they own (Gallery,
   Portfolio), buy/sell/offer on Marketplank (Seaport 1.6), swap ETH↔vault
   shares and redeem NFTs through Instant Swap vaults, migrate out of legacy
   vaults, trade `$PLANK` via the Uniswap-routed widget.
2. **PlankSpace community members** — the same wallets, but here to build and
   browse hand-made social profiles ("boards"): unique handle, bio, mood,
   music, Top 8, collectible planks, sandboxed custom HTML, Board Mail,
   Woodstock live rooms, and the Lumberyard activity feed. Ownership actions
   require the wallet that created the profile; browsing is public.
3. **Players** — the Woodshed arcade (`/games`, leaderboards, daily
   challenges) and the on-chain crash casino documented in
   `docs/CASINO-ARCHITECTURE.md`. Season 2 "Biggest Buyer Board" rewards
   buyers.

Situation: crypto-native, mobile and desktop, connecting a browser or
WalletConnect wallet; copy assumes familiarity with wallets, gas, and NFTs but
`/learn` exists to explain how the pieces fit together.

## Product Purpose

plank.love is the official home of the RobinWood NFT collection and the
`$PLANK` token on Robinhood Chain. It combines, under one brand and one
deployment:

- the collection site (gallery, rarity, trait stats, portfolio);
- Marketplank — a Seaport marketplace plus multi-vault Instant Swap;
- `$PLANK` trading, launch, and airdrop surfaces;
- PlankSpace — early-social-web style profiles and community;
- the Woodshed games and casino loop;
- learn/help content and legal pages.

**(inferred)** Success means holders keep their assets liquid and active
inside the community rather than leaving for a generic marketplace: trades
route through Marketplank, rake and fees stay inside the ecosystem (buy-and-
burn, jackpots, treasury), and social identity is tied to the wallet that
holds the planks.

## Positioning

**(inferred)** The maintainer did not name a positioning claim; the repository
supports the following as things a neighbouring Robinhood Chain project could
not truthfully copy today:

- **Marketplank Instant Swap vaults** (`MarketplankVaultV3`): proportional
  non-transferable LP, explicit reserves, ETH-denominated flat fees, a 30 bps
  constant-product swap fee, and drand-beacon-verified random redemption — an
  NFT liquidity primitive, not just a listing board.
- **One shared on-chain randomness source** (drand) feeding both vault
  redemption and the casino, with the casino rake recycled into `$PLANK`
  buy-and-burn and a community jackpot ("positive-sum for the community").
- **PlankSpace**: wallet-owned, hand-made profiles with sandboxed custom HTML
  — the "expressive, handmade energy of early social profiles" — living
  inside the same app as the market.

Treat these as candidates. Do not write marketing copy that ranks one above
the others until the maintainer confirms.

## Operating Context

- Chain: Robinhood Chain (4663). Explorer: robinhoodchain.blockscout.com.
  On-chain truth: `$PLANK`, RobinWood NFT, canonical Seaport 1.6, Marketplank
  vaults, DrandBeacon, PlankProgression.
- Hosting: Cloudflare edge → InMotion cPanel Apache/Passenger → Next.js
  standalone on Node 22 → local PostgreSQL. cPanel cron runs the drand relayer
  with a gas-only key. Production currently at plank.tanggang.life;
  plank.love is the canonical domain pending DNS cutover.
- Branches: `master` deploys; `dev` is the working branch;
  `plankspace-integration` carries the PlankSpace merge (see below).
- Wallets: browser-injected and WalletConnect; PlankSpace uses the "Plank.love
  wallet bridge" and must be opened from inside Plank.love for ownership
  actions.
- Datastore: PostgreSQL only. No KV, Upstash, Redis, or Vercel storage —
  such code is dead legacy to be removed, never extended.

## Capabilities and Constraints

Confirmed functionality (see `README.md`, `ARCHITECTURE.md`,
`docs/surface-contracts.md` for the per-surface behavioural contracts a
redesign may not drop):

- Gallery / Discover / Portfolio with live rarity and trait stats.
- Marketplank tabs, fixed labels and IDs: Buy & Sell, Instant Swap, Offers,
  Activity, My NFTs, My Listings. Deep links, keyboard nav, sticky mounting.
- Instant Swap: Buy = ETH → vault shares; NFTs are acquired via Redeem. Copy
  may never blur the two.
- Multichain marketplace (`/market/multichain`) and Bitcoin listings surface,
  with a documented known-limitations page.
- `/floorboards` — the Driftwood (V1) bargain cellar.
- `/trade`, `/launch`, `/mint` (collection fully minted; mint is historical),
  `/migrate` (legacy-vault exit), `/season2`, `/memes`, `/learn`, `/games`,
  `/admin` and `/admin/content` CMS.
- PlankSpace routes under `app/(plankspace)/*` and `/plankspace/*`, sourced
  from `integrations/plankspace-app/`.

Durable constraints:

- **Vaults are an N-vault registry**, resolved by address through
  `lib/market/vault-registry.ts`. Never show `V1/V2/V3` to users; product
  names are Driftwood, WormWood, Premium Plank Liquidity (`VAULT_NAMES`).
- **Do not migrate users into V2**; V3 is the destination.
- Never remove a legacy vault address until its `heldTokenCount` is 0.
- `RELAYER_PRIVATE_KEY` is cron-only. Never load it in Passenger; never print
  secrets into release artifacts.
- PostgreSQL migrations are append-only and backward-compatible one release.
- Terminology: "plank" = the hand-drawn brand character AND a collection
  item; "board" = a PlankSpace profile; "the Lumberyard" = the PlankSpace
  home feed; "Woodstock" = live rooms; "the Woodshed" = games; rank tiers
  Sapling → Stick → Board → Plank → Big Beam → Wooden Whale
  (`lib/plank-checks.ts`, mirrored on-chain).

Explicitly undecided:

- **PlankSpace's final integration shape.** This branch is 190 commits behind
  `dev` and `integrations/plankspace-app` is mid-repair (see
  `README-PLANKSPACE-*.txt`, `schema.ts.before-widget-repair`). Whether
  PlankSpace ships as a tab inside Plank.love, a route group, or a separate
  app is not settled.
- Social points / progression ("Rings & Sap") — parked, not scheduled
  (`docs/PARKED-social-and-points-2026-08-19.md`).
- Casino rake/bps parameters — marked OPEN in `docs/CASINO-ARCHITECTURE.md`.
- Primary audience and positioning claim — see **(inferred)** notes above.

## Brand Commitments

- **Name:** RobinWood (collection), `$PLANK` (token), plank.love (product
  domain), Marketplank (marketplace), PlankSpace (social).
- **Confirmed by maintainer:** the plank-character art is the only brand
  mascot — warm yellow wood, thick black ink outline, sketchy grain, a face
  (`public/images/plank-logo.webp`, `plank-head.webp`, `plank-legs.webp`,
  collection art in `public/images/collection/`). Never introduce an
  alternate mascot, generic crypto imagery, or an abstract mark in the
  brand's place. NFT collection art represents owned assets, not the mascot.
- Visual system is documented in `DESIGN.md` (RobinWood Product System) and
  is the incumbent authority; approved mockups live in `docs/mockups/`.
- Voice **(inferred from copy):** playful wood/forest wordplay ("What's on
  your grain?", "browse the whole lumberyard", "Under the floorboards"),
  direct and safety-conscious in transactional surfaces.

## Evidence on Hand

- Real collection art and per-token traits: `public/images/collection/`,
  rarity snapshot pipeline (`scripts/`, `lib/market/`).
- On-chain contracts and tests: `contracts/`, Hardhat suite (186 passing per
  casino doc); `typechain-types/`.
- Marketplace data: live Seaport orders, per-vault trade ledgers, sales
  analytics — all real, rendered from PostgreSQL/chain.
- PlankSpace sample assets: `public/images/plankspace/degenwaffle.png`,
  `public/plank-classic.jpeg`, `public/plank-robinwood.png`.
- Audits and handoffs in `docs/` (on-chain data extraction, multichain,
  dependency health).
- **Absent — do not fabricate:** testimonials, holder/volume counts not read
  from chain, press quotes, partner logos, pricing tiers, and any "official
  Robinhood" endorsement beyond "on Robinhood Chain".

## Product Principles

1. **On-chain truth over app state.** Anything about ownership, price, odds,
   or randomness is read from the chain or verified snapshot; the app never
   asserts what it cannot prove.
2. **Keep value inside the community.** Fees, rake, and liquidity primitives
   are designed to recycle into `$PLANK` holders rather than leak out.
3. **Never blur a financial action.** Buy vs Redeem, expected vs minimum
   output, legacy vs primary vault — copy states exactly what a signature
   does.
4. **Identity belongs to the wallet.** Profiles, boards, and rank are owned
   and editable only by the wallet that created them; addresses stay private
   by default.
5. **One brand, many rooms.** Market, social, games, and learning share one
   character, one token vocabulary, and one deployment — surfaces may differ
   in mode, never in identity.

## Accessibility & Inclusion

Baseline expectations already present in `DESIGN.md` and surface contracts:
keyboard navigation for market tabs and item detail, touch-safe 44px targets,
wallet-disconnected states that keep workflows readable rather than hidden.
No product-specific standard (e.g. WCAG level) has been confirmed.
