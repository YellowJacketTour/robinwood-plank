---
version: alpha
name: RobinWood Product System
description: The shared visual identity and interaction foundation for RobinWood, $PLANK, and every product surface.
colors:
  primary: "#E9B43F"
  on-primary: "#261105"
  primary-soft: "#F8D98A"
  background: "#0E0905"
  surface: "#1C1008"
  surface-strong: "#110A05"
  foreground: "#FFF2CF"
  muted: "#C9B58A"
  success: "#6EE7A2"
  info: "#58BDF0"
  danger: "#FCA5A5"
typography:
  display-xl:
    fontFamily: Uncial Antiqua
    fontSize: 3.6rem
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: -0.02em
  display-md:
    fontFamily: Uncial Antiqua
    fontSize: 2rem
    fontWeight: 700
    lineHeight: 1.05
  body:
    fontFamily: Nunito Sans
    fontSize: 0.875rem
    fontWeight: 700
    lineHeight: 1.35
  label:
    fontFamily: Nunito Sans
    fontSize: 0.6875rem
    fontWeight: 900
    lineHeight: 1.2
    letterSpacing: 0.12em
rounded:
  sm: 6px
  md: 9px
  lg: 12px
  xl: 16px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
components:
  page-shell:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: 0px
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: 12px
  data-panel:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 44px
  button-secondary:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.primary-soft}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 44px
  verified-badge:
    backgroundColor: "{colors.info}"
    textColor: "{colors.background}"
    rounded: "{rounded.pill}"
    size: 22px
  status-success:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.success}"
    rounded: "{rounded.md}"
    padding: 8px
  status-error:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: 8px
  metadata:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: 8px
  site-header:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.foreground}"
    borderColor: "{colors.primary}"
    mobileHeight: 58px
    desktopHeight: 68px
  site-footer:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.muted}"
    borderColor: "{colors.primary}"
    desktopColumns: 3
---

## Overview

RobinWood is a hand-drawn woodland product world, not a generic crypto template. Every page should feel related through warm wood surfaces, parchment text, gold hardware, character art, and storybook display type while adapting density and hierarchy to the job of that surface.

This file is the site-wide source of truth for the landing page, Trade, Mint, Gallery, Learn, Airdrop, Marketplank, and future RobinWood experiences. Marketplank is the first surface implemented against it; its more detailed information contract below is intentionally additive, not the boundary of the system.

Visual redesigns are enhancement layers around production behavior. Decorative mockup content must never replace live data, an executable workflow, a safety disclosure, or a recovery state.

Each product page must lead with its primary task. Analytics, education, and operational controls remain available, but they follow the action or evidence stream the user opened the page to use. Completeness is not permission to bury that task.

## Colors

- **Gold (`primary`)** is the main interaction and selected-state color.
- **Soft gold (`primary-soft`)** is reserved for display headings, prices, and important values.
- **Near-black wood (`background`, `surface`, `surface-strong`)** creates depth while guaranteeing readable financial data.
- **Cream (`foreground`)** carries primary copy; muted parchment (`muted`) carries metadata.
- Rarity colors continue to come from the shared rarity source in `lib/rarity.ts`; this file does not define a second rarity palette.
- Success, information, and danger colors communicate state and never serve as decoration alone.

## Typography

Uncial Antiqua is the storybook display face for product names, campaign moments, and major section headings. Nunito Sans is used for navigation, controls, data, tables, metadata, long-form copy, and explanatory text.

Display type must stay sparse. Prices use tabular numerals. Small uppercase labels are acceptable only when contrast and spacing keep them readable at 390 px.

## Layout

- Site pages share a centered wide shell, consistent navigation rhythm, and clear separation between story content, data, and primary actions.
- Marketing surfaces may breathe; transactional and inventory surfaces should become denser without changing the palette or typography family.
- Responsive behavior is designed at the component level. It must not depend on shrinking desktop UI until it barely fits.
- Touch targets are at least 44 px. Fixed or sticky actions must respect the mobile safe area and may not cover essential card content.
- Marketplank specifically keeps the collection masthead, tab rail, and market workspace in one framed surface.
- Its tab rail stays horizontally scrollable and sticky beneath the site navigation.
- Buy & Sell uses a 248 px sticky filter rail beside a fluid results region on desktop.
- Below 960 px the filter rail becomes a near-full-width bottom sheet with backdrop, Escape dismissal, and focus return.
- Listing cards are two columns at 390 px, then grow fluidly to four or five columns in the normal desktop workspace.
- Data-dependent Instant Swap modules keep balanced masonry so unequal panel heights do not create a hanging empty quadrant.

## Elevation & Depth

Depth comes from layered dark wood values, narrow gold borders, inset highlights, and restrained shadows. Financial values, wallet addresses, hashes, transaction controls, and other accuracy-sensitive content sit on surfaces at least 90% opaque.

The Plank artwork may texture the masthead, but it must not lower text contrast. Holographic motion remains scoped to NFT art and honors reduced-motion preferences.

## Shapes

Primary page containers use 12–16 px radii. Controls use 6–9 px radii. Pills are reserved for compact categorical state such as rarity, verification, floor, network, status, and live-count badges.

Avoid excessive nesting of rounded cards. A border or spacing change is preferred when a new container would create a card-inside-card appearance.

## Components

### Site foundation

- Primary navigation always exposes the current page and preserves the RobinWood logo as the home anchor.
- Page mastheads combine one strong display title with a short plain-language promise; they do not repeat the navigation.
- Buttons share gold primary, dark secondary, and restrained destructive treatments. Visual priority follows action risk and frequency.
- Cards use artwork or meaningful data as their focal point. Decorative empty chrome is avoided.
- Wallet gates explain what connection unlocks before asking the user to connect.
- Loading, empty, error, disabled, pending, success, and recovery states are first-class component variants across the site.
- Transactional actions use a review-first pattern: the review summarizes the exact scope, inputs, current quote or proceeds, relevant fee, expiry, and safety limit before the wallet prompt. Copy distinguishes pre-sign checks from server-side publication checks.
- Contract, transaction, and external source links are visibly external and use configured values rather than copied strings.

### Shared header and navigation

The header is a 58 px mobile / 68 px desktop sticky product rail with a translucent near-black wood surface and a narrow gold divider. It keeps the RobinWood mark legible without competing with the page masthead.

- Navigation order is Market, Trade, Mint, Gallery, Learn, and Airdrop. Trade is the single gold primary action; it is not repeated as both a text link and a button.
- The current route receives a restrained dark-gold state and `aria-current="page"`. Gold-filled controls remain reserved for the primary action.
- The header may show the configured chain as read-only context, using a neutral chain glyph rather than a live-status dot. Wallet connection remains owned by the page workflow until the application has one shared wallet/session boundary.
- Internal route changes use client navigation so the root layout and persistent audio player remain mounted. Home-section links retain their hash targets when followed from another route.
- The compact menu remains in use through tablet widths; the full desktop rail begins at 1024 px so no destination is clipped. It is a full-width disclosure below the header, preserves the same order, uses 44–48 px rows, contains background scrolling, closes after selection, and supports backdrop click, Escape dismissal, breakpoint reset, first-link focus, and focus return.
- Every page with the shared header provides `#main-content` for the keyboard skip link.

### Shared footer

The footer is one global information surface, not a promotional card. It uses dark restrained wood grain, a thin gold top rule, and three desktop responsibilities that stack in the same reading order on mobile:

1. Robinhood Chain / $PLANK identity plus the complete meme-coin risk statement.
2. The full configured `$PLANK token contract`, explicitly labeled and linked to the configured explorer.
3. Learn, Market, Gallery, and the accessible external Twitter / X destination.

The current copyright remains below a subtle divider. The address may wrap but is never truncated, footer links meet the 44 px touch target, and internal destinations use client navigation.

### Marketplank collection masthead

Shows the real collection asset, Robinhood Chain context, Marketplank title, verification state, concise product promise, and the RobinWood NFT contract link. The contract address is always sourced from the collection configuration and opens Blockscout.

### Marketplank tab rail and panels

The six labels and runtime IDs are fixed:

- Buy & Sell — `buy-sell`
- Instant Swap — `swap`
- Offers — `offers`
- Activity — `activity`
- My NFTs — `my-nfts`
- My Listings — `positions`

Tabs retain `?tab=` deep links, `?item=` item links, browser Back/Forward behavior, active-tab scroll positioning, keyboard arrow/Home/End navigation, and lazy-then-sticky mounting after first visit.

### Marketplank Buy & Sell information contract

Retain the highest-sale event strip; Floor, Listed, Items, Best offer, and Highest sale; every rarity floor including Common; incoming matching bids; token ID, price, and multi-select rarity filters; result count; all four sorts; criteria bids; every sweep scope/preset/confirmation; loading and empty states; item detail; and verified Buy, Offer, and acceptance confirmations. Multiple selected rarity tiers use OR semantics; price and token filters continue to combine with them using AND semantics.

Cards retain NFT art, name, token ID, rank, rarity, maker, price, floor badge, trust badge, Buy, Offer, and keyboard/touch item-detail entry.

### Marketplank Offers information contract

Retain criteria quick starts, dynamic trait/rank/combo clauses with AND semantics, qualifying population and floor, WETH amount, duration, fee, signing state, incoming bids a wallet can accept, criteria rows, single-token offers, ownership-based disabled states, verified net proceeds, token choice for criteria acceptance, and all empty states.

Rank criteria use explicit top-N thresholds against the verified collection rarity snapshot. They fail closed when that snapshot is unavailable and are re-resolved by the server before an order is published.

The criteria builder remains visible when disconnected so the Offers tab keeps its working hierarchy. Wallet connection gates review and signing, not the user’s ability to understand the workflow.

Collection-wide offers stay unavailable until their Seaport criteria resolver is implemented and verified.

### Marketplank Activity information contract

Retain Sales, Mints, and Transfers; evidence-based venue filters and attribution; artwork, token, rarity/rank, price, parties, time, and explorer links; filtered count; collection statistics; 24-hour and total volume analytics; average and priced-sale counts; sales chart; and the separate live V1/V2 vault trade ledger.

On desktop, the event feed leads and analytics form a supporting rail. On mobile, the feed remains ahead of the chart so current evidence is not pushed below multiple summary surfaces. The sales chart exposes 24H, 7D, and ALL ranges.

### Marketplank Instant Swap information contract

Retain both V1 and V2 vault identities and explorer links, Living Liquidity, Seed Vault, actionable V1-to-V2 migration, Buy, Sell, LP, Deposit, and Redeem modes, wallet balances, quotes and slippage, NFT pickers, random and targeted redemption, pending-request recovery, vault dashboard, NFT price chart, redeem odds, dual-vault trade history, and treasury controls.

Buy means ETH to vault shares. NFTs are acquired through Redeem. Copy may never blur those two actions.

Vault selection is followed immediately by the actionable Swap workbench. Living Liquidity supports it beside the workbench on desktop and follows it on mobile; charts, ledgers, migration, recovery, seed, and treasury modules come afterward. Buy and Sell reviews show both the current expected output and the minimum implied by the selected slippage, while making clear that the enforced value is recomputed at submission.

### Marketplank wallet workspaces

Disconnected My NFTs and My Listings use an explanatory wallet gate. Connected views always render the existing functional inventory, send, list, accept, cancel, progress, partial-failure, and approval-management components; they are never replaced with static showcase cards.

## Do's and Don'ts

### Do

- Use live values and configured addresses.
- Reuse the same color, type, spacing, shape, focus, and state language on every page.
- Let each surface choose the density appropriate to its purpose while remaining recognizably RobinWood.
- Keep every wallet prompt derived from the payload that will execute.
- Preserve loading, empty, error, rejected, pending, recovery, and success states.
- Keep Buy, Offer, item detail, and wallet actions discoverable on touch devices.
- Use the shared collection, rarity, order-validation, and vault registries.
- Verify at 390 px, 768 px, and desktop in disconnected and connected states.

### Don't

- Do not hardcode screenshot counts, prices, volume, contract addresses, or wallet balances.
- Do not turn every page into a marketplace dashboard; preserve the purpose and pace of each surface.
- Do not introduce a second global palette, typography stack, spacing scale, or interaction language for a new page.
- Do not add controls that imply unsupported filters or order types.
- Do not reintroduce collection-wide offers before the resolver path is verified.
- Do not rename the runtime `positions` tab ID.
- Do not remove or unmount previously visited tabs.
- Do not collapse migration, recovery, analytics, approval, or transaction workflows into static explanatory copy.
- Do not broaden global typography or component overrides to achieve the market layout.
