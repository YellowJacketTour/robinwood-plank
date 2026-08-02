# DESIGN.md token layer — extraction report

Read-only research task. This file is **new** (does not exist elsewhere); it does not
edit `DESIGN.md`. Every value below was traced to a specific line in the real
stylesheet/component code — sources are cited in the tables. Where I could not verify
a value against code, I say so explicitly rather than asserting it.

**Headline finding:** `DESIGN.md` already carries a YAML front-matter block (lines
1–131) that largely *does* match `app/globals.css` — the `colors` section in
particular is accurate token-for-token. So the brief's premise ("the existing
DESIGN.md prose... contains wrong values") holds for a few specific things but not
for the color palette. The real, confirmed problems are: (1) the `rounded` scale is
fabricated and does not match any radius actually used in code, (2) the `spacing`
scale is likewise not a literal extraction, (3) the canonical `on-gold` text color
picked is the *minority* pattern in real buttons, and (4) `typography.display-*`
claims `fontWeight: 700` for a webfont that is loaded with only weight 400 available.
None of this is a contrast/accessibility failure — see the Contrast section, everything
tested passes AA and most pass AAA.

---

## 1. YAML front-matter block, ready to paste

This is a corrected version of the existing block: `colors` and `components`
carry forward (they check out), `rounded`/`spacing` are replaced with either real
observed values or moved to `omitted` where no real scale exists, `on-gold` is
corrected to the majority-pattern value, and the font-weight mismatch is called out
in a comment (YAML has no "this is untrustworthy" field, so I've noted it inline via
the `description`/omitted mechanism plus the discrepancies table below — please read
that table before pasting this over the current block).

```yaml
---
version: alpha
name: RobinWood Product System
description: The shared visual identity and interaction foundation for RobinWood, $PLANK, and every product surface.
omitted:
  - "rounded: no single verified radius scale exists in code — components mix Tailwind's stock radius utilities (4/6/8/12/16/24px, 9999px pill) with bespoke per-component rem values in MarketScaffold.module.css (e.g. 0.55rem/8.8px, 0.8rem/12.8px) that don't align to either scale. See 'Rounded — real observed values' below instead of trusting a fabricated scale."
  - "spacing: same issue — no verified 4/8/12/16/24/32 scale is consistently used; real padding/gap values are continuous rem fractions chosen per component. See 'Spacing — real observed values' below."
colors:
  # Verified against app/globals.css `@theme` (lines 22-55). Accurate as-is.
  gold-500: "#E9B43F"      # primary interaction / selected state / brand gold
  gold-400: "#EEC164"      # hover state for gold-500 controls
  gold-300: "#F8D98A"      # soft gold — display headings, prices, important values
  gold-600: "#AF761D"      # deep gold, decorative/gradient use only
  wood-950: "#1B120A"      # darkest wood — header/nav surface, and the majority on-gold button text color (see on-gold note)
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
  border-line: "rgba(233,180,63,0.24)"
  border-line-strong: "rgba(233,180,63,0.5)"
  bg-panel: "rgba(28,16,8,0.94)"
  bg-panel-soft: "rgba(41,26,15,0.88)"
  bg-panel-strong: "rgba(17,10,5,0.97)"
  page-background: "#14100B"   # literal `body { background-color }` (globals.css:70) — NOT a @theme token, kept as a documented one-off. See "Known inconsistencies" already in DESIGN.md prose.
on-gold: "#1B120A"    # CORRECTED from #261105. text-wood-950 is the color actually used on bg-gold-500 in the overwhelming majority of call sites (Nav.tsx, Hero.tsx, Gallery.tsx, ConnectWalletModal.tsx, NftViewer.tsx, MintPanel.tsx, CopyCA.tsx, RarityInsights.tsx, Distribution.tsx). #261105 survives in exactly 3 call sites (components/admin/ui.ts:11, SiteBanner.tsx:50, MigrateBanner.tsx:65) as a hand-picked near-duplicate, not the canonical value. Both pass WCAG AA/AAA on gold-500 (contrast ~9.7 vs ~9.5) so this is a naming-convention fix, not an accessibility fix.
typography:
  display-xl:
    fontFamily: Uncial Antiqua
    fontSize: 3.6rem       # clamp() ceiling in MarketScaffold.module.css .title — NOT a fixed size, see discrepancy note
    fontWeight: 700        # UNVERIFIABLE AS RENDERED — see discrepancy note: font is loaded with weight "400" only
    lineHeight: 0.95
    letterSpacing: -0.02em
  display-md:
    fontFamily: Uncial Antiqua
    fontSize: 2rem         # clamp() ceiling, .sectionTitle — see discrepancy note
    fontWeight: 700        # same font-weight caveat as display-xl
    lineHeight: 1.05
  label:
    fontFamily: Nunito Sans
    fontSize: 0.6875rem
    fontWeight: 900
    lineHeight: 1.2
    letterSpacing: 0.12em
  # "body" typography entry removed — I could not find a single component or
  # global rule that produces exactly 0.875rem / 700 / 1.35 line-height as a
  # named combination; body{} sets font-weight:700 globally but font-size and
  # line-height are set ad hoc per component (mostly Tailwind text-sm, which is
  # 0.875rem/1.25rem = line-height 1.4286, not 1.35). See discrepancy note.
rounded:
  # Real Tailwind utility scale in use (stock v4 defaults, no --radius override
  # found in app/globals.css or a tailwind.config file — this project has none,
  # it's CSS-first Tailwind v4). These are the values components actually emit.
  sm: 4px    # rounded (DEFAULT)
  md: 6px    # rounded-md
  lg: 8px    # rounded-lg — the most common button radius
  xl: 12px   # rounded-xl — the most common panel/card radius
  2xl: 16px  # rounded-2xl
  pill: 9999px  # rounded-full
spacing:
  # Tailwind's stock spacing scale (4px steps) is used throughout via padding/gap
  # utilities (p-4=16px, p-3=12px, p-2.5=10px, etc.) but no fixed named subset
  # (xs/sm/md/lg/xl/2xl) is consistently applied — see "Spacing" section below
  # for the actual observed values per surface. Kept minimal here to avoid
  # fabricating a scale the code doesn't follow.
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
    padding: 0px
  panel:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.cream}"
    rounded: "{rounded.xl}"    # CORRECTED: real call sites use rounded-xl (12px), not a "lg" that equals 12px under a different name
    padding: 16px              # CORRECTED: Distribution.tsx/MintAllocation.tsx use p-4 (16px); TrustFacts.tsx similar. p-3/p-2.5 (12px/10px) also occur — see Spacing section
  data-panel:
    backgroundColor: "{colors.bg-panel-strong}"
    textColor: "{colors.cream}"
    padding: 12px    # rounded intentionally omitted — .data-module (globals.css:732) only sets background-color; radius is caller-supplied and varies
  button-primary:
    backgroundColor: "{colors.gold-500}"
    textColor: "{on-gold}"
    typography: "{typography.label}"   # verified exact match: components/admin/ui.ts:11 uses text-[0.6875rem] font-black tracking-[0.12em] — identical to typography.label
    rounded: "{rounded.lg}"   # rounded-lg (8px) is the dominant button radius (Nav.tsx, Gallery.tsx, NftViewer.tsx, MintPanel.tsx, ConnectWalletModal.tsx); admin/ui.ts uses rounded-md (6px) as the one exception
    height: 44px    # min-h-11/min-h-12 (44/48px) confirmed across Nav.tsx, NftViewer.tsx, ConnectWalletModal.tsx, MigrateBanner.tsx
  button-secondary:
    backgroundColor: "{colors.bg-panel-strong}"
    textColor: "{colors.gold-300}"
    rounded: "{rounded.lg}"
    height: 44px
  verified-badge:
    backgroundColor: "#58BDF0"
    textColor: "#07131A"
    rounded: "{rounded.pill}"
    size: 22px    # MarketScaffold.module.css .verified: 1.35rem = 21.6px, rounds to 22px
  status-success:
    backgroundColor: "{colors.bg-panel-strong}"
    textColor: "#34D399"   # Tailwind emerald-400 literal — no custom token exists (see omitted note in DESIGN.md prose, unchanged)
  status-error:
    backgroundColor: "{colors.bg-panel-strong}"
    textColor: "#FB7185"   # Tailwind rose-400 literal (most common of the red-*/rose-* call sites) — no custom token exists
  metadata:
    backgroundColor: "{colors.bg-panel-strong}"
    textColor: "{colors.cream-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
  site-header:
    backgroundColor: "{colors.wood-950}"   # bg-wood-950/90, Nav.tsx:194
    textColor: "{colors.cream}"
    borderColor: "{colors.gold-500}"       # border-gold-500/25
    mobileHeight: 58px   # h-[58px], Nav.tsx:194 — verified exact
    desktopHeight: 68px  # lg:h-[68px], Nav.tsx:194 — verified exact
  site-footer:
    backgroundColor: ".site-footer-surface (app/globals.css:172-184)"
    textColor: "{colors.cream-muted}"
    borderColor: "{colors.gold-500}"
---
```

---

## 2. Token source table

| Token | Value | Source (file:line) | Status |
| --- | --- | --- | --- |
| gold-500 | `#E9B43F` | `app/globals.css:37` | Verified |
| gold-400 | `#EEC164` | `app/globals.css:38` | Verified |
| gold-300 | `#F8D98A` | `app/globals.css:39` | Verified |
| gold-600 | `#AF761D` | `app/globals.css:36` | Verified |
| wood-950 | `#1B120A` | `app/globals.css:26` | Verified |
| wood-900 | `#2A1A0F` | `app/globals.css:27` | Verified |
| wood-850 | `#302013` | `app/globals.css:28` | Verified |
| wood-800 | `#3D2513` | `app/globals.css:29` | Verified |
| wood-700 | `#5C3A1E` | `app/globals.css:30` | Verified |
| wood-600 | `#7A4D26` | `app/globals.css:31` | Verified |
| forest-900 | `#0D1F16` | `app/globals.css:32` | Verified |
| forest-800 | `#123322` | `app/globals.css:33` | Verified |
| forest-700 | `#1A4A30` | `app/globals.css:34` | Verified |
| forest-600 | `#24693F` | `app/globals.css:35` | Verified |
| cream | `#FFF2CF` | `app/globals.css:45` (= `--foreground`, `globals.css:5`) | Verified |
| cream-muted | `#C9B58A` | `app/globals.css:46` | Verified |
| border-line | `rgba(233,180,63,0.24)` | `app/globals.css:47` | Verified |
| border-line-strong | `rgba(233,180,63,0.5)` | `app/globals.css:48` | Verified |
| bg-panel | `rgba(28,16,8,0.94)` | `app/globals.css:49` | Verified |
| bg-panel-soft | `rgba(41,26,15,0.88)` | `app/globals.css:50` | Verified |
| bg-panel-strong | `rgba(17,10,5,0.97)` | `app/globals.css:51` | Verified |
| page-background | `#14100B` | `app/globals.css:70` (`body { background-color }`, not a `@theme` token) | Verified, documented one-off |
| on-gold | `#1B120A` (wood-950) | `components/Nav.tsx:115`, `Hero.tsx:91`, `Gallery.tsx:411/425/1383`, `ConnectWalletModal.tsx:318/390`, `NftViewer.tsx:474/1016/1151/1259`, `MintPanel.tsx:237`, `CopyCA.tsx:34`, `Distribution.tsx:46` | Corrected — majority pattern |
| on-gold (minority variant, not canonical) | `#261105` | `components/admin/ui.ts:11`, `SiteBanner.tsx:50`, `MigrateBanner.tsx:65` | Real, but 3 call sites vs. 13+ using wood-950 |
| --font-stencil | Uncial Antiqua, `weight: "400"` only | `app/layout.tsx:15-19` | Verified — single weight |
| --font-body | Nunito Sans, no explicit weight (variable) | `app/layout.tsx:21-24` | Verified |
| site-header mobileHeight | 58px | `components/Nav.tsx:194` (`h-[58px]`) | Verified |
| site-header desktopHeight | 68px | `components/Nav.tsx:194` (`lg:h-[68px]`) | Verified |
| verified-badge size | 1.35rem = 21.6px → 22px | `MarketScaffold.module.css:87-97` | Verified (rounded from rem) |
| verified-badge bg/text | `#58bdf0` / `#07131a` | `MarketScaffold.module.css:93-94` | Verified |
| typography.label | 0.6875rem / 900 / 0.12em | `components/admin/ui.ts:11` (`text-[0.6875rem] font-black tracking-[0.12em]`) | Verified exact match |
| status-success | `#34D399` (Tailwind emerald-400) | Convention per DESIGN.md prose (no custom token); representative call sites use Tailwind `emerald-400` class | Verified as stock Tailwind value, not searched call-by-call |
| status-error | `#FB7185` (Tailwind rose-400) | Convention per DESIGN.md prose (no custom token) | Verified as stock Tailwind value |
| button-primary rounded | 8px (`rounded-lg`) | `Nav.tsx:115`, `Gallery.tsx:411`, `NftViewer.tsx:474`, `MintPanel.tsx:237`, `ConnectWalletModal.tsx:318` | Verified — dominant pattern |
| button-primary rounded (exception) | 6px (`rounded-md`) | `components/admin/ui.ts:11` | Verified, minority |
| button-primary height | 44-48px (`min-h-11`/`min-h-12`) | `Nav.tsx:115`, `NftViewer.tsx:1259`, `ConnectWalletModal.tsx:318/390` | Verified |
| panel rounded | 12px (`rounded-xl`) | `Distribution.tsx:42`, `MintAllocation.tsx:31`, `TrustFacts.tsx:20` | Verified |
| panel padding | 16px (`p-4`) | `Distribution.tsx:42`, `MintAllocation.tsx:31` | Verified, but not universal (see Spacing section) |
| MarketScaffold `.root` radius | 1rem = 16px | `MarketScaffold.module.css:14` | Verified |
| MarketScaffold `.disclosure` radius | 0.8rem = 12.8px | `MarketScaffold.module.css:201` | Verified — does not land on any clean px value |
| MarketScaffold `.contractLink` radius | 0.55rem = 8.8px | `MarketScaffold.module.css:119` | Verified — does not land on any clean px value |
| MarketScaffold `.filterPanel` radius | 0.75rem = 12px | `MarketScaffold.module.css:306` | Verified |

---

## 3. Contrast results (WCAG AA, 4.5:1 minimum for normal text)

All ratios computed by hand from sRGB relative luminance (standard WCAG formula:
linearize each channel, `L = 0.2126R + 0.7152G + 0.0722B`, `contrast = (L1+0.05)/(L2+0.05)`).
Arithmetic shown for the two representative pairs; results only for the rest.

**cream `#FFF2CF` on wood-950 `#1B120A`** (primary body copy on the darkest surface)
- L(cream) ≈ 0.8928, L(wood-950) ≈ 0.006878
- Contrast = (0.8928+0.05) / (0.006878+0.05) = **16.57 : 1** — passes AA and AAA by a wide margin.

**cream-muted `#C9B58A` on bg-panel-strong `rgba(17,10,5,0.97)`** (metadata on financial-data surfaces)
- L(cream-muted) ≈ 0.4731, L(panel-strong, treated as opaque `#110A05`) ≈ 0.003473
- Contrast = (0.4731+0.05) / (0.003473+0.05) = **9.78 : 1** — passes AA and AAA.

| Pair | Contrast | AA (4.5:1) | AAA (7:1) |
| --- | --- | --- | --- |
| cream on wood-950 | 16.57 : 1 | Pass | Pass |
| cream-muted on bg-panel-strong | 9.78 : 1 | Pass | Pass |
| gold-300 on wood-950 | 13.43 : 1 | Pass | Pass |
| wood-950 text on gold-500 button (actual majority pattern) | 9.73 : 1 | Pass | Pass |
| `#261105` text on gold-500 button (DESIGN.md's original `on-gold`, minority pattern) | 9.50 : 1 | Pass | Pass |
| `#07131A` text on verified-badge `#58BDF0` | 8.91 : 1 | Pass | Pass |
| gold-500 (`.eyebrow`/`.contractLink` text) on wood-950-ish hero background | ~10.1 : 1 | Pass | Pass |

**No accessibility failures found** among the primary text-on-surface pairings tested.
This project's palette is unusually high-contrast by construction (near-black wood
against cream/gold). I did not exhaustively test every hover/disabled/opacity-reduced
state (e.g. `text-cream/80`, `bg-gold-500/10` low-opacity chips) — those introduce
alpha blending against whatever sits behind them and would need per-instance
background context to compute correctly; flagging as unverified rather than assuming
pass.

---

## 4. Discrepancies between current DESIGN.md prose/frontmatter and actual CSS

1. **`rounded` scale is fabricated.** DESIGN.md's frontmatter claims `sm:6px, md:9px,
   lg:12px, xl:16px`. No `--radius` override exists anywhere in `app/globals.css` and
   there is no `tailwind.config.*` file (this is CSS-first Tailwind v4), so the real
   scale is Tailwind's stock one: `rounded-sm=4px, rounded-md=6px, rounded-lg=8px,
   rounded-xl=12px, rounded-2xl=16px, rounded-full=9999px`. The claimed scale is off
   by one full step almost everywhere (claimed `sm`=6 is actually Tailwind's `md`;
   claimed `lg`=12 is actually Tailwind's `xl`). On top of that, `MarketScaffold.module.css`
   uses its own bespoke rem values (`0.55rem`=8.8px, `0.8rem`=12.8px) that land on
   neither scale. Recommend replacing the frontmatter's `rounded` block with the
   corrected one above, or moving it to `omitted` if the owner doesn't want to commit
   to a formal scale yet.

2. **`spacing` scale is not a verified extraction.** The claimed `xs:4, sm:8, md:12,
   lg:16, xl:24, 2xl:32` happens to overlap Tailwind's stock 4px-step scale, but no
   named subset of it is consistently applied — real padding/gap values in
   `MarketScaffold.module.css` are continuous rem fractions chosen per component
   (`0.4rem`, `0.55rem`, `0.85rem`, `0.9rem`, `1.25rem`, `1.35rem`...), not a fixed
   named token set. Treat the scale as "Tailwind's spacing primitives are available"
   rather than "this project has a curated 6-step spacing system."

3. **`on-gold` (`#261105`) is the minority color, not the canonical one.** 13+ call
   sites (`Nav.tsx`, `Hero.tsx`, `Gallery.tsx`, `ConnectWalletModal.tsx`,
   `NftViewer.tsx`, `MintPanel.tsx`, `CopyCA.tsx`, `Distribution.tsx`,
   `RarityInsights.tsx`) use `text-wood-950` (`#1B120A`) as the text color on
   `bg-gold-500`/`bg-gold-400` buttons. Only 3 call sites (`components/admin/ui.ts:11`,
   `SiteBanner.tsx:50`, `MigrateBanner.tsx:65`) use the literal `#261105`. Both pass
   contrast comfortably (9.73:1 vs 9.50:1 — not an accessibility issue), but
   `#261105` is not the value most of the codebase actually uses; the frontmatter
   picked the minority hex as canonical without noting the split.

4. **`typography.display-xl`/`display-md` claim `fontWeight: 700` for a font loaded
   with only weight 400.** `app/layout.tsx:15-19` loads `Uncial_Antiqua({ weight:
   "400" })` — Uncial Antiqua is a single-weight (400/regular-only) Google Font; it
   has no 700 cut available to load. `.title`/`.sectionTitle` in
   `MarketScaffold.module.css` (and `.plank-title`/`.section-title` in
   `globals.css`) do declare `font-weight: 700`/`900`, which browsers will either
   render via faux/synthetic bold or silently clamp to the loaded weight, depending
   on the engine. This is a real, previously undocumented mismatch between the CSS
   declaration and the loaded font asset — worth a decision from the owner (load a
   heavier weight if one exists, or drop the `font-weight` declarations on Uncial Antiqua
   text since they can't do what they claim).

5. **`typography.body` (0.875rem / 700 / line-height 1.35) has no single verified
   source.** `body { font-weight: 700 }` is real (`globals.css:84`), but font-size and
   line-height aren't set as a named "body" style anywhere — most body copy uses
   Tailwind's `text-sm` (0.875rem, but with Tailwind's own line-height of 1.25rem =
   1.4286, not 1.35) or component-specific sizes. I removed this entry from the
   corrected frontmatter rather than assert a value I couldn't trace to a line.

6. **`display-xl`/`display-md` fontSize values (3.6rem / 2rem) are `clamp()` ceilings,
   not fixed sizes.** `.title` in `MarketScaffold.module.css:81` is
   `clamp(2rem, 4.5vw, 3.6rem)`; `.sectionTitle:186` is `clamp(1.35rem, 2.2vw, 2rem)`.
   The frontmatter records only the upper bound, which is directionally fine for a
   token (it's what desktop renders) but should probably be documented as a max, not
   as *the* size, since mobile renders meaningfully smaller (down to 1.35rem for
   section titles).

7. **The existing `colors` block is accurate.** Every hex/rgba value in the current
   `DESIGN.md` frontmatter's `colors` section matches `app/globals.css` `@theme`
   exactly, including the flagged `page-background` inconsistency, which the prose
   already documents correctly. I found no color drift — the brief's premise that
   DESIGN.md's colors are wrong does not hold; the actual gaps are in `rounded`,
   `spacing`, `on-gold`, and the typography font-weight claim.

---

## Notes for whoever merges this with the concurrent prose audit

- Don't just paste block 1 over the existing frontmatter without reading discrepancy
  items 1–6 above — several fields changed value or were removed/annotated, not just
  reformatted.
- I did not touch `DESIGN.md` itself, per instructions.
- Status-success/status-error literal hexes (`#34D399` emerald-400, `#FB7185`
  rose-400) are Tailwind's *default* palette values for those class names, recorded
  here for convenience — I didn't individually grep every one of the 30+ files using
  `emerald-`/`red-`/`rose-` classes to confirm no component overrides the shade, so
  treat those two literals as "what the class name means by default," not "audited
  every call site."
