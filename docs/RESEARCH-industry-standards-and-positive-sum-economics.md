# Industry-leader standards, 2026 frontier trends, and positive-sum economic augmentation for the Plank Arcade

Real research, current as of 2026-08-12. Every claim below is either sourced to a live search result or explicitly marked as our own proposal — nothing here is presented as fact that isn't grounded. Builds on and does not duplicate:
- `docs/SPEC-plank-derby-racing.md` (PR #65) — racing game design + security mitigations
- `docs/SPEC-competition-cadence-and-liquidity-flywheel.md` (PR #66) — cadence, rake, liquidity flywheel, exploit-surface audit
- `docs/SPEC-arcade-assets-and-buildplan.md` (PR #67) — asset sourcing, Three.js buildplan
- `contracts/PlankCrash.sol`, `contracts/PlankDerby.sol` — the actual shipped, tested contracts this research is meant to sharpen

---

## Part 1 — How the industry's actual leaders work

### 1.1 Crash games: Aviator (Spribe) is the reference standard everyone else clones

**The provably-fair mechanism.** Three seeds: a **server seed** (generated and *hashed* before the round — the hash is published immediately, the seed itself only revealed after), a **client seed** (contributed by the player's browser), and a **nonce**. `SHA-256(server seed, client seed, nonce)` deterministically produces the crash point. The critical property: **the crash point exists, fixed, at t=0** — the climbing animation is pure playback of an already-decided outcome, verifiable after the round via the revealed server seed. [[source]](https://aviator.blog/provably-fair-algorithm-in-aviator-game/)

**RTP / house edge.** Industry standard is 97–99% RTP (1–3% house edge). Duel Crash currently claims the sector high at 99.9%; the Stake-family brands (Stake, Shuffle, Gamdom, Rollbit, Winna, Yeet) cluster at 99%. [[source]](https://casino-originals.com/blog/best-crash-casino/)

**The multiplier curve has a published reference shape.** At 97% RTP: ~48.5% of rounds reach 2.00x, ~19.4% reach 5.00x, ~9.7% reach 10.00x. Most rounds cluster 1.00x–3.00x; large multipliers are rare by construction, not by bad luck. [[source]](https://crashgamegambling.com/2025/11/29/crash-gambling-rtp-real-numbers-not-guesswork/) This is a real number worth back-testing `PlankCrash._deriveCrash()`'s output distribution against — see §3.1.

**Why this class of game is vulnerable to the exact bug you described (love.game/Speechless).** If the crash point is fixed server-side but cash-out *timing* is judged by a client-reported event, the server is trusting the client's clock. A frozen or held screen exploits precisely that gap. Real operators close it by making the cash-out timestamp a **server-side receipt of the request**, never a client-reported one. `PlankCrash.sol` doesn't need to "be careful" about this the way a Web2 operator does — `cashOut()` is a transaction; its timestamp *is* a block number written to the chain. There is no local clock to freeze in the first place. This is a structural advantage worth stating plainly in any security writeup, not just an implementation detail.

### 1.2 Virtual horse racing: Inspired Entertainment's V-Play line is the market leader

**The honest finding: these are slot machines wearing a horse costume.** An RNG picks the winner first; the "race" is a skinned animation layered on top — mechanically no different from roulette. [[source]](https://www.top1tv.net/virtual-horse-racing-rng-vs-slots/) Cadence is aggressive by design: races every few minutes, instant re-bet after each one, random price boosts, an in-game bonus wheel — engineered for wagering frequency and retention, not race realism. [[source]](https://www.barchart.com/story/news/33463837/william-hill-and-inspired-extend-long-term-partnership-with-enhanced-virtual-sports-experience-through-expanded-retail-rollout)

**A real, relevant legal precedent: Historical Horse Racing (HHR).** US jurisdictions that require pari-mutuel classification for legal gambling let operators run RNG-selected *real historical races* through HHR terminals specifically to satisfy that legal test. This matters directly to us: **`PlankDerby` doesn't need the HHR workaround, because it's not simulating pari-mutuel over an RNG — it's actually doing it.** Real player stakes, split among real winners, bounded by the real pool. That's a stronger legal starting position than the entire virtual-racing industry occupies, not a weaker one. (Not legal advice — flagging the real precedent for whoever does the actual legal review, per the standing note in PR #65/#66 that no legal review has happened yet.)

### 1.3 2026 frontier trends (real, sourced, current)

- **Crash has gone mainstream, not niche.** As of April 2026, crash games account for over 35% of all mobile casino sessions globally. [[source]](https://prohockeynews.com/crash-games-in-2026-why-aviators-are-changing-and-whats-new-beyond-timing/)
- **Social visibility is now standard.** Players sit in a shared lobby and see hundreds of other players' live bets and cash-outs in real time — not just their own multiplier. [[source]](https://www.theplaidhorse.com/2026/05/15/future-of-crash-games-2026-trends-and-innovations/)
- **Hybrid crash + bonus-round mechanics.** Reaching a multiplier milestone can trigger a guaranteed-prize mini-game layered on top of the base crash mechanic — described by one 2026 industry writeup as "the biggest genuine innovation since Aviator launched in 2018." [[source]](https://www.theplaidhorse.com/2026/05/15/future-of-crash-games-2026-trends-and-innovations/)
- **Multi-volatility, same mechanic.** BAAS (Betting-as-a-Service) platforms now let operators run the *same* crash engine at different configured volatilities — frequent small wins vs. rare extreme multipliers — as a single tunable parameter set rather than separate games. [[source]](https://www.yogonet.com/international/news/2026/04/07/118443-crash-games-2026-how-high-rtp-and-multivolatility-shape-retention-and-turnover)

### 1.4 A genuine, notable gap: nobody found builds this the way we're building it

Direct search for "pari-mutuel non-custodial on-chain crash game, zero house edge, protocol-owned liquidity" surfaced zero real matches — general zero-edge and non-custodial concepts, but nothing combining all four properties the way `PlankCrash.sol` already does. Absence of search results isn't proof of absence, and this deserves a deeper, dedicated competitive sweep before anyone repeats it as a marketing claim — but as far as this research can currently establish, **a pari-mutuel crash game with no house bankroll and payouts strictly bounded by the real pool is not a pattern the current market has converged on.** Every incumbent surveyed above is house-backed RNG, meaning the house can pay out more in a single round than it collected in that round, funded by statistical edge over volume. `PlankCrash.sol` structurally cannot do that — which is the real, provable answer to "how do we guarantee we never go bankrupt" from earlier: it isn't a guarantee we make, it's a category of failure the contract's math doesn't have a slot for.

---

## Part 2 — Positive-sum economic augmentation, specific to $PLANK

Grounded in two real, current reference patterns, then mapped onto what this repo already has in flight.

### 2.1 The real reference pattern: HYPE's buyback flywheel

Hyperliquid's HYPE token runs a documented positive feedback loop: **more trading volume → more fees → more daily buybacks → reduced circulating supply → higher price → more attention/users → more volume.** [[source]](https://www.buildix.trade/blog/hype-tokenomics-explained-buyback-burn-staking-supply-2026) The industry-wide pattern for 2025–2026: buyback-and-burn has gone from niche to standard practice — $18.8B moved across buybacks/burns since January 2025, with burns (permanent supply reduction) outweighing plain buybacks roughly 6:1 by dollar volume. [[source]](https://tokenomist.ai/research/buyback-and-burn-explained-what-they-are-who-is-doing-them-and-whether-they-actually-work) Only a burn (or a buyback that ends in one) actually shrinks supply — a buyback alone just changes who holds the float.

**This is exactly the shape of PR #66's already-speced rake flywheel** (`harvestRake()` swapping accumulated rake for real PLANK via the real V2 pool `0x01b1BEf6fBA02c846eA5c4Ff59193988B5f86F73`, adding liquidity, burning the LP). The arcade games (`PlankCrash`, `PlankDerby`) are the volume generator that feeds that exact loop — every round's rake is real, on-chain, continuously-sourced fee flow into the same flywheel PR #66 already designed. This research doesn't need to propose a new mechanism here; it confirms the one already in the spec is the current best-practice shape, not a naive one.

### 2.2 What's genuinely new to propose, specific to this project

These are **our proposals**, not industry-observed patterns — labeled honestly as design ideas for discussion, not findings.

1. **"The house plays too."** Every incumbent surveyed is structurally adversarial — the house's edge is the player's loss, by construction. Since `PlankCrash`/`PlankDerby` have no house edge at all (only a rake, which already flows to the community flywheel per PR #66), there's room for something incumbents can't offer: let a small, capped slice of accumulated rake auto-enter future rounds as a real bettor, on the same rules as everyone else, no advantage. This isn't a gimmick line — it's a legitimate, honest thing to say about the game precisely because the protocol has no way to bias the outcome in its own favor even if it wanted to (`_deriveCrash`/`finishRace` are pure functions of unbiased entropy). Worth scoping as a real feature, not just a claim.
2. **NFT-linked bonus weight for RobinWood collection holders.** The collection already exists, is real, and has real trait rarity data (confirmed via the full 1,542-token sweep this session). A holder-verification hook (own a real Chalkstronaut / any RobinWood plank) granting a small, transparent, on-chain-verifiable weight bonus in `registerResult()` ties the arcade back into the existing collection's utility instead of treating it as pure visual skin. Needs real game-theory review before shipping — bonus weight has to stay small enough that it can't be characterized as "pay to win," and must be verified via a real `ownerOf`/`balanceOf` check against the real RobinWood contract, not a claimed trait.
3. **Bribe markets on Derby races** — already scoped in PR #65 §... (Curve Wars / Votium / Hidden Hand pattern: real, billions-moved precedent for optional PLANK/ETH/NFT bribe pools attached to a specific horse). Not new research, just flagging it belongs in this same positive-sum bucket: bribes are a third-party-funded, opt-in yield layer that doesn't touch the pari-mutuel pool's solvency guarantees at all.
4. **Loyalty/streak accounting, non-transferable, redeemable into the existing PLANK ecosystem economy** — rather than inventing a new points system from scratch, this should plug into whatever Career Points / garden loyalty infrastructure already exists elsewhere in this monorepo family (per prior session memory: YJ monorepo's Career Points, garden_loyalty singleton pattern) rather than fragment the ecosystem with a third parallel loyalty system. This is a real integration-scoping task, not a new invention, and should be scoped against the actual current state of that infrastructure before design, not assumed.

### 2.3 What this research deliberately does NOT propose

No house-edge introduction, no funded bankroll, no custodial float — all three would break the exact structural guarantee (§1.4) that's the actual competitive differentiator. Positive-sum augmentation here means *more real volume flowing through the existing honest flywheel*, not a new mechanism that quietly reintroduces the insolvency risk the current design was built to be immune to.

---

## Part 3 — `PlankCrash._deriveCrash()` back-tested against the industry reference curve

Ran a 2,000,000-sample Monte Carlo of the actual `_deriveCrash()`/`_multiplierAt()` formulas from `contracts/PlankCrash.sol` (pure functions, reproduced faithfully in JS, not approximated):

| Threshold | Our contract | Industry reference (§1.1) |
|---|---|---|
| ≥2.00x | 49.98% | ~48.5% |
| ≥5.00x | 19.95% | ~19.4% |
| ≥10.00x | 9.96% | ~9.7% |
| ≥20.00x | 4.99% | — |
| ≥50.00x | 2.00% | — |
| ≥100.00x | 1.00% | — |

**Finding: our curve is a pure, untrimmed `1/x` survival distribution** — `P(multiplier ≥ k) = 1/k` exactly, which is the textbook-fair crash odds shape before any operator applies a house-edge trim. It lines up with the real Aviator-class reference numbers almost exactly, sitting fractionally *above* them at every threshold. That's structurally correct for this design, not a bug to fix: incumbent crash games bake their 1–3% edge directly into the multiplier curve (trimming the odds so `P(≥k)` is slightly less than `1/k`); `PlankCrash` doesn't need to, because its edge is the separate, transparent 2.5% rake taken from the pool at settlement (`distributable = pool * (10000 - rakeBps) / 10000`), not a skew hidden in the odds themselves. Baking an artificial trim into `_deriveCrash()` on top of the rake would be redundant, and worse, would misrepresent what "provably fair" means for a pari-mutuel game whose real payout ratio is whatever the winners' pool share nets out to, not a pre-fixed RTP number the way a house-backed RNG game has one.

One caveat worth flagging honestly: the simulated mean multiplier (~9.8x) is not a meaningful "expected value" the way it would be phrased in ordinary language — a `1/x` distribution has extreme tail variance, so that average is dominated by rare huge outcomes and shouldn't be quoted as "the average round pays ~10x," which would be misleading marketing copy.

## Part 4 — Remaining concrete next actions

1. **Scope "the house plays too"** (§2.2.1) as a real feature spec with explicit caps and an honest disclosure of what it does and doesn't guarantee.
2. **Scope the RobinWood holder bonus-weight hook** (§2.2.2) against the real collection contract, with a game-theory pass on maximum safe bonus size before it becomes pay-to-win.
3. **Audit the actual state of Career Points / garden loyalty infra** elsewhere in the ecosystem before designing any new loyalty mechanic for the arcade, so it plugs in rather than duplicates.
4. Independent, deeper competitive sweep on §1.4's claim (no pari-mutuel non-custodial crash game found) before it's ever used in external-facing copy — this research's absence-of-results is a starting signal, not a verified competitive claim.
