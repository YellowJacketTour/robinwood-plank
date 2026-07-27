# Research note: Remilia / Milady Maker

Summarized from public secondary sources (Remilia's own community wiki, Fast Company, Koinly,
CoinMarketCap, LuckyTrader, PR Newswire) — not from any primary manifesto/lore text, and not
quoted at length from any of them.

## Background
Remilia Collective is a pseudonymous, Discord/X-native crypto-art collective (creative lead
going by "Charlotte Fang") that launched Milady Maker in August 2021 — 10,000 generative PFP
NFTs on Ethereum. It grew into a wider ecosystem of derivative collections, a community meme
coin, and experimental on-chain auction products.

## What's actually adoptable (mechanism design, not lore)

1. **A remix license as a liquidity engine.** Milady's art uses a copyleft-style "Viral Public
   License" that explicitly permits derivative collections instead of fighting them. Each
   derivative (there have been several) is a fresh trading event that still points back to the
   parent brand. **Adopted into Marketplank as:** first-class support for listing a collection
   as an official derivative of another, with provenance/attribution surfaced in the UI —
   nothing that requires new licensing legal work, just a metadata relationship the marketplace
   can display and let a parent-collection's OGs get first-look access to (ties into the
   existing OG first-look mechanic in the scoping doc).

2. **Redeemable-share auctions (the "Bonkler" model).** One NFT auctioned at a time, each token
   encoding a claim on a share of the auction proceeds held in escrow, burnable to redeem that
   share. This gives a mint a floor that's backed by something real instead of pure sentiment.
   **Adopted into Marketplank as:** an optional auction template for future collection launches
   (Phase 2+, not Phase 1) — not a requirement, but worth having as a launch format option
   alongside plain fixed-price mints.

3. **"LP burned, ownership renounced" as a trust signal.** Their $LADYS meme-coin launch (94% of
   supply straight to a burned LP, renounced contract) became a widely-copied credibility
   template. **This is already exactly what plank.love's own TrustFacts section communicates**
   (100% burnt liquidity, ownership renounced) — the adoption here is surfacing the same kind of
   badge at the *collection* level inside the marketplace listing UI, not just the homepage.

4. **Scheduled, gated drop events over continuous listing.** Their derivative "waves" (gated by
   holding a parent NFT, launched as free/cheap mints on a cadence) drove repeatable volume
   spikes more than steady organic trading did. **Adopted into Marketplank as:** a first-class
   "scheduled drop" primitive for new collections — a countdown + allowlist gate, which is
   almost exactly the `CountdownTimer` component the Trade section already has.

## What's explicitly not adopted
Their own trading infrastructure is informal — contracts forked/shared ad hoc, no published
audit trail for Milady, Bonkler, or the $LADYS token found in this research pass. The mechanism
ideas above are worth building; their contract hygiene is not a model to follow, and nothing
from this research changes the standing rule that anything handling real value on Marketplank
gets its own independent audit before launch.
