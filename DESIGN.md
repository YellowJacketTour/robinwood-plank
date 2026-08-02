---
version: alpha
name: RobinWood Product System
description: The shared visual identity and interaction foundation for RobinWood, $PLANK, and every product surface.
colors:
  # These names and hexes are verified against app/globals.css `@theme` and
  # are the ONLY color vocabulary components should reference. If you find a
  # component using a hex or a name not listed here, that's drift — fix the
  # component or, if the value is genuinely new, add it here first.
  gold-500: "#E9B43F"      # primary interaction / selected state / brand gold (bg-gold-500, text-gold-500)
  gold-400: "#EEC164"      # hover state for gold-500 controls
  gold-300: "#F8D98A"      # soft gold — display headings, prices, important values (text-gold-300)
  gold-600: "#AF761D"      # deep gold, decorative/gradient use only
  wood-950: "#1B120A"      # darkest wood — header/nav surface (bg-wood-950)
  wood-900: "#2A1A0F"      # base panel wood
  wood-850: "#302013"
  wood-800: "#3D2513"
  wood-700: "#5C3A1E"
  wood-600: "#7A4D26"
  forest-900: "#0D1F16"
  forest-800: "#123322"
  forest-700: "#1A4A30"
  forest-600: "#24693F"
  cream: "#FFF2CF"          # = --foreground; primary copy color everywhere
  cream-muted: "#C9B58A"    # secondary copy / metadata
  border-line: "rgba(233,180,63,0.24)"   # --color-line — default hairline border on panels
  border-line-strong: "rgba(233,180,63,0.5)" # --color-line-strong — emphasized divider/focus border
  bg-panel: "rgba(28,16,8,0.94)"         # --color-panel — default card/panel fill
  bg-panel-soft: "rgba(41,26,15,0.88)"   # --color-panel-soft — lighter nested surface
  bg-panel-strong: "rgba(17,10,5,0.97)"  # --color-panel-strong — near-opaque, for financial data
  page-background: "#14100B"             # literal `body { background-color }`; see note below
  on-gold: "#261105"        # text on a gold-500/gold-400 fill. NOTE: most components
                            # write text-wood-950 (#1B120A) instead, but the global rule
                            # `body :where(.bg-gold-500,.bg-gold-400)` in app/globals.css
                            # repaints them to this with !important, so this is what
                            # actually renders. Both pass AA (9.50:1 / 9.73:1).
typography:
  display-xl:
    # Uncial Antiqua ships a SINGLE 400 cut and app/layout.tsx loads only that.
    # Any heavier number here documents a synthetic bold, not a real face.
    fontFamily: Uncial Antiqua
    fontSize: 3.6rem
    fontWeight: 400
    lineHeight: 0.95
    letterSpacing: -0.02em
  display-md:
    fontFamily: Uncial Antiqua
    fontSize: 2rem
    fontWeight: 400
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
  # Stock Tailwind v4. There is no `--radius` override in app/globals.css and
  # no tailwind config file, so these are what the utilities actually resolve
  # to — the previously documented 6/9/12/16 scale existed nowhere in the code.
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
  2xl: 16px
  pill: 9999px
spacing:
  # Stock Tailwind v4 scale (0.25rem step). Listed because the spec expects a
  # spacing category, NOT because the codebase uses a curated subset — real
  # components use continuous per-case values, so treat this as the available
  # scale rather than an approved palette.
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
  8: 32px
components:
  page-shell:
    backgroundColor: "{colors.page-background}"
    textColor: "{colors.cream}"
    rounded: "{rounded.xl}"
    padding: 0px
  panel:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.cream}"
    rounded: "{rounded.lg}"
    padding: 12px
  data-panel:
    backgroundColor: "{colors.bg-panel-strong}"
    textColor: "{colors.cream}"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary:
    backgroundColor: "{colors.gold-500}"
    textColor: "{colors.on-gold}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 44px
  button-secondary:
    backgroundColor: "{colors.bg-panel-strong}"
    textColor: "{colors.gold-300}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 44px
  verified-badge:
    backgroundColor: "#58BDF0"
    textColor: "#07131A"
    rounded: "{rounded.pill}"
    size: 22px
  status-success:
    backgroundColor: "{colors.bg-panel-strong}"
    textColor: "emerald-400 (Tailwind default, e.g. #34D399)"
    rounded: "{rounded.md}"
    padding: 8px
  status-error:
    backgroundColor: "{colors.bg-panel-strong}"
    textColor: "red/rose-400 (Tailwind default)"
    rounded: "{rounded.md}"
    padding: 8px
  metadata:
    backgroundColor: "{colors.bg-panel-strong}"
    textColor: "{colors.cream-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: 8px
  site-header:
    backgroundColor: "{colors.wood-950}"
    textColor: "{colors.cream}"
    borderColor: "{colors.gold-500}"
    mobileHeight: 58px
    desktopHeight: 68px
  site-footer:
    backgroundColor: ".site-footer-surface (app/globals.css)"
    textColor: "{colors.cream-muted}"
    borderColor: "{colors.gold-500}"
    desktopColumns: 3
---

## Overview

RobinWood is a hand-drawn woodland product world, not a generic crypto template. Every page should feel related through warm wood surfaces, parchment text, gold hardware, character art, and storybook display type while adapting density and hierarchy to the job of that surface.

This file is the site-wide source of truth for the landing page, Trade, Mint, Gallery, Learn, Airdrop, Marketplank, and future RobinWood experiences. Marketplank is the first surface implemented against it; its more detailed information contract below is intentionally additive, not the boundary of the system.

Visual redesigns are enhancement layers around production behavior. Decorative mockup content must never replace live data, an executable workflow, a safety disclosure, or a recovery state.

Each product page must lead with its primary task. Analytics, education, and operational controls remain available, but they follow the action or evidence stream the user opened the page to use. Completeness is not permission to bury that task.

**This file's token names and hex values are checked against `app/globals.css` and must stay in sync with it.** If you change a color in `@theme`, update the frontmatter above in the same change. Do not invent a second name for an existing token — search this file and `globals.css` before adding a new color.

## Approved mockups — read before redesigning a page

This file defines the *system* (tokens, surfaces, rules). The mockups below define
the *composition* of specific pages, and they are the owner-approved intent for
those surfaces. **Before redesigning any page covered by one, open the mockup and
build toward it — do not design from scratch.**

| Surface | Mockup |
| --- | --- |
| Landing page (`/`) | `docs/mockups/landing-redesign/finalized.html` |
| Marketplank (`/market`) and the dense trading surfaces | `docs/mockups/market-redesign/finalized.html` |
| Instant Swap on the current vault | `docs/mockups/swap-redesign/mockup.html` |
| Legacy-vault migration (`/migrate`) | `docs/mockups/nft-pool-migration/` |

They are static HTML — open the file directly or serve the directory. A mockup can
be *out of date on facts* (the collection is minted out, the homepage trade section
is now a CTA into `/trade`, `AppBackdrop` and this file's reconciliation landed
after them). Where a mockup conflicts with current production behavior, production
behavior wins and the deviation gets stated explicitly in review — but the mockup
still governs layout, hierarchy, and voice. Never silently diverge from one.

## Colors

The real token names in code are `gold-*`, `wood-*`, `forest-*`, `cream`/`cream-muted`, and the semantic surface tokens `border-line`, `border-line-strong`, `bg-panel`, `bg-panel-soft`, `bg-panel-strong` (all defined in the `@theme` block of `app/globals.css`, aliased in the market module as `--market-*` — see "Marketplank tab rail" below). These are the names to use in code and in review; do not refer to a "primary/surface/background/foreground" abstraction that doesn't exist in the stylesheet.

- **Gold (`gold-500`)** is the main interaction and selected-state color. `gold-400` is its hover state.
- **Soft gold (`gold-300`)** is reserved for display headings, prices, and important values.
- **Near-black wood (`wood-950`…`wood-600`, and the semantic `bg-panel*` tokens)** creates depth while guaranteeing readable financial data. `bg-panel-strong` (97% opaque) is the floor for any surface carrying a balance, address, hash, or price.
- **Cream (`cream`)** carries primary copy; muted parchment (`cream-muted`) carries metadata.
- Rarity colors continue to come from the shared rarity source in `lib/rarity.ts`; this file does not define a second rarity palette.
- **Success, info, and danger have no dedicated custom tokens.** The codebase uses Tailwind's stock palette directly for these (`emerald-400` for success/live-status dots, `red-*`/`rose-*` for danger and destructive actions) plus one literal one-off hex, `#58BDF0`, for the verified-collection badge. Treat this as the working convention — don't add a bespoke `success`/`danger` custom token unless you also update every call site listed here.
- **`page-background` (`#14100B`)** is the literal `body { background-color }` — it is intentionally a slightly different near-black than `wood-950` (`#1B120A`). This is a small, real inconsistency (see "Known inconsistencies" below), not a typo to silently "fix" in one file only.

### Known inconsistencies (flagged, not fixed here)

- `body`'s literal background color (`#14100B`) does not match any single `wood-*` token. Recommendation for the owner: either add a `page-background` custom property to `@theme` and point `body` at it, or accept `wood-950` as close enough and change the literal hex. Either is a one-line CSS change, not a documentation problem — left to the owner to decide, not changed here.
- Success/danger/info still use ad hoc Tailwind defaults rather than named tokens. Fine as a working convention today; if a second contributor starts free-hand-picking different shades of green/red per component, that's the signal to promote these to real `@theme` tokens.

## Typography

Uncial Antiqua is the storybook display face for product names, campaign moments, and major section headings (loaded as `--font-stencil` / Tailwind's `font-display` utility in `app/layout.tsx`). Nunito Sans is used for navigation, controls, data, tables, metadata, long-form copy, and explanatory text (loaded as `--font-body` / the default sans stack).

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

## Background treatment

There are two distinct page-background systems in this codebase. Use the right one — do not invent a third.

### 1. Marketing background — the Plank masthead

**The masthead art is painted by the hero section itself** (`components/Hero.tsx`), NOT by `body`. `body` is a solid field (`background-color: #14100b`) and carries no `background-image` at all. `<PlankBackground />` is still mounted in `app/layout.tsx` but is a no-op placeholder — see below.

- `plank-head.webp` at true, undistorted aspect ratio, capped at `min(1500px, 120vw)` wide, anchored top-center, never repeated, never stretched — scoped to the hero.
- Nothing below it. There is no `plank-legs.webp` layer and nothing dynamically sized.

**Do not move this back onto `body`.** A page-length canvas cannot be reliably darkened by a single gradient, so the art bled through mid-page as a bright band. Worse, `Hero.tsx` paints it regardless — so a `body` copy renders the masthead TWICE. That exact regression reached production once already (a rebase on 2026-07-30 kept the hero components byte-for-byte but dropped the CSS hunk that removed the `body` copy), and the owner spotted it as "the hero has tweaks I don't see, the typography is off". Recovered from `backup-pre-rebase-7bf018f` on 2026-08-02.

This is mockup-derived (`docs/mockups/landing-redesign/finalized.html`, the owner-approved intent for this page — see "Approved mockups" above) and intentionally corrects an earlier version of this rule that does not appear in that mockup: a JS-driven variant (`components/PlankBackground.tsx`, formerly using a `ResizeObserver` to measure viewport width and total page height) stretched `plank-legs.webp` to cover the entire scroll height. That stretch was a later, unreviewed elaboration recorded here as fact rather than checked against the approved design — it produced a wall of bright, uninterrupted yellow-and-black art past the hero that the owner flagged as looking strange. The capped-head-only treatment is the correct one; do not reintroduce a full-page stretched character or bring back the `ResizeObserver` sizing logic.

This is the correct, intentional background for the homepage (`app/page.tsx`) and other marketing/story surfaces (Learn, Airdrop, Mint). It is a deliberate brand statement — the page opens standing in front of Plank's face — scoped to the masthead, not a full-page skin.

### 2. App-page backdrop — the quiet wood texture

`components/AppBackdrop.tsx` renders a `fixed inset-0 -z-10` div using the `.site-footer-surface` texture (solid wood base + soft directional wash + the same plank-grain hairlines as the footer) from `app/globals.css`. It is mounted at the top of `app/trade/page.tsx`, `app/market/page.tsx`, and `app/gallery/page.tsx`, immediately before `<Nav />`.

Because it is `fixed` and opaque, it sits between the viewport and the marketing background described above and visually replaces it on these three routes — without touching `PlankBackground` or the global `body` CSS. Both this and the corrected marketing background above are now pure CSS with no JS sizing logic at all.

**Rule: any new dense, transactional, or data-heavy page (wallet balances, order books, forms, tables) mounts `<AppBackdrop />` first, exactly like Trade/Market/Gallery do. Any new marketing/story page relies on the global `PlankBackground` and mounts nothing extra.** If you're not sure which a new page is, ask whether its primary content is prose/illustration (marketing) or live data/actions (app) — that's the test the three existing app pages were split on.

Do not add a second background component, a second grain gradient recipe, or a per-page inline background style. `.site-footer-surface` is the single source of truth for the "quiet" texture; both the footer and `AppBackdrop` read it.

## The `[data-market-shell]` boundary

`app/globals.css` has global marketing-page rules — clamps on `p`, `dt`, `dd`, button/link font sizing, forced text-shadows — written with `!important` so marketing copy stays legible over the giant Plank art (see "Background treatment" above). Every one of those selectors is written as `:not([data-market-shell] *)`.

**`data-market-shell` is an escape hatch: any element with that attribute, and everything inside it, is exempt from those global `!important` clamps.** Inside the boundary, component-level Tailwind classes are authoritative again — no fighting `!important` with more `!important`.

This exists because the marketing clamps were silently repainting dense, mockup-accurate UI (forcing gold text, oversized type, forced text-shadows) inside Trade and Marketplank, which are built to their own tighter, denser typographic spec. It has broken component styling more than once when a new dense surface didn't know to opt in.

**Where it's applied today:**
- `components/market/MarketScaffold.tsx` — the root `<section>` of the entire Marketplank workspace.
- `app/trade/page.tsx` — the root content wrapper on `/trade`.

**Rule: any new dense/app-style page or panel that is fighting the marketing clamps (text going gold when it shouldn't, sizes jumping, unwanted text-shadow) should add `data-market-shell` to its outermost wrapper, the same way Trade and Market do — not add more `!important` overrides to fight the global rule.** Conversely, never add `data-market-shell` to a marketing page/section; that would silently turn off the legibility clamps needed over the character art.

## Elevation & Depth

Depth comes from layered dark wood values, narrow gold borders, inset highlights, and restrained shadows. Financial values, wallet addresses, hashes, transaction controls, and other accuracy-sensitive content sit on surfaces at least 90% opaque (`bg-panel-strong` or equivalent, e.g. `.data-module`, `rgba(18,10,4,0.92)`).

**Plank grain** is the signature surface texture: fine 1px gold-tinted board lines at 92°, 11px pitch, gold at 4–5% alpha (`.wood-grain-surface` in `app/globals.css`, and reused inside `.site-footer-surface`). It belongs on large brand surfaces — the footer, the market shell, page mastheads, mockup panels — where it reads as wood without competing with content. It never sits directly behind dense data text, and data panels (`bg-panel-strong`) stay untextured.

The Plank artwork may texture the masthead, but it must not lower text contrast. Holographic motion remains scoped to NFT art (`.holo-card` in `app/globals.css`, driven by `lib/holo.ts`) and honors reduced-motion preferences.

## Plank character art — brand rule

**A "plank" in this brand is the hand-drawn character** — warm yellow wood, thick black ink outline, sketchy grain strokes, a face (`public/images/plank-logo.webp`, `plank-head.webp`, `plank-legs.webp`, and the collection art in `public/images/collection/`).

- Any decorative or animated representation of planks — preloaders, empty states, illustrations, mockups, new marketing sections — **must use these actual character assets or match that hand-drawn outlined style exactly.**
- **Abstract geometric boards (flat rounded rectangles, gradient bars) are never a substitute for the character art.** If a design calls for "a plank" and there's no character asset that fits, that's a signal to commission/export one, not to fake it with a `<div>` styled like a rectangle.
- **NFT collection art is not the mascot.** Individual minted Plank NFTs (in Gallery, Marketplank cards, `ItemDetail`) are collectible art with their own per-token traits and holo treatment — they represent owned assets, not the brand character. Never present a random or user-owned NFT image as if it were the RobinWood mascot in navigation, footer, or marketing chrome; use the canonical character assets above for that role.

This is a hard rule, not a style preference — it's the one visual element that makes RobinWood read as itself rather than a generic crypto template.

## Vault naming — brand rule

**Never render a vault version number.** `V1`, `V2`, `V3` are internal identity for logic and tests only. A visible version ladder tells a holder "the team shipped two mistakes before this one"; each pool is presented instead as its own product:

| Generation | Product name | Compact form (badges, tags) |
| --- | --- | --- |
| 1 | Driftwood | Driftwood |
| 2 | WormWood | WormWood |
| 3 | Premium Plank Liquidity | Premium Plank |

These strings live in `VAULT_NAMES` / `VAULT_SHORT_NAMES` in `lib/market/vault-registry.ts` and are resolved from a vault **address** — never hardcoded in a component, and never selected by role, because with more than one legacy vault "the legacy one" is ambiguous.

Color coding is keyed by generation and is the one place the version concept survives, as a token name rather than as text: `v1` orange, `v2` amber (demoted — it is retiring), `v3` emerald (current). Use `VAULT_LABEL_CLASS` and `VAULT_TEXT_CLASS`; do not hand-pick a different shade per component.

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

The header (`components/Nav.tsx`) is a 58 px mobile / 68 px desktop sticky product rail (`h-[58px] lg:h-[68px]`) with a translucent near-black wood surface (`bg-wood-950/90` with backdrop blur) and a narrow gold divider (`border-gold-500/25`). It keeps the RobinWood mark legible without competing with the page masthead.

- Navigation order is Market, Trade, Mint, Gallery, and Learn. (Airdrop was removed from the rail in July 2026 to make room for the WoodAmp chip; the homepage `#airdrop` section and checker remain.) Trade is the single gold primary action; it is not repeated as both a text link and a button.
- The current route receives a restrained dark-gold state (`bg-gold-500/15 text-gold-300`) and `aria-current="page"`. Gold-filled controls remain reserved for the primary action.
- The header no longer shows a chain chip (removed July 2026 at the owner's request — the chain context lives in the footer and page workflows). Wallet connection remains owned by the page workflow until the application has one shared wallet/session boundary.
- Internal route changes use client navigation so the root layout and the persistent WoodAmp audio system remain mounted. Home-section links retain their hash targets when followed from another route.
- The right-hand rail also carries the WoodAmp music chip (see "WoodAmp music player" below): a wood-grain pill using the same control vocabulary as the (since-removed) chain chip, with the marquee title appearing at `xl` and the chip staying compact at `lg`.
- The compact menu remains in use through tablet widths; the full desktop rail begins at 1024 px so no destination is clipped. It is a full-width disclosure below the header, preserves the same order, uses 44–48 px rows, contains background scrolling, closes after selection, and supports backdrop click, Escape dismissal, breakpoint reset, first-link focus, and focus return.
- Every page with the shared header provides `#main-content` for the keyboard skip link.

### WoodAmp music player

WoodAmp (`components/woodamp/`) is the site's single audio system — a Winamp-inspired community-radio player that absorbed the old `components/AudioPlayer.tsx` background loop. One `<audio>` element, owned by `WoodAmpProvider` in the root layout, feeds three surfaces: the nav rail chip, the mobile-menu row, and the popout window.

- **No autoplay** (owner direction, July 2026 — supersedes the legacy AudioPlayer's muted-autoplay "ambient on load"): playback starts only from an explicit user action (chip, transport, Planklist row). The visitor's mute choice still persists in `localStorage` (`plank-audio-muted`, the pre-WoodAmp key) and syncs across open tabs, but sync sets state only — it never starts sound. Audio keeps `preload="none"` so wallet WebViews don't hang on load.
- The popout's cabinet is `.site-footer-surface` — the sanctioned quiet wood; knobs and the play control are gold-gradient "brass" hardware. The time/track display and the Planklist sit on untextured `bg-panel-strong`: grain never goes behind dense data text. Uncial Antiqua appears only for "WoodAmp" and "Planklist"; times use tabular numerals; every control is ≥44 px.
- Desktop (`lg+`) the popout is a draggable floating window (bottom-right default). Below `lg` it is a bottom sheet with backdrop tap, Escape dismissal, scroll containment, and focus return — the market filter-sheet pattern.
- The window root carries `data-market-shell` so the marketing type clamps never repaint it.
- The playlist is admin-managed (Phase 2): the player fetches `/api/music/playlist` (PostgreSQL-backed store) and falls back to the static seed manifest in `lib/woodamp-playlist.ts` (`sugar.mp3` remains track 1 so the ambient loop is unchanged) if the fetch fails.
- Track sources (classified authoritatively by `classifyTrackUrl` in `lib/woodamp-playlist.ts`): `hosted` (our files, including `/api/media/…` admin uploads) and `remote` (direct audio URLs; CSP `media-src` allows `https:`) play through the shared `<audio>`; `embed-youtube` / `embed-soundcloud` play through the provider's official iframe player (`WoodAmpEmbed`, postMessage-driven, CSP `frame-src` allows exactly those hosts) **inside the popout only** — YouTube's terms require a visible player, so the chip-only ambient rotation skips embeds; `external` (X/Twitter, Spotify, unembeddable pages) never plays — those rows are community showcase links that open on the platform. The play control disables for embed tracks (the provider's own controls apply) and the seek bar renders only for `<audio>` tracks.
- The EQ bars and marquees pause when nothing is audible and are frozen by the global reduced-motion rule. Fake data is not displayed: no hardcoded bitrates or invented track stats.

### Admin console

`/admin` (`app/admin/page.tsx` + `components/admin/AdminConsole.tsx` + `components/admin/sections/`) is the owner's management surface. It is a sectioned shell — a left menu rail (horizontal scroll rail below `lg`) with one component per section under `components/admin/sections/`, deep-linked via `?section=`: Music (Planklist editor + media uploads), Content (Learn section visibility, intro phrase rotation, announcement banner), Collections (live list read-only + database-staged entries), Flags (baked env values read-only + the runtime trade-pause override), Finance (read-only on-chain treasury balances), Analytics (aggregated from the live market/trade APIs), and System (storage/RPC/relayer-cron status + the admin action log). New tools register one menu entry + one section component; shared card classes live in `components/admin/ui.ts` and the sign-and-save scaffolding in `components/admin/sections/contentDocCard.tsx`.

It is an app-style page: `AppBackdrop`, `data-market-shell`, `bg-panel` cards with `border-line`, gold primary / dark secondary buttons at 44 px, `noindex`, and no navigation link. Authorization is per-mutation wallet signatures verified server-side (`lib/admin-auth.ts`) — there is no session, and connecting a non-admin wallet simply gets its saves rejected; the wallet gate explains that before asking to connect. Every verified save is recorded to the admin action log (`lib/admin-log.ts`) and shown in System.

The CMS layer (`lib/content-docs.ts` sanitizers + `lib/content-store.ts` database-backed docs, served by `/api/content/[slug]`) is an override layer, not a source of truth: every doc has a hardcoded fallback, so an empty or unreachable store never blanks a public surface. Learn content stays single-sourced in `LearnGuide.tsx` (the doc stores visibility only — no drift by construction); the intro phrase rotation caches in `localStorage` so the splash always paints on the first frame.

### Shared footer

The footer (`components/Footer.tsx`) is one global information surface, not a promotional card. It uses `.site-footer-surface` (dark restrained wood grain — the same texture `AppBackdrop` reuses), a thin gold top rule, and three desktop responsibilities that stack in the same reading order on mobile:

1. Robinhood Chain / $PLANK identity plus the complete meme-coin risk statement.
2. The full configured `$PLANK token contract`, explicitly labeled and linked to the configured explorer.
3. Learn, Market, Gallery, and the accessible external Twitter / X destination.

The current copyright remains below a subtle divider. The address may wrap but is never truncated, footer links meet the 44 px touch target, and internal destinations use client navigation.

### Marketplank collection masthead

Shows the real collection asset, Robinhood Chain context, Marketplank title, verification state, concise product promise, and the RobinWood NFT contract link. The contract address is always sourced from the collection configuration and opens Blockscout. Implemented in `components/market/MarketScaffold.tsx` / `.module.css`, whose `--market-*` custom properties (`--market-ink`, `--market-muted`, `--market-gold`, `--market-gold-soft`, `--market-border`, `--market-panel`, `--market-panel-strong`) are explicit aliases of this file's `cream`/`cream-muted`/`gold-500`/`gold-300`/`border-line`/`bg-panel`/`bg-panel-strong` tokens — never restate a hex there; alias the `@theme` token.

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

The criteria builder remains visible when disconnected so the Offers tab keeps its working hierarchy. Wallet connection gates review and signing, not the user's ability to understand the workflow.

Collection-wide offers stay unavailable until their Seaport criteria resolver is implemented and verified.

### Marketplank Activity information contract

Retain Sales, Mints, and Transfers; evidence-based venue filters and attribution; artwork, token, rarity/rank, price, parties, time, and explorer links; filtered count; collection statistics; 24-hour and total volume analytics; average and priced-sale counts; sales chart; and the separate live per-vault trade ledger covering every configured vault.

On desktop, the event feed leads and analytics form a supporting rail. On mobile, the feed remains ahead of the chart so current evidence is not pushed below multiple summary surfaces. The sales chart exposes 24H, 7D, and ALL ranges.

### Marketplank Instant Swap information contract

Retain every configured vault's identity and explorer link, Living Liquidity, Seed Vault, an actionable route into the legacy-vault migration flow, Buy, Sell, LP, Deposit, and Redeem modes, wallet balances, quotes and slippage, NFT pickers, random and targeted redemption, pending-request recovery, vault dashboard, NFT price chart, redeem odds, per-vault trade history, and treasury controls.

Buy means ETH to vault shares. NFTs are acquired through Redeem. Copy may never blur those two actions.

The tab leads with the trade widget beside the artwork rail, then the stat row and vault info; Price, Liquidity, and Activity are unified tabs beneath it. The Price tab shows a real price chart and the Liquidity tab a full LP dashboard — both live, never a decorative stand-in. Living Liquidity supports the workbench beside it on desktop and follows it on mobile; charts, ledgers, migration, recovery, seed, and treasury modules come afterward. Buy and Sell reviews show both the current expected output and the minimum implied by the selected slippage, while making clear that the enforced value is recomputed at submission.

The current vault charges flat **ETH** fees and mints/burns exactly one share, while the legacy vaults charge share-denominated fees. Any copy that states a cost must state it in that vault's own denomination — never present one fee model as if it applied to all of them.

### Legacy-vault migration information contract

`/migrate` is a guided, step-by-step flow, not explanatory copy, and it is reachable from a site-wide banner whenever a wallet holds legacy value. Retain: per-vault position breakdown, the LP-withdraw step where one is required, LP credit the pool cannot currently cover shown as stuck rather than silently folded into the redeemable total, redeemable NFT count, dust below one redeem's worth with an honest explanation of how to clear it, and per-plank skip for anything already migrated.

Migration means **exiting** the legacy vaults. Depositing the recovered planks into the current vault is an optional, user-selected follow-on step and must never be presented as mandatory or performed automatically. The flow must not nag when only wallet-held planks remain — there is nothing left to migrate at that point.

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
- Mount `<AppBackdrop />` on new dense/app pages and `data-market-shell` on their root wrapper if they fight the marketing type clamps — see "Background treatment" and "The `data-market-shell` boundary" above.

### Don't

- Do not hardcode screenshot counts, prices, volume, contract addresses, or wallet balances.
- Do not turn every page into a marketplace dashboard; preserve the purpose and pace of each surface.
- Do not introduce a second global palette, typography stack, spacing scale, or interaction language for a new page.
- Do not add controls that imply unsupported filters or order types.
- Do not reintroduce collection-wide offers before the resolver path is verified.
- Do not rename the runtime `positions` tab ID.
- Do not remove or unmount previously visited tabs.
- Do not collapse migration, recovery, analytics, approval, or transaction workflows into static explanatory copy.
- Do not broaden global typography or component overrides to achieve the market layout — use `data-market-shell` instead.
- Do not invent a second background component or grain gradient; reuse `PlankBackground`/`AppBackdrop`/`.site-footer-surface`.
- Do not represent the RobinWood brand character with an abstract shape or with NFT collection art — see "Plank character art" above.
- Do not render `V1`, `V2`, `V3`, or any version ladder in user-facing copy — use the product names from the vault registry, see "Vault naming" above.
- Do not hardcode a vault name, address, or fee model in a component, or select a vault by role instead of by address.
- Do not present migration as automatic or mandatory, or state a fee in the wrong vault's denomination.
