# PARKED: SocialFi research + the Rings & Sap concept

**Status: PARKED, not scheduled.** Nothing here is built or committed to. Recorded
2026-08-19 so the research isn't re-done later. The active priority is mainnet
readiness for the global multichain marketplace — see the bottom section for what
this deliberately defers.

---

## 1. The concept worth keeping: Rings & Sap

A two-counter progression system, replacing a single points score. Named for the
app's existing wood/forest identity, and structurally better than one number.

**Rings — tenure. Only ever grows.**
- Accrues from time-based, unfakeable participation: account age, consecutive
  active periods, holding duration, cumulative real fees paid.
- Never decays, never spent. This is the "you were here" record.
- Displayable as literal growth rings — a wood-slice profile badge where ring
  count *is* tenure. The metaphor and the mechanic are the same object, which is
  rare and worth exploiting.

**Sap — current activity. Earned continuously, decays.**
- Accrues from recent real activity; decays without it.
- The spendable/competitive counter (leaderboards, seasonal standing, cosmetic
  unlocks).

**Why two counters beats one:** a single score forces a choice between "veterans
can never be caught" (permanent) and "your history is worthless" (decaying). Two
counters give a permanent record AND a live competition, and they resist opposite
attacks — Rings can't be farmed quickly, Sap can't be hoarded.

**Rank ladder (natural fit, not yet fixed):** Sapling → Stick → Board → Plank →
Big Beam → Wooden Whale already exists in `lib/plank-checks.ts`'s
`rankTierFromPoints`, mirroring PlankProgression.sol's on-chain tiers. Rings/Sap
would sit under it rather than replace it.

**Rank should unlock cosmetics, not money.** Profile themes, wood-grain borders,
ring-count badges, name colors. Free to grant, impossible to buy, and — critically
— keeps the system out of securities territory (see §3).

---

## 2. Mechanics worth borrowing (Remilia / RemiliaNET)

Verified from remilia.net, blog.remilia.org, wiki.remilia.org (2026-08-19).

- **Multi-source scoring AS the anti-sybil measure.** Their stated doctrine is
  "gamified anti-sybil" instead of KYC: on-chain acts + in-app play + merch + IRL
  events. Variety is the defense — no single vector can be farmed to the top.
- **Deterministic generative default avatar** from the user's own ID ("Universal
  Basic Kagami"), decodable back to that ID. Nobody is a grey circle on day one;
  signup itself feels like a mint.
- **Constrained customization** — one palette-picked hex propagating to profile,
  ID card, and name colour. Expression without UI rot. (This app already has the
  accent-theme system that would carry it.)
- **Seasonal, retroactive, SECRET achievements** — explicitly their anti-farming
  device. Never publish the full list.
- **Level-gate the social layer** (their chat required Beetleboy L10). Strong spam
  filter and retention hook in one.
- **Pity counters** on rare drops — cheap, and kills the "rigged" narrative.
- **delegate.xyz support** so cold-storage holders still score. Verified alive:
  registry `0x00000000000000447e69651d841bD8D104Bed493`, 29 EVM chains, 150+
  integrations including OpenSea.
- **Copyleft the brand assets.** Delphi's finding: derivatives bled value while the
  flagship appreciated. Be Remilia, not Yuga.
- **Own the canon layer** (a self-hosted wiki) rather than the licence layer.

**Adapt, don't copy:** do NOT call it a "social credit score" — Remilia meant it
ironically and it still reads as authoritarian. Rings/Sap says the same thing in
this app's own voice.

---

## 3. Hard constraints the research surfaced (these change the design)

**Legal — the decisive one.** The SEC's Interpretive Release of **2026-03-17**
(published 03-23) holds that airdrops with no consideration don't satisfy Howey's
investment-of-money prong — but the operative distinction is **retroactive vs
prospective**. A snapshot of past activity "without previewing such activity ahead
of time" is clean; distributions where recipients "prospectively perform services
in exchange" may implicate securities law.

A points program with published rates, multipliers, and leaderboards is the
paradigm case of a *prospective* distribution. So:
- Points redeemable for **access, cosmetics, and fee tiers** are fine.
- Points redeemable for **money or a token** are a different legal posture, and
  that posture must be decided BEFORE publishing any rates.

**Anti-sybil is a cost problem, not a classification problem.** Measured farm
economics: ~$180/wallet/6mo infrastructure cost against a ~$200 average payout.
Any fixed per-wallet cost above ~$200 kills the median farm without any graph
analysis — and unlike detection, it produces no false positives and no appeals
queue. This is why the fee-weighted points fix already shipped (see
`seaport-fill-indexer.ts`) is the structurally right answer.

**The TGE is the cliff, not the farming.** Monad excluded testnet farmers entirely
and still lost 87% of DAU and 75% of bridged assets post-launch. Better sybil
filtering does not fix retention. Do not assume a cleaner program changes the
curve.

---

## 4. What NOT to build (evidence, not opinion)

Every social-graph integration target died or was abandoned during 2026:

| Target | Status (verified Aug 2026) |
|---|---|
| Farcaster Mini Apps | Merkle returned all **$180M** to VCs; sold to Neynar Jan 2026; **Neynar seeking a new operator as of 2026-08-17** |
| Base App social | Killed the Farcaster-powered feed + Creator Rewards Feb 2026; after Apr 2026 the Farcaster SDK is no longer invoked at all |
| Creator coins generally | Armstrong, 2026-03-03: *"We tried it as an experiment. It didn't quite work."* |
| XMTP | Still permissioned (7 vetted nodes), mainnet slipped, no token |
| Push Protocol | PUSH at ~$370k mcap, all-time low 2026-08-17 |
| Lens | ~22k DAU, own chain, ~$70k TVL |

Comparable products' revenue curves: friend.tech **$21 revenue in 30 days** before
renouncing its contracts; Zora Coins fees **−99.98%** from peak; Blast TVL
**−98.7%**; SocialFi collectively cannot hold 100k users.

**The pattern:** revenue that is a derivative of speculative churn has a half-life,
not a business. And the peak metric *precedes* the token — Blast's TVL peaked one
month BEFORE its TGE.

**The implication for this app:** build the activity feed over **our own** trade
and crash-game data. It's generated by the product, can't churn independently of
it, and needs no protocol dependency. Share to X for reach. Skip Farcaster, XMTP,
Push, and Blinks entirely.

---

## 5. Identity primitives worth integrating LATER (verified alive)

Ordered by value-per-effort, none of it started:

1. **ENS + ENSIP-19 multichain primary names** (Final; Optimism/Base/Arbitrum/
   Linea/Scroll). Display names + avatars. **Forward-verification is mandatory** —
   an unverified reverse record is an impersonation vector.
2. **SIWE (ERC-4361)** verified through an **ERC-6492/1271-aware** validator, never
   bare `ecrecover` — bare ecrecover silently fails for every smart account.
3. **Wallet linking** with a mutual/nested signature binding BOTH the account and
   the candidate address (Farcaster's construction), server-issued single-use
   nonce, domain + chainId + expiry, one-wallet-to-one-account uniqueness, and a
   per-wallet public/hidden toggle.
4. **Coinbase Verifications** (EAS on Base) as a badge, never a gate — gating
   excludes every non-Coinbase user and creates geo-discrimination exposure.
5. **delegate.xyz** read-path for cold-wallet entitlement.

**Do NOT build on:** ERC-6551 token-bound accounts (adoption never landed, and
identity that transfers with an NFT is wrong semantics for reputation); World ID
as a gate (banned/suspended in ~6 jurisdictions).

**Security note that applies regardless:** the one *documented* vulnerability class
here is ERC-1271 signature replay across co-owned smart accounts (LightAccount,
Kernel, Biconomy, OKX; Permit2/CowSwap exposure). Bind the account address and
chain ID into every signed payload, per ERC-7739. And a Safe *owner's* EOA
signature proves ownership, not Safe control — verify Safes via ERC-1271 against
the Safe itself.

---

## 6. What parking this defers

Not scheduled, and deliberately behind mainnet readiness:
- Rings & Sap as an actual schema/UI (today there is only the single
  `plank_checks_events` ledger + `rankTierFromPoints`).
- Any wallet-linking, ENS, or delegate integration.
- Any activity feed or social surface.
- Any decision about points→token conversion (see §3 — legal posture first).

**The ordering lesson from Remilia is the reason this is parked:** RemiliaNET
launched in year FIVE, on top of five years of behaviour already worth scoring.
A points ledger launched into an empty room measures nothing and gets farmed.
Marketplace first.
