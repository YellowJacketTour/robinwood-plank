# Grok findings: forensic dossiers + Hollywood/HUD design for the Biggest Buyer Board (2026-08-26)

Response to the operator's own framing for the just-renamed "$PLANK King of
the Hill" → **Biggest Buyer Board** (leaderboard: "Board of Biggest Buys"),
a real, live 31-day on-chain competition launching 08:08 CDT 2026-08-26:
*"research all the details a forensic scientist in the CIA and NSA and other
intel agencies would use to research and investigate useful insights for
this season event and to organize it with Hollywood studio quality
theatrics and HUD quality display graphic immersion."* Read literally, that
is two separable questions layered on top of the already-shipped fraud-gate
pipeline (`GROK-FINDINGS-plank-koth-fraud-detection-2026-08-25.md`) and the
proposed unified wallet-risk service
(`GROK-FINDINGS-unified-intelligence-layer-2026-08-25.md`, preserved
unmodified — this document does not repeat those two docs' §-content, only
builds on top of it):

1. What additional **forensic insight** (not fraud-gate decisions, which
   already exist) could be surfaced to viewers about a buyer/buy — the kind
   of enrichment a financial-crime analyst assembles into a wallet dossier,
   built on the funding-source graph work already scoped in the unified
   layer doc.
2. What real, citable **visual design discipline** — film/TV "FUI"
   (fictional user interface) design, and real live-data command-center
   design (NASA mission control, Bloomberg Terminal, esports broadcast
   overlays) — could make the live leaderboard feel like a real
   command-center experience instead of a plain data table, without
   becoming kitsch or breaking accessibility/usability.

Same conventions as the prior two docs in this series: fail-closed, never
fabricate a number/incident/technique, every claim source-labeled, and
anything not independently verifiable is flagged as such rather than
invented. "CIA/NSA level" is answered honestly below: no non-public
intelligence tradecraft is claimed or invented anywhere in this document.
Where the ask gestures at classified capability, that is stated plainly.

---

## 1. Real forensic wallet dossier generation

**Block:** beyond the fraud GATES (pass/fail decisions already built), what
real, verifiable enrichment data could be assembled and displayed for a
given buyer wallet — the "dossier" a financial-crime analyst would pull
together, not a verdict but a profile?

**Real, verified dossier conventions:**

- **Chainalysis Reactor** is a real, publicly documented investigative tool
  whose actual UI (demonstrated in Chainalysis's own public product videos
  and training materials) centers on a **wallet/entity summary panel**
  showing: total exposure by counterparty category (exchanges, mixers,
  darknet markets, etc.), a running balance/transaction timeline, and a
  graph view radiating outward from the subject address to its direct and
  indirect counterparties. ([Chainalysis Reactor product
  page](https://www.chainalysis.com/reactor/)) This is the real-world
  template for "wallet dossier" as a genre: a summary header + a timeline +
  a graph, not a single risk number alone.
- **Arkham Intelligence's own public wallet-profile pages** (arkhamintelligence.com,
  freely browsable without an account for many addresses) are a second,
  independently verifiable real example of a public-facing wallet dossier:
  entity label (if known), portfolio balance, historical PnL, a
  transaction feed, and labeled counterparties. This is the closest real,
  publicly viewable precedent (no paywall, no enterprise contract needed)
  for what a dossier panel can look like on a public-facing product like
  RobinWood's, as opposed to Reactor's investigator-only tooling.
- **Etherscan's own address page** (etherscan.io/address/...) is the most
  widely used real-world "wallet dossier" of all — first-seen date is not
  itself directly labeled, but is trivially derivable (oldest transaction
  in the history tab), tags/labels, token holdings, and transaction
  history are the baseline fields every practitioner in this space expects
  a wallet profile to carry, and RobinWood's own Robinhood Chain
  Blockscout instance exposes the equivalent data for free today (same
  data source already relied on throughout the KOTH and unified-layer
  docs).

**Solution design — fields buildable from data RobinWood already has or has
already scoped:**

| Dossier field | Real source in this repo/chain | Status |
|---|---|---|
| **Wallet age** (time since first tx on Robinhood Chain) | Blockscout's own address-history endpoint, oldest tx timestamp | Free, buildable now — same RPC discipline (FBC/singleflight) as rest of repo |
| **Total historical volume** (all-time tx count/value on-chain, not just this contest) | Blockscout address endpoint aggregate | Free, buildable now |
| **Funding-source chain depth** | `lib/boards.ts`/`wallet-signals` 2-hop funding check already built in the KOTH pipeline — this is the exact signal, just displayed instead of only gated on | Already built — display-only reuse, no new detection logic |
| **Holding-pattern classification** (diamond-hands vs. flipper) | Derivable from the wallet's own post-buy sell/transfer history for $PLANK specifically — a simple rule (held past N hours/days with no sell = diamond-hands; sold within N minutes/hours = flipper) is a **display heuristic**, not a fraud-gate decision, and should be labeled as descriptive, not a risk score | Buildable now, new but small logic |
| **Cross-reference against Bad Boards/wallet_signals** | Direct read of the `wallet_signals` table proposed in the unified-layer doc's §6 v1 (or, if that table isn't yet live, direct reads of `boards-store.ts`'s existing violation history) | Buildable now if unified-layer v1 ships first; otherwise a smaller direct read against Bad Boards' existing store |
| **ENS name (if any)** | ENS reverse-resolution, already flagged in the unified-layer doc §4 as a near-zero-cost RPC call | Buildable now |

**What you get:** a real, dossier-shaped enrichment panel modeled on
genuinely public precedent (Arkham's public profile pages, Etherscan's
address page, Reactor's documented summary-panel layout) — every field maps
to data RobinWood already has or has already scoped in a prior doc, so this
is presentation work layered on existing pipelines, not new detection
capability.

**What you don't get:** true identity attribution (same limit stated in the
unified-layer doc's §4 — no dossier field here claims to unmask a real-world
person) and no invented severity score; "diamond-hands vs. flipper" is
explicitly a **descriptive** label for viewer color, not a fraud signal, and
must be visually and semantically kept separate from the fraud-gate pass/
fail status so viewers never confuse "this wallet holds long" with "this
wallet is verified clean."

**Confidence:** High that Chainalysis Reactor's summary-panel-plus-graph
layout and Arkham's public wallet-profile format are real, correctly
described products (primary sources: their own product pages). High that
every proposed field is buildable from data already in this repo's stated
scope. Medium on the exact thresholds for "diamond-hands vs. flipper"
classification — that is a product/design choice, not a forensics fact, and
should be tuned rather than treated as objectively correct.

---

## 2. "Story reconstruction" for a single transaction

**Block:** is there a real, citable technique or tool for narrating a
complex multi-hop DeFi transaction back into a human-readable story ("Wallet
X received funds from Y, swapped via Uniswap Universal Router, bought at N%
above the 1h TWAP")?

**Real, verified tools that already do exactly this:**

- **Etherscan's own "transaction interpretation" / "Action" summary line**
  — Etherscan's transaction-detail pages already display a plain-English
  summary above the raw log data (e.g., "Swap X USDC For Y TOKEN On
  Uniswap V3") generated from decoded method calls and known contract
  ABIs/labels. This is a real, live, publicly viewable feature on
  etherscan.io transaction pages today, and is the most directly
  comparable real precedent for "story reconstruction," at the free/public
  tier.
- **BlockSec's Phalcon Explorer** is a real, publicly documented
  transaction-tracing tool built specifically to visualize and narrate
  complex DeFi call traces as a readable flow diagram (call tree +
  token-flow diagram + human-readable labels per hop), marketed explicitly
  for exactly this "make a complex multi-hop tx understandable" use case.
  ([BlockSec Phalcon](https://phalcon.blocksec.com/)) This is real,
  independently verifiable product prior art for a hop-by-hop visual
  narrative, not just a text summary.
- **Tenderly's transaction simulator/debugger** publicly documents a call-
  trace UI (nested function calls, token transfers, state changes) used
  broadly by DeFi developers for exactly this kind of post-hoc
  reconstruction, and is a real, widely used product in this space.
  ([Tenderly](https://tenderly.co/transaction-simulator)) Its trace view
  is the closest real analog to "reconstruct what actually happened, in
  order," though it is developer-facing rather than narrative-prose by
  default.

**Solution design for RobinWood specifically:**

1. **A template-based narrative generator, not free-text generation from an
   LLM at request time**, is the right-sized and most defensible approach
   for a public leaderboard: for each known, whitelisted interaction shape
   already scoped in the KOTH pipeline (canonical-pool buy, router-attributed
   buy, funding-then-buy pattern), fill a fixed sentence template with the
   real decoded values — e.g. `"{wallet} funded from {funding_source}
   {n_hops} hop(s) prior, then bought {amount} $PLANK via {router_name} at
   {pct}% {above/below} the {window} TWAP."` This mirrors Etherscan's
   pattern-matched summary line (decode known shapes, fill a template) far
   more closely than it mirrors an open-ended LLM narrative, and avoids the
   real risk of an LLM inventing a plausible-sounding but factually wrong
   step in a fraud-adjacent public display — a genuinely serious failure
   mode this document explicitly refuses to paper over.
2. **A visual trace strip modeled on Phalcon/Tenderly's hop-by-hop flow**
   (funding wallet → buyer wallet → router → pool, each node a small
   labeled chip) alongside the sentence, not instead of it — this is where
   the "Hollywood" value actually lives (§3/§4 below), while the sentence
   carries the actual verified facts.
3. Every fact in the sentence must trace to a field already computed by
   the KOTH pipeline or the dossier fields in §1 above — this is a **display
   layer over existing verified data**, never a new inference engine
   inventing facts about intent ("trying to manipulate the price") that the
   fraud gates themselves don't already assert.

**What you get:** a real, citable pattern (Etherscan template summaries +
Phalcon/Tenderly trace visualization) applied to data RobinWood has already
verified, with no new unverified claims introduced by the storytelling
layer itself.

**What you don't get:** an LLM-narrated, free-form story — that is
explicitly rejected here as a reliability risk for a public, fraud-adjacent
display where a hallucinated detail (wrong router name, invented
"suspicious" framing) would be actively harmful to trust in the contest,
not merely cosmetic.

**Confidence:** High that Etherscan's summary line, Phalcon, and Tenderly
are real, correctly described, independently verifiable products (primary
sources are each vendor's own product pages/live product). High on the
"template over free-text-generation" recommendation, reasoned directly from
the stated reliability risk, not a stylistic preference.

---

## 3. FUI (fictional user interface) design language

**Block:** what real, documented visual conventions exist in the film/TV
"FUI" discipline, and which are safely borrowable for a real, accessible web
product without becoming kitsch?

**Real, verified facts about the FUI discipline:**

- **"FUI" (Fictional User Interface, also called "screen graphics" or
  "graphic design for film") is a real, named design discipline** with
  real practicing studios, not an informal fan term. **Territory Studio**
  is a real, London-based studio publicly credited for the on-screen
  graphics/HUD design in *Blade Runner 2049*, *Ghost in the Shell*, the
  Marvel Cinematic Universe's UI work (Iron Man's HUD, Avengers'
  helicarrier displays), and *The Martian* — this is documented on
  Territory Studio's own public portfolio site and widely corroborated in
  film-industry press coverage and craft interviews.
  ([Territory Studio](https://territorystudio.com/)) This is a real,
  citable, non-fictional practitioner to point to, not an invented
  attribution.
- **The "GUI reel" / motion-graphics demo-reel culture** around FUI
  artists is real and documented — practitioners in this field (Territory
  Studio and others such as Trollbäck+Company, Momentum Design Lab) publish
  breakdown reels and case studies of specific film UI work, and this
  practice is discussed in industry press (e.g., Art of the Title, Motionographer)
  covering film title/UI design as a craft. This document does not name a
  specific breakdown reel URL beyond Territory Studio's own site, since
  individual reel URLs were not independently re-verified in this pass —
  flagged rather than guessed.
- **Documented recurring FUI visual motifs** (verifiable by direct
  observation of the named, real films above, which is itself a valid form
  of primary-source verification for a visual-design claim, distinct from
  claiming a written spec exists): radar/scanning sweep animations, glitch/
  scan-line texture accents, hexagonal or triangular grid backgrounds,
  thin-line telemetry-style corner brackets framing a focal element,
  monospace/technical-looking typefaces for data readouts, and a
  restrained cyan/amber/red color vocabulary for status states. These are
  genuinely recurring, observable patterns across the named films, not an
  invented list.

**Solution design — what transfers to a real, accessible web page without
becoming kitsch:**

1. **Corner brackets and thin-line framing** around key stat panels (the
   live tick, the #1 leader card) — cheap, real FUI-derived visual
   language, and functionally harmless: it's decorative framing, not
   interactive, so it carries zero accessibility risk if implemented as
   pure CSS border/pseudo-element decoration that doesn't interfere with
   focus outlines or screen-reader flow.
2. **Monospace data readouts** for numeric fields (price ticks, buy
   amounts, wallet addresses) — this is not just FUI borrowing, it is
   independently good real-world data-display practice (monospace digits
   don't reflow/jitter as values update), so it is a rare case where the
   "theatrical" choice and the "usability" choice are the same choice.
3. **Subtle scan-line/glitch accents used only as a state transition**
   (e.g., a brief 150–250ms flicker when a new #1 leader is set), never as
   a persistent background texture — persistent glitch textures are a real,
   well-documented accessibility hazard for photosensitive users and for
   general readability, so this document explicitly recommends against any
   *continuous* glitch/scan-line animation, only a rare, short, skippable
   one gated behind `prefers-reduced-motion` respecting the real CSS media
   feature.
4. **Hex-grid backgrounds** — real FUI motif, safe as a low-contrast static
   or near-static background texture behind content, never as a moving
   layer directly behind readable text (contrast/readability risk).
5. **A restrained cyan/amber/red status vocabulary** — directly reusable
   for the fraud-gate/dossier status already built (verified/flagged/
   pending), and gives the "theatrics" ask a real functional payoff:
   color-as-status is both a real FUI convention and a real command-center
   convention (§4), so it should carry actual meaning (gate status), never
   be purely decorative.

**What you get:** a real, named design discipline with a real, verifiable
practitioner (Territory Studio) to point to, and a short list of motifs that
are genuinely observable in the cited films, filtered down to the subset
that is safe for a real, accessible, fast-loading web dashboard.

**What you don't get:** a claim that any specific breakdown reel, technical
spec document, or "FUI style guide" exists publicly beyond Territory
Studio's own portfolio site — no such canonical written spec was found or
is claimed here, and motif descriptions above are sourced to direct
observation of the named, real films plus general film-design press
coverage, not to a single authoritative document.

**Confidence:** High that Territory Studio and its named film credits are
real and independently verifiable (studio's own site, widely corroborated
industry coverage). Medium-High on the specific recurring-motif list — real
and observable, but compiled from general familiarity with the genre rather
than a single citable "FUI motif taxonomy" document, which does not appear
to publicly exist as a single canonical source.

---

## 4. Command-center / mission-control dashboard conventions

**Block:** what do NASA mission control, Bloomberg Terminal, and live
esports broadcast overlays — real, working, non-fictional live-data displays
under genuine time pressure — do differently from a plain web dashboard?

**Real, verified conventions:**

- **NASA Mission Control Center (MCC-H) console design** is real and
  publicly documented: individual flight-controller consoles are each
  scoped to one narrow responsibility (a real, long-standing MCC principle
  — each console/"backroom" owns one system domain), with status displayed
  via a strict, consistent **color-coding convention** (green = nominal,
  yellow = caution, red = alarm/action-required), a convention documented
  in NASA's own public materials on Mission Control operations and widely
  corroborated in public tours/press coverage of the Houston MCC.
  ([NASA — Mission Control
  Center](https://www.nasa.gov/johnson/exploration/systems/mission-control-center))
  The transferable principle: **hierarchy by responsibility, not by
  decoration** — each panel shows exactly the data relevant to one
  decision, and status color is a strict, limited, consistently-applied
  vocabulary, never a rainbow of decorative color choices.
- **Bloomberg Terminal** is real, live, and its actual documented design
  choices (widely discussed in design/UX press and by Bloomberg itself in
  public interviews about the Terminal's interface) are: extremely dense
  information-per-pixel, a functional (not purely aesthetic) use of
  color-coding for price direction (its own well-known convention: green
  for up-ticks, red for down-ticks — the exact convention RobinWood's own
  live tick already uses), monospace/tabular numeric alignment so values
  are scannable at a glance without re-reading labels, and deliberately
  minimal chrome/decoration around the data itself — the terminal's
  visual identity comes from information density and consistent
  color-coding, not ornamentation.
- **Live esports broadcast overlays** (observable directly in any major
  published broadcast — e.g., League of Legends Worlds, Counter-Strike
  majors — a valid primary-source-by-direct-observation basis for a visual-
  design claim) use **motion sparingly and purposefully**: a scoreboard/
  gold-difference bar updates continuously but *quietly* (smooth numeric
  tween, no attention-grabbing animation on routine updates), while a truly
  significant event (a kill, an objective) triggers a distinct, brief,
  higher-motion callout (a flash, a slide-in banner) — the real convention
  is **motion budget reserved for genuinely rare, meaningful events**, with
  routine data refresh kept calm specifically so the rare event reads as
  meaningful by contrast.

**Solution design — what a live 31-day leaderboard should borrow:**

1. **Strict, limited color vocabulary tied to real state, never decorative**
   — reuse the tick's existing green/red/flat convention (already shipped)
   as the base, and extend the *same* limited palette (not a new one) to
   fraud-gate status (verified = calm green/neutral, flagged = amber,
   rejected = red) — directly mirroring MCC's nominal/caution/alarm
   convention and Bloomberg's up/down convention, so color always means
   the same thing everywhere on the page.
2. **Motion budget discipline** — routine leaderboard re-sorts (a wallet
   moves from #4 to #3) should animate calmly (a smooth position
   transition, sub-second), while a genuinely rare event — a **new #1
   leader** — earns the one large, deliberate motion moment on the page
   (see §5's Fallen Champions design), directly reusing the esports
   convention of reserving high-motion treatment for rare, meaningful
   events so it doesn't compete with itself.
3. **Density with hierarchy, not clutter** — Bloomberg's lesson is not
   "cram everything in," it's "make the one thing that matters at a glance
   (price direction, in RobinWood's case the current #1 leader and the
   live tick) unmistakable through position and color, while denser
   supporting data (the dossier from §1) is available on demand (expand/
   click) rather than always fighting for the same visual weight." This
   argues for keeping the current leaderboard table's default view lean
   (rank, wallet, amount, tick-style highlight) and putting the forensic
   dossier (§1) and story reconstruction (§2) behind a per-row expand,
   not inline in every row by default.
4. **Consistent monospace alignment for all numeric columns** (buy
   amounts, ranks, prices) — same real Bloomberg-derived, genuinely
   functional (not just aesthetic) recommendation as §3's monospace point.

**What you get:** three real, independently verifiable, non-fictional
live-data-under-pressure disciplines (NASA MCC, Bloomberg, esports
broadcast) whose actual documented/observable conventions point to the same
underlying principle from three different domains: **strict, meaningful
color vocabulary + reserved motion budget + density-with-hierarchy**, which
is a strong, convergent, low-risk design basis precisely because it is not
one source's opinion.

**What you don't get:** a claim that RobinWood should literally replicate
NASA console layouts or Bloomberg's full information density — both are
built for trained, repeat-use professional operators; a public, first-time-
visitor leaderboard needs a much shallower learning curve, so the borrowing
here is principles (limited color vocabulary, reserved motion, hierarchy),
not literal layout cloning.

**Confidence:** High on NASA MCC's public color-coding convention and
Bloomberg's public green/red and density characteristics (both widely and
consistently documented/corroborated). High on esports overlay motion
convention as a direct-observation claim about real, published broadcasts
(verifiable by watching any major tournament VOD), though no single
academic citation names this "motion budget" principle under that exact
term — it is this document's own synthesis of an observable, consistent
pattern, stated as such rather than attributed to a source that doesn't
exist.

---

## 5. Concrete synthesis for THIS competition: Board of Biggest Buys + Fallen Champions

**Block:** given the real, already-shipped baseline — a React/Next.js
dashboard with a live WebSocket ETH/USD tick (green/red/flat coloring), a
leaderboard table, and a real fraud-gate backend — what real, buildable v2
visual/informational upgrade earns the "Hollywood theatrics" framing without
becoming a rewrite or hurting speed/readability, and how should the new
**Fallen Champions** history (every wallet that WAS #1 before being
dethroned) actually be visualized?

**Solution design — v2 as enhancement, not rewrite:**

1. **Keep the existing tick component's color convention as the page's one
   source of truth for color meaning** (§4) — every new status color
   (dossier "diamond-hands" tag, fraud-gate flag) must be drawn from the
   same limited palette already established by the live tick, not a new
   palette invented for the leaderboard.
2. **Board of Biggest Buys (current leaderboard) — additive changes only:**
   - Add thin corner-bracket framing (§3) around the #1 row only — visually
     promoting it as "the current champion" without restyling every row
     (cheap, scoped, real FUI motif, zero accessibility risk as pure
     decorative border).
   - Add a per-row expand (§4 point 3) revealing the §1 dossier fields and
     §2 story-reconstruction sentence + trace strip — keeps the default
     table lean and fast (Bloomberg's density-with-hierarchy lesson) while
     making the forensic depth available on demand.
   - Reserve a single large motion moment (§4 point 2) for the actual
     event that matters most in this contest: **a new #1 buy**. When it
     happens, a brief (under 1s), `prefers-reduced-motion`-respecting
     highlight sweep across the new #1 row, not a persistent animation —
     this is the one moment in the whole page where "Hollywood" motion is
     earned by matching a genuinely rare, meaningful state change.
3. **Fallen Champions — a new section, real historical record, not just
   another table:**
   - **Content:** every wallet that held the #1 spot before being
     dethroned, in chronological order, each entry carrying: wallet
     address (+ ENS if available), the buy amount that made them #1, how
     long they held #1 (duration), and the buy amount that dethroned them.
     This is a real, fully derivable history from the contest's own
     event log — no new detection logic, purely a durable record of state
     transitions the leaderboard already computes.
   - **Visualization — a horizontal "reign timeline" strip, not a plain
     table:** each fallen champion renders as a card on a horizontal
     timeline (oldest reign on the left, most recent fall on the right),
     card width or a small bar proportional to **reign duration** (a real,
     honest, non-gamed metric — how long they actually held #1), with the
     buy amount displayed as a simple monospace figure per card (§3/§4
     monospace convention) rather than a chart that could mislead on a
     value that isn't actually continuous. This borrows the esports
     "match timeline" broadcast convention (a real, observable pattern in
     tournament broadcasts showing a sequence of game states left-to-right)
     more than it borrows any fictional-film convention, because a real
     timeline of real past events is closer in kind to a match history
     than to a movie HUD.
   - **A "current champion" card is visually distinct and always
     rightmost/newest** in the strip (or pinned separately above it, still
     using the shared bracket-framing from point 2), so a viewer never
     confuses "the reigning #1" with "a fallen champion" — a clear,
     load-bearing visual distinction, not just a label, since confusing
     these two states would actively mislead about who currently holds the
     largest buy.
   - **Explicitly avoid:** a bar chart ranking fallen champions by buy
     amount as the primary framing — that re-litigates "who bought more"
     after the fact, which is exactly the information already served by
     the live leaderboard; Fallen Champions' actual narrative value is
     **sequence and reign duration** (the story of who held the crown and
     for how long), and the design should foreground that, not duplicate
     the amount-ranking the main board already shows.
4. **Performance/build-scope discipline:** every element above (corner
   brackets, monospace, single-event motion sweep, timeline strip) is
   implementable as CSS/small-component work on top of the existing React/
   Next.js dashboard and existing WebSocket tick — none requires a new data
   pipeline beyond a durable log of #1-transition events (a small,
   additive backend change: record `{address, became_leader_at,
   dethroned_at, buy_amount}` rows whenever the leaderboard computes a new
   #1, which is a natural byproduct of logic the leaderboard already runs).

**What you get:** a scoped v2 that is genuinely additive (new CSS/component
work + one small new event-log table), reuses the tick's existing color
system rather than inventing a competing one, and gives Fallen Champions a
real narrative shape (a reign timeline) instead of a second copy of the
main leaderboard's ranking table.

**What you don't get:** a full redesign or a new rendering framework — this
document does not propose replacing the existing dashboard, WebSocket tick,
or fraud-gate backend, all of which are explicitly kept as-is and only
extended.

**Confidence:** High that every proposed element is buildable on the stated
existing stack without new infrastructure beyond one small event-log table.
High on the design reasoning (motion budget, color-vocabulary reuse,
density-with-hierarchy) since it is directly derived from §3/§4's
independently verified, convergent conventions rather than invented for
this section alone. Medium on the exact visual treatment of the reign-
timeline strip (proportional-width cards vs. a fixed-width sequential list)
— both are reasonable, real broadcast-timeline-adjacent patterns, and the
choice between them is a product/design call to validate with an actual
mockup, not a forensics or citation question.

---

## Synthesized recommendation

Across §1–§5, the honest picture is: "CIA/NSA/intelligence agency level"
forensic insight for this contest is best delivered as a **real,
citably-modeled wallet dossier and template-based transaction narrative**
(Chainalysis Reactor's summary-panel-plus-graph shape, Arkham's and
Etherscan's public profile conventions, Etherscan's decoded-summary-line
pattern, BlockSec Phalcon/Tenderly's hop-trace visualization) built entirely
on data and signals RobinWood's own KOTH fraud pipeline and unified
wallet-risk layer already compute or have already scoped — not new
detection capability, and explicitly not free-text LLM narration, which
this document rejects as a reliability risk for a fraud-adjacent public
display. "Hollywood studio quality theatrics and HUD quality display" is
best delivered not by chasing kitsch film-UI cliché but by combining a
narrow, real FUI motif set (Territory Studio-documented corner brackets,
monospace readouts, restrained status color, rare motion moments) with the
independently convergent, genuinely non-fictional command-center
disciplines of NASA Mission Control, Bloomberg Terminal, and esports
broadcast overlays — all three of which land on the same underlying
principle from different domains: strict color vocabulary, reserved motion
budget for rare meaningful events, and density-with-hierarchy rather than
uniform clutter.

**The single most actionable near-term visual/UX change:** ship the
**Fallen Champions reign-timeline strip** (§5) first, ahead of the fuller
per-row dossier expand. It requires only one small additive backend
change (a `{address, became_leader_at, dethroned_at, buy_amount}` event log
that is a natural byproduct of logic the leaderboard already runs), it is
the one new surface that is genuinely new information (not a
re-presentation of the existing leaderboard's ranking), and it is the
single element most likely to deliver the "Hollywood" narrative payoff the
operator asked for — a real, readable history of the season's crown
changing hands — while staying fast, accessible, and honest about what it
shows.
