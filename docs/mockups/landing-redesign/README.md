# Landing page redesign mockup

Open `finalized.html` directly in a browser, or via a static server rooted at the
repo root (relative asset paths resolve to `../../../public/images/...`, same
convention as `docs/mockups/market-redesign/finalized.html`). No build, wallet,
API, or chain connection is required.

The preloader plays automatically on load (~3.5s) and dismisses into the page.
A "↻ Replay intro" button sits fixed bottom-right for review — click it to
replay the intro at any time.

## What the mockup covers

Every piece of information the current live landing page (`app/page.tsx` and
its section components) communicates is retained — better presented, nothing
dropped, per DESIGN.md's information-contract rule:

- **Header/nav** — brand mark, Market / Trade / Mint / Gallery / Airdrop /
  Tokenomics / Roadmap links, Trade kept as the single emphasized nav item
  (matching `NAV_LINKS` in `lib/constants.ts`), chain pill, Connect wallet.
- **Hero** (`components/Hero.tsx`) — chain badge, mascot + title + "Plank is
  Plank." tagline, countdown to trade open, supply line (1,542 NFTs · trade on
  Uniswap), collage art, copyable contract address, and the Trade / Mint /
  Market CTA row.
- **Trust facts** (`components/TrustFacts.tsx`) — 100% burnt liquidity, 0%
  tax, 0 limits, ownership renounced — moved from the page bottom to directly
  under the hero CTAs (see CRO rationale below).
- **Trade** (`components/Trade.tsx`) — verified-CA messaging, countdown/open
  state, swap affordance, integrator fee and Universal Router disclosure.
- **Mint** (`components/MintInfo.tsx` + `MintPanel.tsx` + `MintAllocation.tsx`)
  — live phase, minted/price/community/free-wood-list/paid stats, progress
  bar, quantity stepper, mint CTA, gas/price footnotes, and the three
  allocation cards (777 community, 765 paid & reserve, 0.01 ETH price).
- **Gallery** (`components/Gallery.tsx`) — live-rarity teaser grid pulling
  real collection art, minted count, link to the full gallery; condensed from
  the live page's full interactive grid/search/insights workbench, which is
  correctly a dedicated `/gallery` experience, not a marketing-surface job
  (DESIGN.md: "marketing surfaces may breathe … while remaining recognizably
  RobinWood").
- **Check Your Planks** (`components/NftViewer.tsx`) — condensed into a
  wallet-address lookup + Connect wallet card beside the gallery teaser, so
  the capability (any wallet can check its collection) stays discoverable
  from the landing page without duplicating the full viewer UI.
- **Airdrop** (`components/AirdropChecker.tsx`) — live wallet count, holder
  pool %, total supply, per-NFT estimate, and a wallet-check field; the full
  sortable holder ledger is correctly left to the live page (a utility tool,
  not a conversion-surface job).
- **Tokenomics** (`components/Distribution.tsx`) — the three-step mint
  proceeds flow (initial LP, developer contribution, ongoing buybacks), with
  the "developer ETH is separate" footnote retained verbatim.
- **Roadmap** (`components/Roadmap.tsx`) — banner art plus all five phases,
  titles, descriptions, and claim chips, with the completed/current status
  markers preserved.
- **Footer** (`components/Footer.tsx`) — full risk disclosure copy, the
  labeled and linked `$PLANK` contract address (never truncated), and the
  Learn / Market / Gallery / Twitter destinations.
- **Preloader** — a new branded loading experience (see below); the current
  site's preloader (`components/SplashIntro.tsx`) is a color-cycling ball
  with no brand identity — this replaces it in-concept for the redesign.

## CRO rationale

**Primary conversion goal: Trade $PLANK.** The token is live and tradeable
today. The NFT collection is fully minted out — there is no mint action to
sell, so scarcity itself becomes the story: the former mint section is a
"sold out" provenance panel (supply split, original 0.01 ETH price as
history) whose conversion path is the secondary market. Trade is the one CTA
that is gold, full-width, and first in the hero's action row — matching the
live nav's rule that "Trade is the single gold primary action" (DESIGN.md).
"Buy on the market" (Marketplank) takes the strong-secondary slot mint used
to occupy, with Instant Swap as the tertiary route to a plank. One dominant
action per viewport, not three competing buttons of equal weight.

**Trust signals moved up, not just kept.** On the live page, `TrustFacts`
("Locked Down") sits near the very bottom, after Roadmap — by the time a
visitor reaches it they've either already converted or already left. The
mockup puts the same four facts (burnt liquidity, 0% tax, 0 limits, renounced
ownership) directly beneath the hero's CTA row, so hesitation about "is this
a rug" is answered in the same viewport as the ask, not ten scrolls later.
Nothing about the facts changed — only their position in the page's argument.

**One CTA, then the case for it.** After Trade/Mint/Market and the trust
strip, every following section supports one of those three actions:
Trade → the swap card and fee/contract facts; Mint → the live mint panel and
allocation cards; Market/Gallery → the rarity teaser and wallet lookup. The
Airdrop, Tokenomics, and Roadmap sections come after — they're incentive and
credibility content for a visitor who hasn't converted yet, not gatekeepers
in front of the ask.

**Scannable, one-job sections.** Each section keeps a single eyebrow + title +
one-line lede pattern (mirroring `SectionHead` from the live page), so a
skimming visitor can identify "what is this block for" without reading body
copy. Panels use the same flat wood/gold hairline-border language as the
Marketplank redesign so the product reads as one system across landing and
market.

**Meme energy stays.** Roadmap phase titles ("Wood You Just Look At It," "You
Can Plank Me Now"), the claim chips, and the mascot art are all unchanged —
CRO here means channeling that energy at the CTA (trust facts under the
button, verified-CA messaging inline with Trade), not sanding it down.

**Footer keeps full disclosure.** Per DESIGN.md, the footer is "one global
information surface, not a promotional card" — the risk statement and full,
never-truncated contract address are both preserved verbatim.

## The preloader

"Warming the workshop" — a full-screen sequence themed around building the
RobinWood fence: eight plank boards drop into place in a staggered sequence
(built from a CSS box gradient standing in for `plank-legs`/plank-board
art, with the actual `plank-head.webp` mascot bobbing at the base), under a
"🔨 Nailing the planks" headline and a gold progress bar that fills over
~3.5 seconds. Copy calls out the real supply figure (1,542 RobinWood Planks)
so the wait itself reinforces scarcity/lore rather than feeling like dead
time. It:

- Plays for a minimum of ~3.5s (`MIN_MS` in the inline script) before
  auto-dismissing with a fade.
- Is pure CSS `@keyframes` + vanilla JS (`setTimeout` to dismiss, class
  toggle for the fade) — no animation libraries.
- Respects `prefers-reduced-motion` (planks render statically, progress bar
  fills instantly, no animation).
- Has a persistent "↻ Replay intro" button (bottom-right) so reviewers can
  re-trigger it without reloading the page.

## Notes on this build pass

While verifying the mockup with the shared browse-automation tool, two build
issues surfaced and were fixed in the shipped file:

1. A scroll-triggered `IntersectionObserver` reveal effect left below-the-fold
   sections at `opacity:0` in full-page screenshots (elements never actually
   scroll into view during a full-page capture that resizes rather than
   scrolls). Replaced with content that is visible by default — no
   animation-gated visibility for a static review artifact.
2. The class name `reveal` collided with a scroll-reveal convention used by
   another script injected into the shared review browser, which forced
   `opacity:0` on any element carrying that class name regardless of origin.
   Renamed to `fx-in` (kept only as a semantic marker; carries no active
   styling) to avoid the collision.

## Verification

Screenshotted via the gstack `browse` tool against a static server rooted at
the repo root (`npx http-server -p 4791 .`, so `../../../public/images/...`
resolves correctly), at 1440×900 and 390×844, plus a capture of the preloader
mid-animation. See `verify-desktop.png`, `verify-mobile.png`, and
`verify-preloader.png` in this folder.

## Runtime mapping

| Mockup area | Current component |
| --- | --- |
| Header/nav | `components/Nav.tsx` |
| Hero | `components/Hero.tsx`, `components/CopyCA.tsx`, `components/Countdown.tsx` |
| Trust strip | `components/TrustFacts.tsx` |
| Trade | `components/Trade.tsx`, `components/trade/SwapWidget.tsx`, `components/trade/CountdownTimer.tsx` |
| Mint | `components/MintInfo.tsx`, `components/MintPanel.tsx`, `components/MintAllocation.tsx` |
| Gallery teaser + wallet lookup | `components/Gallery.tsx`, `components/NftViewer.tsx` |
| Airdrop | `components/AirdropChecker.tsx` |
| Tokenomics | `components/Distribution.tsx` |
| Roadmap | `components/Roadmap.tsx` |
| Footer | `components/Footer.tsx` |
| Preloader | `components/SplashIntro.tsx` (current implementation being redesigned) |
