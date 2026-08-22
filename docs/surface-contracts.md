# Surface contracts

What each product surface must keep. This is NOT design language — for tokens,
typography, spacing, surfaces and the rules that hold across every page, see
`DESIGN.md`.

These are behavioural requirements: the features, states and safety disclosures
a redesign of a given surface may not quietly drop. A visual pass can change how
any of this looks; it may not remove the capability.

## PlankSpace

The primary navigation exposes native PlankSpace routes beginning at
`/plankspace`. PlankSpace uses the same root wallet provider, same-origin API
handlers, and PostgreSQL deployment as the rest of Plank.love. It must not use
an iframe, external child origin, secondary wallet connector, PIN bypass, or
developer-owned test hostname.

Split out of DESIGN.md on 2026-08-02 — a design system should describe how to
build anything, not enumerate what each page contains. Mixing the two meant the
document could not be read as a spec, and page detail crowded out the rules.

## Marketplank collection masthead

Shows the real collection asset, Robinhood Chain context, Marketplank title, verification state, concise product promise, and the RobinWood NFT contract link. The contract address is always sourced from the collection configuration and opens Blockscout. Implemented in `components/market/MarketScaffold.tsx` / `.module.css`, whose `--market-*` custom properties (`--market-ink`, `--market-muted`, `--market-gold`, `--market-gold-soft`, `--market-border`, `--market-panel`, `--market-panel-strong`) are explicit aliases of this file's `cream`/`cream-muted`/`gold-500`/`gold-300`/`border-line`/`bg-panel`/`bg-panel-strong` tokens — never restate a hex there; alias the `@theme` token.

## Marketplank tab rail and panels

The six labels and runtime IDs are fixed:

- Buy & Sell — `buy-sell`
- Instant Swap — `swap`
- Offers — `offers`
- Activity — `activity`
- My NFTs — `my-nfts`
- My Listings — `positions`

Tabs retain `?tab=` deep links, `?item=` item links, browser Back/Forward behavior, active-tab scroll positioning, keyboard arrow/Home/End navigation, and lazy-then-sticky mounting after first visit.

## Marketplank Buy & Sell information contract

Retain the highest-sale event strip; Floor, Listed, Items, Best offer, and Highest sale; every rarity floor including Common; incoming matching bids; token ID, price, and multi-select rarity filters; result count; all four sorts; criteria bids; every sweep scope/preset/confirmation; loading and empty states; item detail; and verified Buy, Offer, and acceptance confirmations. Multiple selected rarity tiers use OR semantics; price and token filters continue to combine with them using AND semantics.

Cards retain NFT art, name, token ID, rank, rarity, maker, price, floor badge, trust badge, Buy, Offer, and keyboard/touch item-detail entry.

## Marketplank Offers information contract

Retain criteria quick starts, dynamic trait/rank/combo clauses with AND semantics, qualifying population and floor, WETH amount, duration, fee, signing state, incoming bids a wallet can accept, criteria rows, single-token offers, ownership-based disabled states, verified net proceeds, token choice for criteria acceptance, and all empty states.

Rank criteria use explicit top-N thresholds against the verified collection rarity snapshot. They fail closed when that snapshot is unavailable and are re-resolved by the server before an order is published.

The criteria builder remains visible when disconnected so the Offers tab keeps its working hierarchy. Wallet connection gates review and signing, not the user's ability to understand the workflow.

Collection-wide offers stay unavailable until their Seaport criteria resolver is implemented and verified.

## Marketplank Activity information contract

Retain Sales, Mints, and Transfers; evidence-based venue filters and attribution; artwork, token, rarity/rank, price, parties, time, and explorer links; filtered count; collection statistics; 24-hour and total volume analytics; average and priced-sale counts; sales chart; and the separate live per-vault trade ledger covering every configured vault.

On desktop, the event feed leads and analytics form a supporting rail. On mobile, the feed remains ahead of the chart so current evidence is not pushed below multiple summary surfaces. The sales chart exposes 24H, 7D, and ALL ranges.

## Marketplank Instant Swap information contract

Retain every configured vault's identity and explorer link, Living Liquidity, Seed Vault, an actionable route into the legacy-vault migration flow, Buy, Sell, LP, Deposit, and Redeem modes, wallet balances, quotes and slippage, NFT pickers, random and targeted redemption, pending-request recovery, vault dashboard, NFT price chart, redeem odds, per-vault trade history, and treasury controls.

Buy means ETH to vault shares. NFTs are acquired through Redeem. Copy may never blur those two actions.

The tab leads with the trade widget beside the artwork rail, then the stat row and vault info; Price, Liquidity, and Activity are unified tabs beneath it. The Price tab shows a real price chart and the Liquidity tab a full LP dashboard — both live, never a decorative stand-in. Living Liquidity supports the workbench beside it on desktop and follows it on mobile; charts, ledgers, migration, recovery, seed, and treasury modules come afterward. Buy and Sell reviews show both the current expected output and the minimum implied by the selected slippage, while making clear that the enforced value is recomputed at submission.

The current vault charges flat **ETH** fees and mints/burns exactly one share, while the legacy vaults charge share-denominated fees. Any copy that states a cost must state it in that vault's own denomination — never present one fee model as if it applied to all of them.

## Legacy-vault migration information contract

`/migrate` is a guided, step-by-step flow, not explanatory copy, and it is reachable from a site-wide banner whenever a wallet holds legacy value. Retain: per-vault position breakdown, the LP-withdraw step where one is required, LP credit the pool cannot currently cover shown as stuck rather than silently folded into the redeemable total, redeemable NFT count, dust below one redeem's worth with an honest explanation of how to clear it, and per-plank skip for anything already migrated.

Migration means **exiting** the legacy vaults. Depositing the recovered planks into the current vault is an optional, user-selected follow-on step and must never be presented as mandatory or performed automatically. The flow must not nag when only wallet-held planks remain — there is nothing left to migrate at that point.

## Marketplank wallet workspaces

Disconnected My NFTs and My Listings use an explanatory wallet gate. Connected views always render the existing functional inventory, send, list, accept, cancel, progress, partial-failure, and approval-management components; they are never replaced with static showcase cards.

## Under the floorboards (`/floorboards`)

A live route that this file previously did not mention at all. `components/market/FloorboardsView.tsx`, mounting `<AppBackdrop />` and `data-market-shell` like any other dense surface, gated by the same market kill-switch as `/market`.

Deliberately understated: a footer link and a hint on the swap tab, never a headline. It exists for buying out of the oldest pool when its shares trade below what a plank is worth — a bargain corner, not a promoted feature. Keep its entry points quiet; promoting it would push traffic toward an older pool, which is the opposite of the intent.

It also carries the recovery controls for a stuck or pending random redeem on that pool, so it must never be reduced to a shopping grid.

## `/migrate`

Guided exit from an older pool, `components/market/MigrateView.tsx`, surfaced by a site-wide banner when a position is detected. **This is the only surface that names and addresses individual older pools.** Every other page — `/learn` included — speaks generically about "an older pool", because naming them elsewhere advertises pools nobody should deposit into. See "Vault naming" above.

## Admin console

`/admin` (`app/admin/page.tsx` + `components/admin/AdminConsole.tsx` + `components/admin/sections/`) is the owner's management surface. It is a sectioned shell — a left menu rail (horizontal scroll rail below `lg`) with one component per section under `components/admin/sections/`, deep-linked via `?section=`: Music (Planklist editor + media uploads), Content (Learn section visibility, intro phrase rotation, announcement banner), Collections (live list read-only + database-staged entries), Flags (baked env values read-only + the runtime trade-pause override), Finance (read-only on-chain treasury balances), Analytics (aggregated from the live market/trade APIs), and System (storage/RPC/relayer-cron status + the admin action log). New tools register one menu entry + one section component; shared card classes live in `components/admin/ui.ts` and the sign-and-save scaffolding in `components/admin/sections/contentDocCard.tsx`.

It is an app-style page: `AppBackdrop`, `data-market-shell`, `bg-panel` cards with `border-line`, gold primary / dark secondary buttons at 44 px, `noindex`, and no navigation link. Authorization is per-mutation wallet signatures verified server-side (`lib/admin-auth.ts`) — there is no session, and connecting a non-admin wallet simply gets its saves rejected; the wallet gate explains that before asking to connect. Every verified save is recorded to the admin action log (`lib/admin-log.ts`) and shown in System.

The CMS layer (`lib/content-docs.ts` sanitizers + `lib/content-store.ts` database-backed docs, served by `/api/content/[slug]`) is an override layer, not a source of truth: every doc has a hardcoded fallback, so an empty or unreachable store never blanks a public surface. Learn content stays single-sourced in `LearnGuide.tsx` (the doc stores visibility only — no drift by construction); the intro phrase rotation caches in `localStorage` so the splash always paints on the first frame.
