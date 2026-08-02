# /learn redesign plan

Author: PM pass, 2026-08-02. Scope: what `/learn` should be, not how to code it.
Source audited: `components/learn/LearnGuide.tsx` (33 sections, ~105KB rendered
HTML), `app/learn/page.tsx`, `lib/content-docs.ts` (`LearnDoc`, `sanitizeLearn`),
`components/admin/sections/ContentSection.tsx`.

The owner's brief, verbatim: "/learn has A LOT that really is no one's
business," and "there is not much to learn, that page is more information
overload than anything else." I'm treating that as license to cut hard, not
to trim 10%.

## 1. Who opens /learn, and what do they want

Three real jobs-to-be-done, ranked by how often they actually land on this
page:

- **The panicked/suspicious visitor.** Just got sent a link, saw a weird
  quote, or wants to check "is this a scam" before signing anything. Wants:
  canonical addresses, the chain id, a scam-pattern checklist, in the first
  screen. Everything else is noise standing between them and the thing that
  reassures them.
- **The holder mid-task.** Deposited, is about to redeem, added liquidity,
  hit "insufficient shares," or is deciding whether to migrate out of
  WormWood. Wants a short, correct answer to one question, not a manual.
  Best served by **contextual help on the page where the task happens**, with
  `/learn` as the fallback for anyone who bounced off that and wants more.
- **The undecided trader.** Deciding whether to buy a listing, deposit, or
  trade $PLANK at all. Wants the mental model (plank vs. share vs. $PLANK,
  buy-gets-shares-not-a-plank) and the fee shape, not the reserve math behind
  it.

We explicitly **decline to serve** on this page: engineers/auditors wanting
ABI-level mechanics, curious readers wanting a protocol tour, and — despite
§32's framing — AI scrapers as the *primary* audience. AI citation is a
secondary, structured-data concern, not a reason to keep 33 sections of prose
on the page real people land on.

## 2. Section-by-section: KEEP / CUT / MOVE / MERGE

| § | Section | Call | Why |
|---|---|---|---|
| 0 | Start here | **KEEP** (merged, shortened) | Orientation + the plank/share/$PLANK glossary is the single highest-value paragraph on the page |
| 1 | Map of the system | **CUT → docs/** | Route/contract diagram is dev reference, not a user decision |
| 2 | Site map | **CUT** | Redundant with nav; no one needs a prose sitemap |
| 3 | Robinhood Chain | **MERGE → Safety** | Chain id + explorer are safety-critical, but don't need their own section |
| 4 | Canonical addresses | **KEEP, promoted** | The core scam-prevention artifact of the whole page |
| 5 | $PLANK token | **MERGE → Start here** | One line ("not a share, not needed to buy/sell NFTs") covers it |
| 6 | Trade widget | **MERGE, trimmed** | Fee % and gas-reserve tip are useful; step-by-step belongs as inline help on the Trade widget itself |
| 7 | RobinWood NFT | **CUT** | Trait/royalty detail is gallery/marketing copy, not a decision input |
| 8 | Minting is finished | **KEEP** | Directly prevents a specific scam ("mint" offers on a sold-out collection) |
| 9 | Gallery & rarity | **CUT** | Self-explanatory UI |
| 10 | Airdrop & boards | **CUT → inline** | Belongs next to the airdrop checker widget, not in a manual |
| 11 | Marketplank overview | **MERGE → Trading** | Tab list is UI chrome; fold into one short trading section |
| 12 | Listings | **MERGE, trimmed** | Same |
| 13 | Offers & criteria bids | **MERGE, trimmed — keep WETH gotcha** | "Offers are WETH, not ETH" is the one non-obvious, decision-relevant fact here |
| 14 | Sweep, floors & fences | **CUT** | Self-explanatory UI feature |
| 15 | The pools | **KEEP, heavily trimmed** | Table + WormWood warning are load-bearing; the immutability essay and full fee philosophy go to docs/ |
| 16 | Two layers | **CUT → docs/**, one line kept | Reserve-math explanation is engineering; keep only "depositing puts a share in *your wallet*, not the tradeable pool" as a Note |
| 17 | Held ≫ tradeable depth | **CUT → docs/**, one line kept | Same treatment — keep the reassurance ("thin book ≠ insolvent"), cut the mechanics |
| 18 | Fees: two models | **KEEP, trimmed** | This is the #1 confusion source (old-pool share fees vs. new-pool ETH fees); keep the comparison, cut the "how to clear it" math walkthrough (that's what /migrate's calculator is for) |
| 19 | Deposit & redeem | **KEEP, trimmed — keep the raw-transfer warning verbatim** | "Never raw-transfer a plank to a pool" is irreversible-mistake prevention |
| 20 | Instant Swap modes | **MERGE → Trading** | Keep "Buy gets you shares, not a plank" verbatim; cut the mode-by-mode UI tour |
| 21 | Providing liquidity | **KEEP, cut to ~3 sentences + the WormWood warning (dedup with §15)** | Impermanent-loss explainer and step list are UI-adjacent, not manual content |
| 22 | Random redeem & drand | **MERGE → FAQ** | "Shares are already burned, claim later" is the one thing worth keeping; drand mechanics go to docs/ |
| 23 | Moving out of an old pool | **KEEP, near-verbatim** | Real money at stake for existing WormWood depositors; this is the most protective section on the page |
| 24 | Floorboards | **CUT → one-liner + link** | Feature is self-discoverable from its own page |
| 25 | Activity & sales | **CUT** | Self-explanatory UI |
| 26 | Art, IPFS & cache | **CUT → docs/** | Textbook "no one's business" — image pipeline is pure implementation detail |
| 27 | Seaport | **CUT → docs/** | Protocol name-dropping; irrelevant to a user decision |
| 28 | Wallets & safety | **MERGE → Safety** | Keep the actionable bullets (verify chain, verify addresses before approving); cut the ones describing our own internal checks (simulated eth_call, allowlist enforcement) — that's us describing our own code, not something the user does |
| 29 | Infra dependencies | **CUT → docs/** | The section's own text admits half of it is deliberately withheld; the rest is operational trivia |
| 30 | End-to-end tutorials (A–G) | **CUT → docs/tutorials.md**, 1 folded into FAQ | Long walkthroughs belong as contextual help on each flow, not a wall of numbered lists nobody reads top to bottom |
| 31 | FAQ | **KEEP, expanded** | This is where cut content's residue lands as one-line answers |
| 32 | AI machine summary | **MOVE off-page** | See §5 below |

## 3. Safety-critical minimum (must survive at any length)

If the page were cut to one screen, this is what stays:

1. Canonical contract addresses (§4) + chain id 4663, with "verify on
   explorer before approving."
2. "The collection is minted out — any 'mint' offer is not ours" (§8).
3. "Buy gets you shares, not a plank; Redeem gets you a plank" (§20).
4. "Never raw-transfer a plank to a pool address — no rescue path" (§19).
5. "Do not deposit into or add liquidity to WormWood; use /migrate to exit"
   (§15/§21).
6. "Offers are WETH, not ETH" (§13).
7. Wallet-safety checklist trimmed to user actions, not our internals (§28).

Everything else is negotiable against length; these seven are not.

## 4. Target shape

**Six sections, not thirty-three. Target ~1,200–1,600 words total** (down
from ~105KB of rendered HTML) — a 5-minute read, not a manual.

1. **Start here** — what plank.love is, the plank/share/$PLANK glossary, the
   three ways to get a plank. *(merges §0, §5, §7, §8)*
2. **Stay safe** — canonical addresses, chain id, wallet-safety checklist,
   scam patterns (fake mint, wrong WETH, fake pool address). *(merges §3,
   §4, §28)* — leads the page, not buried at §4.
3. **Buying, selling & trading** — Marketplank listings/offers (with the
   WETH gotcha), the $PLANK trade widget in three sentences, Instant Swap in
   plain terms (buy/sell/deposit/redeem, the buy≠plank warning), the
   old-pool-vs-new-pool fee shape. *(merges §6, §11–13, §15 trimmed, §18–20)*
4. **Providing liquidity** — three sentences: what it is, that it's
   proportional and non-transferable, and the WormWood warning again.
   *(§21, trimmed)*
5. **Moving out of an old pool** — near-verbatim §23. Kept full-length
   because it's the one section actively protecting existing depositors'
   money.
6. **FAQ** — expanded with the one-liners salvaged from cut sections
   (drand claim reassurance, "why is the book thin," "am I stuck").

Everything else — architecture diagrams, reserve math, drand internals,
IPFS/Seaport plumbing, infra dependency list, the six long tutorials —
moves to `docs/` as engineering/developer reference (see below), or becomes
inline contextual help on the page where the task actually happens (Trade
widget, Instant Swap tab, airdrop checker, /migrate, /floorboards). None of
it is deleted outright; it's relocated to where the reader who needs it
already is.

New docs/ files this implies:
- `docs/architecture.md` — system map, route list, contract dependency graph (old §1, §2, §29)
- `docs/pools-technical.md` — two-layer model, reserve math, fee-model derivation, drand mechanics (old §16, §17, §22 detail)
- `docs/tutorials.md` — the six full end-to-end walkthroughs (old §30)
- `docs/ipfs-and-seaport.md` — art/cache pipeline, Seaport integration notes (old §26, §27)

## 5. The AI-scraper JSON (§32)

Keep the machine-readable summary — it's cheap to maintain and genuinely
useful for correct citation — but stop treating it as a *section of the page
users scroll through*. Two changes:

- Move it out of the visible page into a dedicated static endpoint, e.g.
  `public/llms.txt` or `/api/learn/summary`, and reference it from a `<link>`
  tag / footer mention rather than 80 lines of visible JSON.
- Regenerate its content from the new, shorter `/learn` copy so it doesn't
  become the *one place* that still documents 33 sections' worth of internals
  after the page itself has been cut.

## 6. CMS migration — the real decision

`LearnDoc.hidden`/`overrides` are keyed by section id, `sanitizeLearn`
accepts any string matching `/^[a-z0-9][a-z0-9-]{0,63}$/` with no check
against `TOC`, and the admin UI (`ContentSection.tsx`) only ever renders
`TOC.map(...)` — so an id that stops existing in `TOC` doesn't error, it just
becomes **invisible in the admin console** while its data quietly sits in the
stored JSON forever.

Concretely, for the ~24 old ids that are cut or merged away (`map`,
`sites-routes`, `gallery`, `sweep-fences`, `activity`, `art-cache`,
`seaport`, `infra`, `tutorials`, `ai-summary`, etc.), any hidden-flag or text
override an admin previously set on them becomes dead weight the moment the
new `TOC` ships — not destroyed, just orphaned and unreachable.

Given this is effectively a single-admin project, the right process is
manual and one-time, not a migration script:

1. **Before shipping the new TOC**, pull the live `learn` content doc (one
   `GET /api/content/learn` or a DB read) and eyeball `hidden` and
   `overrides` for every id being cut. This is a five-minute check, not
   engineering work.
2. If any cut id has a non-empty override, that's text an admin cared
   enough to write once — copy it into the relevant `docs/*.md` file (it's
   already scoped to exactly the section being relocated) or consciously
   discard it. Either way, it's a human decision made once, not silent loss.
3. For ids that are **repurposed rather than cut** (e.g. `addresses` and
   `wallets` survive as the body of the new "Stay safe" section, `faq`
   survives as-is), follow the file's own rule: keep the key, replace the
   body. Any existing override on that key will now be judged against
   shorter content — flag this explicitly during the check in step 1 rather
   than assuming an old override still reads sensibly against the new copy.
4. **After** steps 1–3, re-save the `learn` doc filtered to only the keys
   present in the new `TOC`, so the stored JSON stops carrying dead ids. Not
   urgent on its own, but do it right after the manual check above rather
   than letting orphaned JSON linger — it's the kind of thing that's cheap
   now and confusing in six months.

No code needs to defend against unknown ids (`sanitizeLearn` already treats
them as harmless), so this is a content operation, not a shipping
prerequisite — it just has to actually happen once, deliberately.

## 7. What I'd measure to know it worked

- **Word count / scroll depth**: page should be a fraction of its current
  size; scroll-depth-to-completion should go *up* even as total scrolling
  goes down (finishing the page becomes achievable).
- **Time-on-page should drop.** Unlike most content, that's the success
  signal here — the owner's complaint was "information overload," so a
  reader finding their answer fast and leaving is the win, not a loss.
- **Support-channel signal** (Discord/X): questions like "is this a scam,"
  "why can't I redeem," "where's my plank" should hold steady or drop for
  the safety-critical content that stayed; if fee-shortfall or
  raw-transfer-mistake questions start climbing after launch, that's the
  canary that something load-bearing got cut too far.
- **Explorer click-throughs** from the "Stay safe" section — a rough proxy
  for whether people are actually verifying addresses instead of skimming
  past them.
- **/migrate and Instant Swap error-rate**, if instrumented — trimming §16–18
  and §21's math should not correlate with more failed/reverted deposit or
  redeem transactions; if it does, more of that detail needed to move to
  inline help on those pages rather than being cut.
