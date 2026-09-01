# Plank Crash — spec-only, uncheatable, oracle-free (2026-08-05)

Status: **design-only, same gate as the Index Vault.** Nothing here
authorizes building or deploying a contract, and nothing here authorizes
real-money operation. This is explicitly a **different risk category** from
everything else in this repo — a real-money game of chance is gambling in
the legal sense in most jurisdictions, which is a legal/licensing question,
not a smart-contract-security question. The admin has confirmed this stays
spec-only pending their own separate legal review; this document does not
and cannot clear that gate.

---

## 1. The core requirement: uncheatable, no oracle

"No oracle" here means specifically: no single trusted third party (not
Chainlink VRF, not an off-chain HMAC server an operator could withhold a
seed from) whose honesty the game depends on.

**Marketplank already has the right primitive, live and proven —
`DrandBeacon.sol`.** V3's random redemption already replaced
sequencer-controlled `blockhash()` (Robinhood Chain is an Arbitrum Orbit
chain; L2 block hashes are documented as derivable in advance by the
sequencer) with drand's League of Entropy: a threshold BLS network,
16+ independent operators, publishing a verifiable signature on a fixed
wall-clock schedule with zero knowledge of what's asking. The beacon's own
header states the honest trust model: "a threshold of the drand League of
Entropy committee is not colluding with the vault's adversary" — strictly
better than a single sequencer, not literally trust-free, and stated as
such rather than oversold.

**The crash game reuses this exact contract and pattern, not a new RNG
design:**
- Every round commits to a **future** drand round number before that
  round's signature exists — identical to `ROUND_LEAD` in
  `MarketplankVaultV3.sol`.
- Once the beacon relays and verifies that round's BLS signature on-chain
  (permissionless — anyone can relay, same as today), the round's seed is
  `keccak256(drandSignature, roundCommitmentHash)` — binding the outcome to
  both the unpredictable-in-advance signature AND the specific round's own
  bet state, so two different rounds targeting the same drand round (if
  that were ever possible) still produce different outcomes.
- The crash multiplier is computed by a **public, deterministic, pure
  function** — the same published formula used across the provably-fair
  casino industry (Stake.com and others document this openly, it is not a
  secret):
  ```
  X = seed mod 2^52
  crashPointBps = floor((100 * 2^52 - X) * 10000 / (100 * (2^52 - X)))
  ```
  This produces a house edge baked into the *floor* operation itself (the
  standard 1% house edge shape: `P(crash <= 1.00x) ≈ edge`), not a
  separately-adjustable "rig" parameter — the edge is a property of the
  formula, verifiable by anyone re-deriving it from the public seed.
- **Anyone can independently recompute the exact crash point from the
  on-chain drand signature alone**, before or after the round, with no
  need to trust Marketplank's frontend, backend, or any off-chain process.
  This is the actual meaning of "uncheatable" here: not "impossible to
  lose," but "impossible for the house, or anyone, to influence or predict
  the outcome before it's committed."

**What this does NOT solve, stated honestly:** front-running the *reveal*.
Once a targeting round's drand signature is public (published by the
drand network itself, independent of Marketplank relaying it), anyone
watching the drand network directly could compute the crash point before
Marketplank's own relay transaction lands, race a "cash out" transaction
in against it, or simply not enter a round they can see is bad. This is
the SAME property `MarketplankVaultV3.sol`'s own comments already document
plainly: "a drand round is public on the drand network the instant it is
emitted, BEFORE anyone relays it into this vault's beacon." V3's answer for
random redemption was to make declining a bad draw cost something (the
anti-reroll forfeit penalty). Crash games have a cleaner native answer:
**the bet is placed and the multiplier climbs in real time BEFORE the
round's target drand round is even reachable** — a player who wants to
front-run the reveal has to already be in the round with a real bet at
risk, which is a materially different (much weaker) exploit than "know the
outcome before betting." This needs to be modeled precisely (see §5) before
being called closed, not assumed safe by analogy.

---

## 2. Round mechanics

```
1. Round opens. A future drand round R = nextRoundAfter(now) + LEAD is
   committed. Multiplier display starts climbing on a public, deterministic
   curve (e.g. exponential, m(t) = e^(k*t)) that anyone can verify — NOT
   randomly jittered by a server, since that would reintroduce exactly the
   "trust the operator's process" problem drand exists to remove.
2. Players place bets during a fixed, short entry window BEFORE round R's
   signature can possibly exist (this is what makes reveal-frontrunning
   structurally hard, not merely discouraged — see §5).
3. Entry window closes. Multiplier keeps climbing on the same public curve.
4. Once round R's drand signature is verified on-chain, the crash point is
   computed (the formula in §1) and revealed as a SINGLE on-chain event —
   not "when the operator feels like publishing it."
5. Any player who cashed out (a signed, timestamped, on-chain-anchored
   intent) at a multiplier below the revealed crash point wins that
   multiplier times their stake, from the house pool (§3). Anyone who
   didn't cash out before the crash point loses their stake to the house
   pool.
```

**Critical unmovable-assets-doctrine parallel**: a player's ability to
CASH OUT once they've placed a bet must never be blockable by any
mechanism — same doctrine as `redeemProRata`. This is easier here than in
the Index Vault (cashing out is a time-bounded action within one round, not
an indefinite claim), but the principle still applies: no admin role, no
pause, no parameter change may ever prevent a player who's ahead of the
crash point from claiming their win.

---

## 3. House prize inventory — funded from existing PLANK revenue, not a separate deposit

Per the admin's explicit direction: the house pool is **not** a
separately-funded reserve requiring its own capital-raise or backstop
design (which would reopen the exact "funded backstop" question already
resolved against, in Part K of `SPEC-GLOBAL-INDEX-ULTIMATE-FORM.md`, for
the Index Vault). Instead:

- Reuse the **already-built, already-tested segregated-ledger pattern**
  from `GlobalIndexVault.ecosystemFeesWei` / `harvestEcosystemFees()` — a
  configurable, timelocked, bounded-ceiling split of real, already-realized
  Marketplank revenue (V3 fees, Index ecosystem fees, or a new explicit
  "crash game funding" leg) into a dedicated, segregated house-pool ledger.
  Same non-negotiable properties as every other revenue-split mechanism in
  this codebase: never carved out of principal/backing after the fact,
  bounded at a compile-time ceiling, timelocked to change, never a claim
  that can exceed real collected revenue.
- **The house pool's own solvency needs the same rigor the Index Vault
  applied to backstop sizing** — `BackstopSizingCalculator.sol`'s CVaR
  math is directly applicable here, arguably MORE applicable than to the
  Index Vault (which structurally never needs a backstop; a crash game's
  house pool structurally DOES need to cover payout tail risk, since a
  cashed-out win at a high multiplier is a real claim against the pool that
  can exceed what any single round's losers contributed). This is
  precisely the "funded reserve, CVaR-sized" pattern the Index Vault
  deliberately avoided building — here, it's the right tool, not a
  rejected one. Reuse the calculator, do not rebuild the math.
- **A hard, on-chain, non-negotiable rule**: the game must refuse (fail
  closed, reject the bet, not "hope the pool covers it") any bet whose
  MAXIMUM possible payout (stake × the game's own configured maximum
  multiplier cap, not an unbounded exponential) exceeds the house pool's
  current real balance. This is the crash-game-specific version of
  `MarketplankVaultV3`'s own `_assertSolvent()`/`_assertEthBacked()`
  invariants — solvency is checked BEFORE accepting risk, not discovered
  after.

---

## 4. Client architecture — web + native, design considerations only

**Web (Next.js, same app Marketplank already runs):** a new route,
responsive, reusing the existing wallet-connect/transaction-signing
infrastructure already built for the marketplace and vault. No new
delivery-channel risk beyond what already exists.

**Native mobile (iOS/Android):** flagged explicitly, not designed further
here, because the blocking constraint is NOT technical — it's that **both
Apple's App Store and Google Play have real, well-documented policies
restricting or prohibiting real-money games of chance**, enforced
independently of anything on-chain or provably fair. A perfectly
uncheatable, perfectly fair, fully on-chain crash game can still be
rejected or pulled from either store purely on gambling-policy grounds,
separate from and in addition to the jurisdictional licensing question in
§0. If native apps are pursued, this needs its own dedicated research pass
(current App Store/Play Store real-money-gaming policy, any
region-restricted or licensed-operator carve-outs) before any development
time is spent on a native client — no point building what the stores won't
list.

**In the meantime**, a responsive web client covers "mobile" in the sense
of "usable on a mobile browser" without triggering app-store review at
all — worth being explicit that this is a materially different, lower-risk
delivery path than a native app, and a reasonable default starting point
regardless of the eventual native-app decision.

---

## 5. Open questions — genuinely unresolved, need real design work before this is "ready," not glossed over

1. **RESOLVED — the reveal-frontrunning question, modeled precisely, not
   just assumed by analogy to V3.** drand's evmnet beacon publishes on a
   **fixed, publicly known wall-clock schedule**
   (`genesis_time + round*period`, `period = 3 seconds`, confirmed in
   `DrandBeacon.sol`'s own header) — no signer, including the drand
   network itself, can produce a round's signature before its scheduled
   instant; that's the exact property that makes the beacon unbiasable.
   This means the front-running window is not probabilistic, it's a hard,
   computable deadline: **as long as the entry window closes with a safety
   margin ahead of the target round's scheduled publish time (one full
   period is already generous; recommend two, i.e. `LEAD >= 2`, for
   comfortable clock/propagation jitter margin), there is structurally no
   window in which the signature can be known before betting closes** —
   not "hard to exploit," genuinely impossible under a correctly-chosen
   `LEAD`. This closes the concern raised in the original draft of this
   section; the only remaining work is picking the exact `LEAD` value
   (2 periods = 6 seconds minimum recommended) when the contract is built,
   not re-deriving the safety property itself.
2. **Maximum multiplier cap and its interaction with house pool sizing**
   (§3) — needs real numbers, not a placeholder, before the solvency
   invariant in §3 can be implemented or tested.
3. **Whether "PLANK love total suite" funding means a NEW explicit revenue
   leg, or a re-split of an EXISTING one** (V3 fees vs. Index ecosystem
   fees vs. both) — affects whether this needs new fee-collection code or
   only a new destination for fees already being collected.
4. **Legal/licensing (§0)** — not a design question, explicitly deferred
   to the admin's own review, but nothing past spec-only proceeds without
   it.

---

Nothing in this document is built. It exists so a real build round (when
authorized) starts from real, cited precedent — the same beacon V3 already
uses, the same segregated-ledger pattern the Index Vault already proved
safe, the same CVaR calculator already built — rather than inventing new,
unproven primitives for a real-money product.

---

## 6. Handoff package — what bullish's team can pick up now, and the gates that don't move

**What this document gives a build team to start from, precisely:**
- The exact contract to reuse for RNG (`DrandBeacon.sol`) and why it's the
  right primitive instead of Chainlink VRF or an off-chain HMAC scheme
  (§1) — no research needed to re-derive this.
- The exact, public, industry-standard crash-point formula (§1) — no
  house-edge design needed from scratch.
- The exact segregated-ledger pattern to reuse for house-pool funding
  (§3), including which existing, already-audited-this-session contract
  (`ecosystemFeesWei`/`harvestEcosystemFees`) it's modeled on.
- The exact existing tool to reuse for house-pool solvency sizing
  (`BackstopSizingCalculator.sol`'s CVaR math) — and, notably, the one
  place in this whole ecosystem where a *funded* reserve is the objectively
  correct answer rather than the rejected one (§3), which is worth stating
  plainly since it's the inverse of the Index Vault's own conclusion.
- Four named, unresolved open questions (§5) that block calling this
  "design-complete" — these are real work, not paperwork, and should be
  closed (or explicitly re-scoped) before contract code is written, same
  as every design gap this session caught before building rather than
  after.

**What's genuinely ready for bullish's team to build now, simulator-first,
same discipline as the Index Vault:**
- Contracts on local Hardhat, real adversarial test suites, real
  independent verification — the exact same rigor this session applied to
  every Index Vault round. This can start immediately once §5's open
  questions are resolved.
- Frontend wiring (desktop web) against the simulator build — no gate
  beyond normal engineering review.

**Testnet — a lower but real gate, not a rubber stamp:**
- Functional/security validation on testnet (real network, valueless test
  tokens) is a reasonable next step once the simulator build passes its own
  adversarial suite — this is standard engineering practice, not blocked by
  the legal question below, PROVIDED testnet genuinely uses valueless
  tokens with no real-money path, which needs to be confirmed as actually
  true for whatever testnet deployment is used, not assumed.

**Mainnet / real-money operation — hard-gated, does not move regardless of
audit quality:**
1. The same external-audit bar every other Marketplank contract has
   received.
2. bullish's own independent review.
3. A real, multi-angle, multi-frontier-model audit pass — same standing
   requirement as the Index Vault, restated here because this is a NEW
   product surface, not an extension of an already-audited one.
4. **The admin's own separate legal/licensing review — explicitly not yet
   done, explicitly not something any amount of security auditing
   substitutes for.** A perfectly secure, perfectly fair smart contract can
   still be an illegal unlicensed gambling operation in a given
   jurisdiction; that is a legal question this document cannot answer and
   does not attempt to.
5. If native mobile apps are pursued: separate App Store / Play Store
   real-money-gaming policy review (§4) — a smart-contract audit does not
   help clear this gate, it's a distinct platform-policy question.
6. The admin's own explicit, separate sign-off — distinct from any of the
   above, same standing pattern as the Index Vault.

Native mobile: **not designed in this document beyond §4's flag** — needs
its own research pass on real, current app-store gambling policy before any
build effort, so it isn't sequenced as part of the "ready now" package
above.
