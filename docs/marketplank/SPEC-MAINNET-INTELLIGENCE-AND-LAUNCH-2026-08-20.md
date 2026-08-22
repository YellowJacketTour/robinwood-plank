# Mainnet readiness, marketplace intelligence redesign, and PlankCrash launch — phased spec (2026-08-20)

Status: **spec-only for phases 2 and 3.** Nothing here authorizes building or
deploying anything beyond what's already merged. This exists so the full
scope discussed stays intact and sequenced correctly, rather than getting
lost or shortcut when each phase's turn comes. Phase order is explicit,
owner-set direction, not my own prioritization:

> "after im satisfied with mainnet live all chain all collection all nfts
> all traits all activity live then we'll bring in the plankcrash game...
> i want the most visually immersive nft marketplace..."

Phase 1 gates phase 2 gates phase 3. Do not start a later phase's
implementation before the admin explicitly signs off that the prior phase
is satisfied — that sign-off is the only real gate here, not a date or a
task checklist.

---

## Phase 1 — mainnet data completeness (in progress, gates everything else)

**Bar, in the admin's own words**: every chain, every collection, every
NFT, every trait, every activity feed, all 24h stats, fully live.

**What's actually true right now** (verified this session, not assumed):
- Robinhood Chain: 1,541/1,542 tokens with real IPFS-sourced metadata,
  real computed rarity. Effectively complete.
- 8 foreign EVM chains + Solana + Bitcoin Ordinals: partial, growing via
  `scripts/refresh-market-data.ts`'s discovery scanners. This is bounded
  by real third-party rate limits (Alchemy, OpenSea, Pinata/IPFS gateways
  all hit live 429s this session) and by real elapsed time — the
  production cron design is `*/2 min` incremental + daily `4:17am` full
  pass (`docs/INMOTION_DEPLOYMENT.md` §13), meant to accumulate over
  days/weeks, not one session.
- Avalanche: confirmed real upstream data thinness (both OpenSea and
  Alchemy return null metadata for every candidate contract there) — not
  a bug, not fixable by more scanning passes.
- Solana write-path (bids/sends): blocked on `MAGICEDEN_API_KEY`, not
  present in `.env.local`. Owner-external dependency.
- Bitcoin mainnet: deliberately gated behind
  `NATIVE_BITCOIN_MAINNET_ENABLED`, unset on purpose — a real-money risk
  decision, not a technical readiness question. Testnet4 is fully
  proven (real UniSat extension, real second wallet, real settled trade).
- Foreign-EVM native listing/buy: protocol-level correctness verified
  byte-for-byte against the real `@opensea/seaport-js` SDK and live-proven
  on a Base-mainnet fork. **No real signed transaction with real funds has
  settled on any of the 7 foreign EVM chains yet** — that gap is real and
  explicitly not closed.
- Whether the production cron described above is actually installed and
  running on the live InMotion server is **unconfirmed** — this needs a
  direct `crontab -l` check the owner runs themselves (CI can't do it;
  GitHub Actions here is billing-blocked).

**Definition of done for this phase**: the admin looks at the live
`/market/multichain` surface (via the admin-preview bypass built this
session — `lib/market-preview-auth.ts` — so this can be watched privately
while `MARKET_ENABLED` stays off for the public) and says it's satisfied.
Not a metric threshold either of us invents unilaterally.

---

## Phase 2 — the visual/intelligence-hub redesign

**The stated problem**: "minimalist, mostly wasted space, hardly any art
or useful insights, no intelligence hub feel."

**Research finding, stated honestly**: general web search (including
attempts to search X/Twitter directly) surfaced mostly SEO listicle
content and promotional posts, not substantive primary community
sentiment — that search limitation is real and I'm not going to cite weak
sources as if they were strong ones. What *is* solidly documented about
the actual category leaders (Blur, Tensor): their differentiation is
**data density with real hierarchy**, not decoration — real-time floor
deltas, sweep-depth visualization, live portfolio P&L, aggregated
cross-marketplace liquidity. The "immersive" feeling is a side effect of
information done well, not an art layer on top of a static catalog.

**Proposed direction, concrete:**
1. **Live intelligence strip** — real on-chain activity (sales/listings/
   offers) ticking in as it happens across every tracked chain, not a
   static ranked table refreshed on page load.
2. **Trait/rarity visualization** — a heatmap or radial distribution per
   collection, not just a rank number in a badge.
3. **Full-bleed art expanded** — the existing "Trending now" hero pattern
   (`GlobalMarketHub.tsx`'s `topMovers` hero) extended further across the
   page so art carries real visual weight instead of small uniform
   thumbnails surrounded by empty background.
4. **Wallet-aware insight panel** — connected-wallet P&L and floor-relative
   position on owned items, not just a listings grid.
5. **Motion as information** — price deltas and new listings pulse/animate
   briefly on arrival, respecting `prefers-reduced-motion` (established
   pattern already in this codebase, e.g. the `live-pulse` keyframe from
   the trenches-density design work).

**Explicitly not proposed**: a literal skeuomorphic/retro aesthetic
layered onto the trading core (already ruled out and agreed during the
trenches-density design decision — density and legibility win in the
data-bearing surfaces; character belongs in surrounding chrome).

**Why this phase waits on phase 1**: designing "intelligence" visualizations
around data that's still partial means redesigning around numbers that
are about to change shape once real coverage lands. Building it now would
itself be a shortcut — visual work built against fake-looking sparse data
doesn't prove anything about how it'll read once the real picture fills
in.

---

## Phase 3 — PlankCrash launch

**What's real right now** (verified this session): `PlankCrashV2.sol` (+
`Drand`/`Entropy`/`VRF` variants), 282/282 tests passing including a
140-op×4-seed randomized-invariant fuzz suite, the CRITICAL
`presetCashOut` exploit fix included, a real deployed testnet instance
(`robinhood-testnet`, chainId 46630, dated 2026-08-17, real contract
addresses in `public/arcade/deploy-addresses.testnet.json`). **Zero
mainnet deployment. Zero integration into the live site** — no nav entry,
no Next.js route, reachable only via standalone static files
(`public/arcade/crash.html`) plus the local friend-test launcher
(`START.bat`).

**Owner's stated requirements for launch, verbatim scope, not yet
designed:**
- A **first main launch event**, admin-scheduled, before ongoing
  operation begins — not straight into rolling games.
- **24-hour rolling games** after that, running continuously.
- **Admin freedom** to stop, reschedule, or change game settings whenever
  needed.
- A **"state of the art... admin novel solutions and best research"**
  bar for how that admin control surface actually works.

**What this needs before it can be spec'd properly (not yet done):**
1. A real design pass on the admin scheduling/control mechanism itself —
   this reuses the existing wallet-signature admin-auth scheme
   (`lib/admin-auth.ts`, same pattern the market-preview bypass and every
   other admin mutation in this codebase already uses), but the actual
   state machine for "scheduled launch → rolling 24h operation → admin
   can pause/reschedule/reconfigure mid-stream" doesn't exist yet and
   needs its own design pass, not an assumption bolted onto existing
   contracts.
2. A real mainnet deployment decision and process — same category of
   deliberate, owner-gated real-money decision as the Bitcoin mainnet
   flag, not a default to just flip.
3. Actual site integration (nav entry, real route) — currently doesn't
   exist at all.

This phase is not started. It is intentionally the last of the three, per
the owner's own sequencing.

---

## How to use this document

When phase 1 is genuinely satisfied (admin sign-off, not a metric), open
phase 2 as its own scoped implementation pass — the "proposed direction"
above is a starting point for that pass's plan, not a final locked design.
Same for phase 3 once phase 2 ships. Update this doc's status lines as
each phase closes, the same way `SPEC-GLOBAL-INDEX-ULTIMATE-FORM.md`
tracks its own status.
