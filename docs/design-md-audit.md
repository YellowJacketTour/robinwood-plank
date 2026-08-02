# DESIGN.md audit

Read-only verification of every factual claim in `DESIGN.md` against the code in this
worktree (`D:\plank-inmotion`, branch `inmotion`, HEAD as checked out). No files were
edited to produce this report.

## WRONG — claims that contradict the code

### 1. `[data-market-shell]` "where it's applied today" list is missing 8 of 10 usages

DESIGN.md:237-239 claims:

> - `components/market/MarketScaffold.tsx` — the root `<section>` of the entire
>   Marketplank workspace.
> - `app/trade/page.tsx` — the root content wrapper on `/trade`.

Actual usages of `data-market-shell` in the codebase (10 total):

- `components/market/MarketScaffold.tsx:238` (approx.) — listed, correct
- `app/trade/page.tsx` — listed, correct
- `app/admin/page.tsx:31`
- `components/Gallery.tsx:227` and `:1122` (two usages)
- `components/market/FloorboardsView.tsx:275`
- `components/market/MigrateView.tsx:248` and `:680` (two usages)
- `components/market/V3SwapView.tsx:291`
- `components/MigrateBanner.tsx:55`
- `components/SiteBanner.tsx:48`
- `components/woodamp/WoodAmpWindow.tsx:160`

Cross-reference: DESIGN.md's own "Admin console" section (line 322) and "WoodAmp music
player" section (line 313) both separately *assert* that `/admin` and the WoodAmp
popout carry `data-market-shell` — directly contradicting the "where it's applied
today" list two sections earlier, which omits both. The doc disagrees with itself.

**Correct fact:** the boundary is applied far more broadly than the dedicated section
states — at minimum to Admin, Gallery (twice), Floorboards, Migrate (twice), the V3
swap tab, the migrate banner, the site banner, and the WoodAmp popout, in addition to
the two listed.

### 2. `AppBackdrop` mount list is missing half its mounts

DESIGN.md:221 claims:

> It is mounted at the top of `app/trade/page.tsx`, `app/market/page.tsx`, and
> `app/gallery/page.tsx`, immediately before `<Nav />`.

Actual: `<AppBackdrop />` is mounted, immediately before `<Nav />`, in **six** route
files, not three:

- `app/trade/page.tsx:27` — listed
- `app/market/page.tsx:36` — listed
- `app/gallery/page.tsx:18` — listed
- `app/admin/page.tsx:21` — **not listed**
- `app/floorboards/page.tsx:35` — **not listed**
- `app/migrate/page.tsx:33` — **not listed**

This also means the "Rule" paragraph right below it ("mounts `<AppBackdrop />` first,
exactly like Trade/Market/Gallery do") cites the wrong reference set — Admin, Migrate,
and Floorboards already do this and should be in the canonical example list.

### 3. `/floorboards` is a live, undocumented product surface

`app/floorboards/page.tsx` is a real, nav-independent route ("Under the floorboards" —
"pull RobinWood planks out of the V1 vault below listed floor price"), gated by the
same `MARKET_ENABLED`/admin kill-flag as `/market`, rendering
`components/market/FloorboardsView.tsx` inside `data-market-shell` with its own
`AppBackdrop`. It does not appear anywhere in DESIGN.md: not in the Overview's list of
site-wide surfaces ("landing page, Trade, Mint, Gallery, Learn, Airdrop, Marketplank,
and future RobinWood experiences" — line 137), not in "Approved mockups", not in
Components, not in the `[data-market-shell]`/`AppBackdrop` usage lists (see #1/#2
above, where it's actually one of the missing entries). This is exactly the kind of
"current product state" gap the audit was asked to check for.

### 4. Display typography's claimed `fontWeight: 700` does not match the loaded font

DESIGN.md frontmatter (lines 34-39) claims:

```
display-xl: { fontFamily: Uncial Antiqua, fontSize: 3.6rem, fontWeight: 700, ... }
display-md: { fontFamily: Uncial Antiqua, fontSize: 2rem, fontWeight: 700, ... }
```

`app/layout.tsx:15-19` loads the font with a single explicit weight:

```ts
const stencil = Uncial_Antiqua({
  variable: "--font-stencil",
  subsets: ["latin"],
  weight: "400",
});
```

Uncial Antiqua is only published by Google Fonts at weight 400 — there is no 700 cut to
request. `.font-display` in `app/globals.css:148-150` sets only `font-family` and
`letter-spacing`, no `font-weight`. Every call site that applies `font-display` to a
heading (`components/admin/AdminConsole.tsx:116`, `components/Countdown.tsx:43,55`,
`components/Footer.tsx:20`, `components/Gallery.tsx:249`, all seven admin section
headers, etc.) never pairs it with `font-bold`/`font-black`. Rendered weight is 400
everywhere, not 700.

**Correct fact:** `display-xl`/`display-md` should read `fontWeight: 400` (or the field
should be dropped, since Uncial Antiqua has no other weight to select).

## STALE — claims that describe an earlier/partial state

### 5. Listing-card column count is described as fixed; the grid is actually fluid auto-fill

DESIGN.md:199 claims:

> Listing cards are two columns at 390 px, then grow fluidly to four or five columns in
> the normal desktop workspace.

`components/market/ListingGrid.tsx:69`:

```
grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-3
  xl:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]
```

The "two columns" base is correct, but above `sm` the column count isn't a fixed 4-5 —
it's `auto-fill` with a `minmax` track, so the actual count depends on container width
and can be 3, 4, 5, or 6+ depending on viewport and whether the filter rail is open.
"Grows fluidly" is directionally true but "four or five columns" overstates precision
as if it were a fixed breakpoint value. Not wrong in spirit, but should say "fluid
auto-fill (180-200 px minimum card width), not a fixed column count" rather than citing
specific numbers that don't appear in the code.

### 6. `verified-badge` size doesn't match any 44 px touch-target-adjacent value, and `filterTrigger` is 42.4 px, not 44

Not a DESIGN.md internal contradiction, but worth flagging under "Layout": the doc's
blanket rule "Touch targets are at least 44 px" (line 194) is contradicted by its own
frontmatter, which sizes `verified-badge` at `22px` (line 103, decorative, arguably
fine) and, more materially, `components/market/MarketScaffold.module.css:448`
(`.filterTrigger { min-height: 2.65rem }` = 42.4 px), which is the mobile "Filters"
button opening the bottom sheet — a real touch target, currently under the stated
44 px floor. Flagging as STALE/drift rather than WRONG since the rule is a general
principle and this is one component under-shooting it, not a doc claim about this
specific pixel value.

## VERIFIED

The following claims were checked directly against code and match:

- **Color tokens.** Every `gold-*`, `wood-*`, `forest-*`, `cream`/`cream-muted`,
  `border-line`/`border-line-strong`, `bg-panel`/`bg-panel-soft`/`bg-panel-strong` name
  and hex in the DESIGN.md frontmatter (lines 10-31) matches the `@theme` block in
  `app/globals.css:22-55` exactly, including the `wood-950` (`#1B120A`) vs.
  `page-background` (`#14100B`) intentional mismatch and its "Known inconsistencies"
  callout. `app/globals.css:22-25` even comments that DESIGN.md is the canonical
  source and the mockup's hexes were drift — consistent with the doc's framing.
- **`on-gold` (`#261105`).** Not a CSS custom property, but used as a literal hex
  consistently at every "text on gold fill" call site checked (`components/admin/ui.ts`,
  `MigrateView.tsx`, `V3SwapPanel.tsx`, `SiteBanner.tsx`, `app/globals.css:97,142`,
  etc.) — value matches the doc.
- **`page-background` / `viewport.themeColor`.** `body { background-color: #14100b }`
  (`app/globals.css:70`) and `viewport.themeColor = "#14100b"`
  (`app/layout.tsx:29`) both match.
- **Marketing masthead is painted by `Hero.tsx`, not `body`.** Confirmed —
  `components/Hero.tsx:24-27` paints `plank-head.webp` scoped to the hero section;
  `body` in `app/globals.css` carries only `background-color`, no `background-image`.
  `components/PlankBackground.tsx` is a literal no-op (`return null`) with a comment
  explaining why. This was the specific regression the requesting teammate already
  fixed and it now checks out.
- **`AppBackdrop` implementation.** `components/AppBackdrop.tsx` is exactly as
  described: `fixed inset-0 -z-10`, `.site-footer-surface` texture, no JS.
- **`MarketScaffold`'s `--market-*` aliases.** `components/market/MarketScaffold.module.css:4-10`
  aliases `--market-ink`/`--market-muted`/`--market-gold`/`--market-gold-soft`/
  `--market-border`/`--market-panel`/`--market-panel-strong` to
  `--color-cream`/`--color-cream-muted`/`--color-gold-500`/`--color-gold-300`/
  `--color-line`/`--color-panel`/`--color-panel-strong` respectively — matches the doc's
  claimed alias table (line 338) token-for-token.
- **Buy & Sell filter rail: 248 px, sticky, 960 px breakpoint.** Confirmed in
  `components/market/MarketScaffold.module.css`: `.browse { grid-template-columns:
  15.5rem minmax(0,1fr) }` (15.5rem = 248 px) is the unqualified base rule; two media
  queries (`max-width: 767px` and `min-width: 768px and max-width: 959px`) both collapse
  it to the bottom-sheet `.filterTrigger`/`.filterPanel` pattern, meaning the 248 px
  two-column layout only applies at ≥960 px. The mobile `.filterPanel` is
  `right:0; left:0` (near-full-width), with `Escape` handling and focus return present
  in `components/market/MarketBrowseLayout.tsx:34-39`.
- **Site header: 58/68 px, `bg-wood-950/90`, `border-gold-500/25`.**
  `components/Nav.tsx:194`: `h-[58px] ... bg-wood-950/90 backdrop-blur-lg ...
  border-gold-500/25 ... lg:h-[68px]` — exact match.
- **Nav order and Airdrop removal.** `lib/constants.ts:219-228` `NAV_LINKS` is exactly
  Market, Trade, Mint, Gallery, Learn, with a comment dating the Airdrop removal to
  "2026-07" for the WoodAmp chip, matching the doc's note.
- **Footer: 3 desktop columns.** `components/Footer.tsx:18`:
  `md:grid-cols-[1.15fr_1.5fr_0.85fr]` — three columns, matches
  `desktopColumns: 3` in frontmatter.
- **Marketplank tab IDs and order.** `lib/market/navigation.ts:7-14` `MARKET_TABS` is
  exactly Buy & Sell (`buy-sell`), Instant Swap (`swap`), Offers (`offers`), Activity
  (`activity`), My NFTs (`my-nfts`), My Listings (`positions`), in that order — matches
  DESIGN.md:344-349 verbatim, including the `positions` runtime ID the "Don't" section
  says never to rename.
- **Vault naming.** `lib/market/vault-registry.ts:56-67` `VAULT_NAMES`/
  `VAULT_SHORT_NAMES` are exactly Driftwood / WormWood / Premium Plank Liquidity
  (short: Premium Plank) for generations 1/2/3. `VAULT_LABEL_CLASS`/`VAULT_TEXT_CLASS`
  (lines 142-154) color v1 orange, v2 amber, v3 emerald — matches the doc's "Vault
  naming" section exactly, down to "v2 amber (demoted)".
- **Admin console sections.** `components/admin/AdminConsole.tsx:45-51` `SECTIONS` is
  exactly Music, Content, Collections, Flags, Finance, Analytics, System, `?section=`
  deep-linked — matches DESIGN.md:320 verbatim.
- **`data-market-shell` marketing-clamp scoping mechanism.** Every global `!important`
  rule described (heading text-shadow, `dt`/`dd` sizing, `.text-foreground/*` color,
  forced button sizing, `.bg-gold-500`/`.bg-gold-400` on-gold text) in
  `app/globals.css:95-146` is in fact written `:not([data-market-shell] *)` or
  `body :where(...):not([data-market-shell] *)` — the mechanism description is
  accurate, only the "where it's applied" *inventory* is stale (see WRONG #1).
- **Global text-shadow narrowed to headings; no more `!important` paragraph clamp.**
  Confirmed — `app/globals.css:102-103` scopes the text-shadow rule to
  `:where(h1,h2,h3,h4)` only; no `!important` font-size clamp on `p` was found in the
  current stylesheet.

## Spec-conformance assessment (target: Google Labs `DESIGN.md` format)

Target canonical `##` order: **Overview, Colors, Typography, Layout, Elevation & Depth,
Shapes, Components, Do's and Don'ts**, with extra sections permitted (preserved) and
duplicate headings rejected.

Current heading sequence (`grep -n "^## " DESIGN.md`):

1. Overview — canonical, position 1/8 ✓
2. Approved mockups — read before redesigning a page — **extra**
3. Colors — canonical, position 2/8 ✓
4. Typography — canonical, position 3/8 ✓
5. Layout — canonical, position 4/8 ✓
6. Background treatment — **extra**
7. The `[data-market-shell]` boundary — **extra**
8. Elevation & Depth — canonical, position 5/8 ✓
9. Plank character art — brand rule — **extra**
10. Vault naming — brand rule — **extra**
11. Shapes — canonical, position 6/8 ✓
12. Components — canonical, position 7/8 ✓
13. Do's and Don'ts — canonical, position 8/8 ✓

**No duplicate headings** — each of the 8 canonical sections appears exactly once, and
the 5 extra sections are all uniquely named.

**Relative order of the 8 canonical sections is already correct** — every extra section
is interleaved between canonical ones without reordering them, so nothing here blocks
adopting the target format; extras can stay in place.

**Do the extras earn their place?**
- *Approved mockups* — yes; it's load-bearing (governs composition per surface) and
  referenced by name from "Background treatment" below it.
- *Background treatment* — yes; this is the section the requesting teammate rewrote
  tonight specifically to fix the production regression. High-value, keep.
- *The `[data-market-shell]` boundary* — yes in principle, but its content inventory is
  the least trustworthy claim in the whole file (WRONG #1) and needs a rewrite, not
  removal — arguably this content belongs folded into **Components → Shared header and
  navigation** or a new "Theming escape hatches" subsection under **Layout**, since the
  target spec doesn't have a home for "CSS scoping mechanism" as a top-level concept.
- *Plank character art* / *Vault naming* — both are brand/product rules, not visual
  system tokens. They fit more naturally as subsections under **Do's and Don'ts** (both
  already have their own "hard rule" language and are cross-referenced from the Don't
  list at lines 421-424) or under **Components** (each already gets one). Keeping them
  as top-level `##` sections is defensible for visibility but is the main source of
  "extra section count" versus the target spec.

**What the target spec expects that's structurally missing:**
- **Elevation & Depth has no frontmatter/YAML counterpart.** The body section (line
  243) references `--shadow-panel`/`--shadow-gold`-equivalent language only in prose
  ("restrained shadows... 90% opaque"); the frontmatter has `colors`, `typography`,
  `rounded`, `spacing`, `components` keys but no `elevation`/`shadow` key, even though
  `app/globals.css:53-54` defines `--shadow-panel` and `--shadow-gold` as real theme
  tokens. A machine-readable `elevation:` block (opacity floor, shadow values) is
  missing and the code already has the values to seed it.
- **Layout has no frontmatter/YAML counterpart at all.** The 248 px rail, 960 px
  breakpoint, 44 px touch target, and 390/768 px verification widths (all now VERIFIED
  above) exist only as prose in the body; the target spec's point of putting design
  tokens in YAML front matter is exactly to make numbers like these machine-checkable
  the way Colors already is. Nothing under `layout:` exists in the frontmatter today.
- **Shapes** has a `rounded:` YAML block (frontmatter lines 56-61) that does map
  reasonably well to spec expectations — this one's in good shape.

## Recommended section plan

1. Overview *(unchanged)*
2. Approved mockups *(keep as-is; it's referenced by name elsewhere)*
3. Colors *(unchanged; strongest section in the file — keep the "checked against
   app/globals.css" contract and the Known-inconsistencies callout)*
4. Typography *(fix WRONG #4 — `fontWeight: 700` → `400` on both display tokens)*
5. Layout *(add a `layout:` YAML block mirroring the prose: `filterRailWidth: 248px`,
   `filterSheetBreakpoint: 960px`, `touchTarget: 44px`, `verifyWidths: [390, 768]`; fix
   STALE #5's column-count wording; note the `filterTrigger` 42.4 px under-shoot as a
   tracked drift item rather than silently rounding it up)*
6. Background treatment *(keep — freshly correct per this audit)*
7. The `[data-market-shell]` boundary *(keep the mechanism explanation; replace the
   "where it's applied today" list with the full 10-usage inventory from WRONG #1, or
   drop the list entirely in favor of "grep `data-market-shell` for the current set" so
   it can't go stale again — the list is the thing that keeps drifting, not the rule)*
8. Elevation & Depth *(add `elevation:` YAML block for `--shadow-panel`/`--shadow-gold`)*
9. Plank character art — brand rule *(consider demoting to a Components or Do's/Don'ts
   subsection per spec-conformance notes above; content itself is unverified-by-me but
   not contradicted by anything found)*
10. Vault naming — brand rule *(same demotion consideration; content VERIFIED accurate)*
11. Shapes *(unchanged)*
12. Components *(fix WRONG #2 — add Admin/Floorboards/Migrate to the `AppBackdrop`
    example list; add "Floorboards" as a named surface per WRONG #3, at minimum a
    one-paragraph information contract matching the style of Buy & Sell/Offers/etc.)*
13. Do's and Don'ts *(unchanged content; if #9/#10 are demoted, they land here)*

## Notes on scope

- Everything above was checked with direct file reads and repo-wide greps against the
  actual `inmotion` worktree checkout at the time of this audit; no claim here was
  taken on the teammate's or the doc's word.
- Not exhaustively re-verified line-by-line: the WoodAmp track-source classification
  rules (`classifyTrackUrl`), the admin CMS fallback behavior, and the migrate-flow
  step contract (`/migrate`) — these read as internally consistent with the code
  structure found (`lib/woodamp-playlist.ts`, `lib/content-docs.ts`/`lib/content-store.ts`,
  `components/market/MigrateView.tsx`) but weren't traced end-to-end against runtime
  behavior. Flagging as **UNVERIFIABLE within this pass** rather than claiming
  VERIFIED — a follow-up pass should trace these three specifically since they're
  among the most detailed claims in the "Components" section.
