# Plank Checks, Index Vaults, and Routing Intelligence — Engineering Spec

Status: **design-complete, partially built.** This document is the buildable
follow-through for the strategy discussed with the site admin (2026-08-04).
It exists so every later PR implements the same agreed shape instead of
re-litigating decisions per pull request — the same role `SPEC.md` plays for
Instant Swap.

Three systems, deliberately staged by risk:

1. **Plank Checks** (points/referral engine) — pure data layer, zero new
   contract risk, zero new custody. Buildable and shippable immediately.
2. **Index Vaults** (personal + Global Index) — new smart contracts that hold
   real value. Buildable now as code + tests, but **not deployable to mainnet
   without an external audit**, the same bar `MarketplankVaultV3` cleared
   before it went live (`docs/marketplank/AUDIT-2026-08-01-v3-internal.md`).
3. **Routing intelligence** (1inch/Matcha-style best execution across venues,
   including 9x/9mmPro on Robinhood Chain) — depends on real integration
   details from bullish (9x contract addresses, ABI, docs) that do not exist
   in this repo. Scoped here; not implementable until that information
   arrives.

Deliberately **out of scope for now**, per explicit instruction: card-provider
partnerships, KYC/money-transmission rails, and any other "digital bank
account" generation-3 use case. Those remain the long-range vision in
`docs/marketplank/SPEC.md`-style prose elsewhere, not a near-term build target.

---

## 1. Plank Checks — points, wallet identity, and referrals

### 1.1 Design principles (non-negotiable, per admin decision 2026-08-04)

- **Vanity only, for now.** Points have no redemption value today. The data
  model must not assume otherwise, but must not block a future conversion to
  airdrops/allowlist/fee-discount tiers either — see §1.6.
- **Never zero- or negative-sum.** Any future reward payout (Woodsman's Path
  discounts, raffle tickets, whatever comes later) is paid *only* from a
  bounded, pre-funded rewards pool sourced from a fixed, published percentage
  of real, already-collected fee revenue. The system must be structurally
  incapable of paying out more than it has actually collected — enforced by
  code, not by policy.
- **Read-only, zero contract risk.** No new custody contract. Wallet identity
  binding reuses the existing stateless, signature-based scheme
  (`lib/admin-auth.ts`) generalized from admin-only to any wallet — a
  `personal_sign` over a domain-bound message, verified server-side, no
  session, no on-chain transaction, no approval ever required.
- **Permanent ledger, toggleable seasons.** Raw point events are immutable
  and never deleted. A "season" is a pure read-time filter (start/end
  timestamp) over that permanent ledger, toggled by an admin flag — the same
  pattern the existing Flags admin section already uses for other runtime
  switches. Turning seasons on/off never touches historical data.
- **Reuse existing anti-sybil infrastructure, don't parallel-build it.**
  `lib/boards-store.ts` (the "Bad Boards"/"Nice ledger" anti-sniper system
  from the token launch) is a direct, already-built reputation signal. A
  wallet flagged there is a free down-weighting input for Plank Checks.

### 1.2 Wallet identity and linking economics

- 1 wallet ↔ 1 "Plank Checks profile." A profile may link additional wallets.
- **First 2 wallets free.** Each additional wallet costs **0.01 ETH**, paid
  by sending it to the existing treasury address
  (`0xcdb7ca36d35FA16d15fda859A46F1D72D979E9d8` — the same wallet that
  already receives every vault and marketplace fee) and having the server
  verify that specific transaction on-chain before granting the link. No new
  contract: this is the same "server verifies a real on-chain fact before
  granting a permission" shape `lib/admin-auth.ts` already uses, just for a
  payment instead of a signature.
- A vanity username is a free-text field (profanity/collision-checked),
  bound to the profile, changeable but logged (so leaderboard history stays
  attributable even across a rename).

### 1.3 Point categories and weighting

Two tiers, weighted by actual economic contribution — see the admin
conversation's own framing, restated precisely for implementation:

**Tier 1 — direct revenue signal (highest weight per unit):**

| Action | Points formula | Why this shape |
| --- | --- | --- |
| Swap through the official `/trade` widget where the 0.4207% factory fee was captured | `points = k1 × fee_wei_paid` | Fee paid is the most direct, unforgeable "this generated real revenue" signal. |
| Providing LP (any vault) | `points = k2 × Σ(lp_value_wei × hours_held)` | **Must be time-integrated, never flat-per-deposit.** A flat score is trivially farmed by deposit-then-immediately-withdraw; the time integral only rewards liquidity that was actually useful to the pool. |
| Depositing an NFT into a vault | `points = k3 × floor_value_wei_at_deposit` | Rewards genuinely adding depth, priced at the moment it mattered. |
| Redeeming (regular or targeted/premium) | `points = k4 × fee_wei_paid` (not value extracted) | Redeeming *removes* depth; scoring the fee paid (not the NFT's value) rewards genuine usage without over-rewarding draining the vault. |
| Buying on the marketplace (Seaport fill) | `points = k5 × sale_price_wei × (1.0 if Marketplank-attributed else 0.6)` | Rewards real art-buying; weights confirmed-ours fills higher since attribution is independently verified (`lib/market/served-orders.ts`), not just claimed. |
| **Referral-linked swap** (new, per admin instruction 2026-08-04) | `points = k1 × fee_wei_paid` credited to **both** the buyer *and* the referrer whose link was used | Same formula as a direct swap — a referred swap is exactly as valuable to the protocol as a direct one, so it earns the same rate, just credited twice. See §1.4. |

**Tier 2 — free/low-barrier participation (real, but capped and anti-spam by construction):**

| Action | Points formula | Anti-abuse |
| --- | --- | --- |
| Meme archiving (`plank.love/memes`) | `points = k6 × originality_multiplier` (1.0 first-to-archive a given piece, decaying for reposts) | Flat-per-submission is trivially spam-farmable; originality/first-mover weighting is not. Requires the submit-proxy change in §1.5. |
| Volume Bounty — bringing a new collection onto Marketplank | `points = k7 × Σ(that collection's ongoing fee revenue)`, streamed, not one-time | Rewards ecosystem growth proportional to the real, continuing revenue it produces — funded by that same revenue, never a flat bounty paid from nowhere. |

`k1..k7` are published, adjustable constants (Flags-admin-editable, like other runtime values), never silently changed — transparency matches the project's existing "least text, most trust" posture on `/learn`.

### 1.4 Referral links

Per the admin's explicit addition: **volume-bounty-style crediting also applies to swaps made through a referral link**, not just to net-new-collection bounties. Mechanics:

- A referral code is just the referrer's wallet address (or a short alias resolving to it), appended as a query param on `/trade` (e.g. `?ref=0xabc...` or `?ref=woodsman42`).
- The swap widget reads it client-side, includes it as metadata in the swap-submission request (never as anything that changes what the wallet signs — the trade itself is identical either way, this is purely attribution).
- The server records the referral attribution alongside the swap's real, already-verified fee event (the same `SITE_FEE` accounting that already exists) — it does not create a new fee or change what the buyer pays.
- Points, not funds, flow to the referrer today (vanity-only phase, §1.1). A literal on-chain fee-split to the referrer's wallet is a materially bigger project — it means the swap contract itself needs to route a slice of the fee to a dynamic, per-trade address — and is explicitly **phase 2**, gated behind Plank Checks first proving out the attribution/anti-abuse model with points alone.

### 1.5 Required code changes for meme-archiving attribution

`/api/memes/submit` (`app/api/memes/submit/route.ts`) currently forwards
submissions to the third-party smoothbrain.app queue with no wallet
attribution captured at all. To make meme points possible:

1. Require a signed proof (same admin-auth-style `personal_sign`) alongside
   the submission.
2. Log `{wallet, submissionId, timestamp}` in our own Postgres — independent
   of what smoothbrain does with the submission itself.
3. Points are awarded once the *upstream* moderation queue approves the
   asset (poll or webhook, matching how `/api/memes` already reads the
   approved feed) — never on submission alone, since the upstream queue is
   the actual arbiter of "real."

Known constraint to design around, not work around: smoothbrain's own
budget is **20 submissions/hour for the entire site**. This is an external
rate ceiling outside our control — worth surfacing to the community
(a visible "submissions this hour: N/20" indicator) rather than letting it
silently throttle without explanation.

### 1.6 Data model

```sql
-- migration 005_plank_checks.sql (illustrative — see actual migration file)

CREATE TABLE plank_checks_profiles (
  profile_id      BIGSERIAL PRIMARY KEY,
  vanity_name     TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE plank_checks_wallets (
  wallet_address  TEXT PRIMARY KEY,          -- lowercase hex
  profile_id      BIGINT NOT NULL REFERENCES plank_checks_profiles(profile_id),
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  link_tx_hash    TEXT,                       -- NULL for the first 2 free wallets
  link_fee_wei    TEXT NOT NULL DEFAULT '0'
);

-- Permanent, append-only. Never updated or deleted; a season is a query
-- filter over earned_at, not a separate table or a mutation of this one.
CREATE TABLE plank_checks_events (
  event_id        BIGSERIAL PRIMARY KEY,
  wallet_address  TEXT NOT NULL,
  category        TEXT NOT NULL,              -- 'swap' | 'lp_hold' | 'deposit' | 'redeem' | 'sale' | 'referral' | 'meme' | 'volume_bounty'
  points          NUMERIC NOT NULL,
  source_tx_hash  TEXT,                        -- NULL for time-integrated LP accrual ticks
  referred_wallet TEXT,                         -- set only on 'referral' events
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  earned_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX plank_checks_events_wallet_idx ON plank_checks_events (wallet_address, earned_at);
CREATE INDEX plank_checks_events_earned_at_idx ON plank_checks_events (earned_at);
```

Leaderboard reads are always `SUM(points) GROUP BY profile_id` over
`plank_checks_events` joined through `plank_checks_wallets`, optionally
filtered to a season's `[start, end)` — never a separately-maintained score
column that could drift from the real event history.

### 1.7 What points might become later (not built now)

Explicitly deferred, not designed in detail here, but the data model above
must not preclude any of: airdrop allocation snapshots (a point-in-time
`SUM(points)` read, same shape as the existing $PLANK airdrop engine already
does for NFT-holding weight), allowlist priority, or Woodsman's Path fee
discounts funded from the bounded rewards pool described in §1.1.

---

## 2. Index Vaults — personal and Global

### 2.1 The trust model that makes "impossible to unfairly extract value" true

Directly extending the principle `MarketplankVaultV3` already proved out:
the treasury has real power only *before* a pool opens (seed, choose initial
reserves) and **zero** privileged power the instant it does. Apply the
identical rule to an index's creator:

- A creator chooses the initial collection weights and seeds the pool.
- The moment the pool opens, the creator holds exactly the same kind of
  proportional, non-transferable LP position (`lpBalance` mapping, same as
  V3 — see `contracts/MarketplankVaultV3.sol:204-205`) as any later
  depositor. No privileged withdrawal path, no ability to change weights,
  no admin key.
- **NAV is never set by anyone.** It is always the live sum of the index's
  real holdings, each priced by its own underlying vault's real reserves —
  the same "read-through," oracle-free pricing V3 already uses for its own
  share price. An index token's price is math over other vaults' math, all
  the way down to real reserves, never a number a human enters.
- Locked seed liquidity: reuse V3's `openPool()` pattern exactly — mint
  `L0 = sqrt(basket_value)` to `address(0)` permanently on open, so the pool
  can never be fully drained to zero and griefed (`MarketplankVaultV3.sol:115,631`).

### 2.2 Personal Index Vaults

- Any Plank Checks profile may create **1 personal index vault for free**;
  each additional costs **0.01 ETH** (same "first free, then a small fee"
  shape as wallet linking — deliberately consistent across the whole system,
  not a one-off rule).
- Creator chooses which platform-approved collections' v-tokens the index
  accepts and their target weights at creation. Weights are enforced the
  same way Balancer's weighted pools enforce theirs — a fixed formula, not a
  discretionary decision post-launch.
- Depositors receive the index's own share token (standard ERC-20, same
  shape as vROBIN) proportional to what they contributed, priced against
  current NAV — never a first-depositor-sets-the-price situation, which is
  the classic ERC-4626/vault inflation-attack vector. The locked-seed-LP
  pattern in §2.1 is exactly what closes that vector, same as it already
  does for V3.

### 2.3 The Global Index (Grand Exchange framing)

- One flagship, platform-curated basket accepting *any* approved
  collection's v-token, weighted by an objective, public metric — real
  trading volume or TVL, the same logic a cap-weighted market index uses.
  Never a subjective/discretionary weighting a person sets.
- This is the default, diversified choice for someone who doesn't want to
  pick collections themselves — the ETF next to personal indexes' "pick your
  own stocks." Same trust model as §2.1 throughout: no privileged party, no
  settable price.
- **Index-level revenue share (confirmed, per admin decision):** once
  non-RobinWood collections pay the 0.5%-default marketplace fee, a defined
  slice routes into the Global Index's own reserve — so holding it means
  exposure to *protocol revenue*, not just underlying price. This needs its
  own explicit, published formula (e.g. "X% of every collected marketplace
  fee routes to the Global Index reserve, pro-rata to existing holders") —
  mechanical and public, same non-negotiable as the buyback mechanic in §2.5.

**Attribution stays strictly per-constituent — never pooled or blended
across collections, at any size.** Each collection's own vault already keeps
fully isolated fee/reserve accounting; the index doesn't change that, it
only holds a claim on each collection's v-token. The index-level revenue
share above must follow the same rule at its own layer: revenue generated
by trading a *specific* collection flows back only to the index's holding
of *that* collection's v-token — never spread evenly across every
constituent regardless of source. This is what makes it fair and
ungriefable at any collection size without a separate size-tiering rule:
a larger, more active collection naturally contributes proportionally more
to the index's growth because its own v-token inside the basket genuinely
grows faster; a smaller collection contributes less but is never diluted
by, or forced to subsidize, anyone else's performance. There is no shared
pot for a bad actor's collection to drain from good ones, because there is
no shared pot at all — only proportional claims on isolated pots. This is
also what makes "real APR for LPs" a true statement rather than a slogan:
every LP's yield is a direct, traceable function of the real fee activity
in the specific pool(s) they're actually exposed to, never an average
smeared across collections they aren't.

### 2.4 Creator-controlled marketplace fee tiers

Per the admin's explicit addition: a collection's creator, not just the
platform, can choose their own marketplace fee (default 0.5%, adjustable
within the same 0–1000 bps bound `lib/content-docs.ts`'s `sanitizeCollections`
already validates). The incentive that makes a *higher* fee something a
creator would actually want: a defined split of that fee routes to a
**creator-designated wallet**, like an on-chain royalty — a higher fee means
the creator captures more of their own collection's upside to fund their own
team/roadmap, not the protocol taking more. Buyers always see the fee before
buying (same pre-signature transparency `CONTRIBUTING.md` already mandates
for every wallet-facing value); a collection with a higher, creator-funded
fee is a visible, opt-in choice a buyer makes by choosing to trade there,
never a hidden cost.

### 2.5 Rule-based, never-discretionary buyback (complementary mechanic, confirmed as a good idea, not yet formally speced beyond this)

A fixed, published percentage of protocol revenue periodically buys $PLANK
on the open market and distributes or burns it. The one non-negotiable
design constraint: **mechanical and public — a fixed percentage on a fixed
schedule, announced in advance.** A discretionary, insider-timed buyback
reads as market manipulation even with good intentions; a rule-based one
reads as exactly what it is. This closes a real flywheel (more marketplace
activity → more fees → more buyback → more reason to hold $PLANK → more
trading interest → more marketplace activity) without ever requiring anyone
to trust a promise about *when* a purchase happens.

The buyback percentage, while timelocked and published like any other
parameter (§2.7), also needs a **hard-coded maximum ceiling in the
contract itself, not just a timelock.** A timelock only slows a bad change
down; it doesn't bound how bad the change can be once it lands. A
compromised admin key could otherwise raise the buyback cut high enough to
starve the Global Index's own promised revenue-share to its LPs (§2.3) even
after the delay expires and nobody stopped it in time. A ceiling written
into the contract (e.g. never more than X% of protocol revenue, X fixed at
deploy time or only lowerable, never raisable, past initial audit) closes
this regardless of whether anyone's watching the timelock queue.

**PLANK is never sold, converted, or used as a settlement currency to fund
anything — this is a permanent rule, not a phase of the design.** Every
inbound flow into this system is ETH or stables; PLANK only ever moves
*out* via the buyback above, never back in for the protocol to spend,
route, or convert. Index shares are never minted against deposited PLANK,
and no mechanism in this spec ever asks the protocol to sell PLANK to
acquire something else. If PLANK ever gets an inbound role at all, the only
acceptable shape is one-way locking/bonding — the same protocol-owned-
liquidity pattern Olympus DAO popularized — where PLANK goes in permanently
and is never resold, with any share value owed to the depositor funded from
elsewhere (real ETH already sitting in the buyback/treasury reserve), never
from reselling the PLANK itself. This is a direct, permanent consequence of
the admin's explicit rule: "always eth and or stables into plank, never
plank convert to something else." A related but separate rule: NAV and
share pricing anywhere in this system are always computed and anchored in
ETH off real basket reserves — **never** in PLANK, and never using a
PLANK/ETH exchange rate as a direct pricing input. A single wallet holding
56.78% of all PLANK supply means PLANK's own market is thin enough that a
sustained TWAP manipulation there is plausible; keeping every NAV
calculation ETH-denominated and PLANK-blind removes that surface entirely,
regardless of how PLANK's own price moves.

### 2.6 What this needs before mainnet (not a checklist item to skip)

- Full Hardhat test suite at the same bar `contracts/test/VaultV3.audit.test.ts`
  and the randomized-invariant suites already meet: solvency invariants,
  first-depositor/inflation-attack regression tests, locked-seed-LP
  regression tests, fee-tier boundary tests.
- An external audit, the same process V3 went through
  (`docs/marketplank/AUDIT-2026-08-01-v3-internal.md` →
  `docs/marketplank/DEPLOY-V3-RUNBOOK.md`). This is not optional for a new
  contract type holding real user value, regardless of how much internal
  test coverage exists.
- A deploy runbook mirroring `DEPLOY-V3-RUNBOOK.md`'s structure.

### 2.7 Adversarial hardening — pen-tested design, worked through with the admin (2026-08-04)

Every item below closes a specific, named attack, not a generic "be careful."
Treat this section as required scope for the eventual Index Vault contracts
and their audit brief — not optional polish.

**Weight metric: real fee revenue + permanently-locked LP, never raw volume.**
`weight ∝ (fee_revenue_weighted) + (locked_lp_value_weighted)`. Both halves
resist manipulation for different reasons: fee revenue is self-taxing (an
attacker must pay the treasury real ETH to move this number at all — wash
trading it is not free), and locked LP is un-fakeable by construction, using
the same `L0` minted to `address(0)` forever pattern V3 already uses — a
collection can't "prove commitment" with liquidity it can later pull,
because it's permanently locked. This closes the classic fake-volume-farming
attack that has drained real index-style DeFi products.

**Weight curve: square-root, with a hard capped-and-redistributed ceiling.**
`weight ∝ √(metric)` rather than linear — a collection with 4x the real
metric only earns ~2x the weight, so outsized winners self-dampen smoothly
with no gameable cliff. Layer a hard cap on top (e.g. no single collection
above 40% of NAV) with any excess above the cap redistributed pro-rata
across the other constituents at each rebalance — the same capped-index
methodology real regulated funds (UCITS-style concentration limits) and
crypto index products (Index Coop) already use. This bounds the blast
radius of *any* single collection, legitimate or not, ever threatening the
whole index, while still letting relative ranking move naturally below the
cap.

**NAV pricing: virtual-shares offset (mandatory floor) + TWAP, tiered by
trade size.** The underlying-asset-is-itself-another-vault's-share-price
shape here is a well-studied class of attack (a "nested vault" or
vault-of-vaults exploit): a flash loan can spike an underlying vault's
reserves in one block, get priced into an index deposit at that instant,
then reverse — extracting value from every other index holder in a single
atomic transaction. Defense, two layers: (1) OpenZeppelin's current
ERC-4626 virtual-shares/assets offset as a mandatory, zero-UX-cost floor —
this alone closes the classic first-depositor inflation attack
mathematically; (2) TWAP the underlying vaults' share prices before using
them for the index's own NAV, the standard defense lending protocols use
for oracle-style pricing, since it makes single-block manipulation require
sustaining a false price across multiple blocks at real capital risk. For
trades above a defined size threshold — where the manipulation incentive is
actually large enough to matter — require delayed/epoch settlement (request
now, settle at a NAV snapshot finalized in a later block) instead of
same-transaction pricing, which closes the attack entirely regardless of
TWAP window tuning. Small trades stay instant under TWAP protection; only
whale-sized moves get the stronger, slower guarantee.

**Index eligibility is a separate, stricter, human-reviewed gate — not
automatic from marketplace listing.** Launching a standalone vault (as
RobinWood's V3 already does) and being included in the Global Index are
deliberately two different, sequential stages with different bars:

1. A collection launches its own vault exactly like today, fully
   independent of the index.
2. It accumulates a real track record over time — real fee revenue, real
   locked LP, a minimum elapsed time, and a minimum count of *distinct*
   wallets trading it (weighted down for sybil-correlated wallets, reusing
   the existing `lib/boards-store.ts` reputation signal) — nothing here can
   be rushed or faked per the weight-metric design above.
3. At a **published, scheduled review point** (never continuous, never ad
   hoc), collections clearing the threshold are proposed for index
   inclusion through the strict human-reviewed gate.
4. If approved, the new constituent's weight **ramps in gradually** over a
   defined window (weeks, not one block) rather than jumping to its target
   weight instantly. This is directly modeled on how live weighted-pool
   products actually handle adding a new asset in production: Balancer's
   Managed Pools support exactly this via a gradual, governance-controlled
   weight transition, and real-world indices (S&P, MSCI, Index Coop) add
   new constituents only at scheduled, publicly pre-announced review dates
   with lead time before it takes effect. A sudden, instant weight jump is
   both a manipulation shock and a front-runnable MEV event; a gradual,
   announced ramp is neither.

**Rebalancing execution is never a naive market order.** Route every
rebalance trade through the same slippage-protected, min-out-guarded
execution path every other swap in this codebase already requires, and
execute in smaller pieces over a window rather than one large predictable
block — closes the classic sandwich-the-rebalance MEV vector, which is one
of the most heavily front-run events in real-world index funds too.

**Personal index creators get zero privileged power, ever.** Same rule as
the V3 treasury: real power only before the pool opens (choose weights,
seed it), zero privileged power the instant it does — proportional,
non-transferable LP like everyone else. Weights are locked at creation (or
changeable only through a slow, public timelock) and always shown before a
depositor signs, same as every wallet-facing value elsewhere in this app
already has to be.

**Parameter changes are timelocked and published, never instant or silent.**
Fee splits, weight-curve constants, and the buyback percentage all need to
stay tunable — but an instantly-changeable parameter is also a lever a
compromised or malicious key could quietly pull. Every economically
significant parameter change goes through the same transparent,
published-in-advance, timelocked discipline the buyback mechanic already
requires (§2.5) — enough delay that every collection and index holder can
see a change coming and react before it applies.

**Cross-index arbitrage is expected and healthy, not a vulnerability** — as
long as NAV pricing (above) is flash-loan-safe. Price differences between
multiple indexes holding overlapping collections self-correct through
ordinary arbitrage the same way any efficient market does; it only becomes
a problem if the underlying NAV computation can be manipulated in the first
place, which the pricing defense above is specifically what prevents.

### 2.8 Compromised-key blast-radius audit (2026-08-04)

**The anchor rule, extending V3's own already-audited guarantee ("no
owner-mutable fees, no admin withdrawal of pool ETH"):** no role in this
entire system — treasury, index creator, collection owner, protocol
admin — ever has a withdrawal path over *pooled reserves already held*.
Every privileged control any role has is scoped strictly to **future** fee
routing and **future** capital allocation, never to principal that's
already in the pool. A compromised key should be able to misdirect what
happens *next*; it should never be able to reach back and take what's
*already there*. Every existing adjustable control was walked through
against this test:

- **Plank Checks point weights** — adjusts future scoring only; the
  permanent ledger (`plank_checks_events`) is append-only, so a compromised
  key can misweight future points but can never rewrite or drain a past
  score. Safe.
- **Index weight-curve constants** (§2.7) — adjusts how future rebalances
  compute target weights; timelocked and published, and even at the
  extreme still bounded by the hard concentration cap. A compromised key
  can bias future rebalancing, never pull existing reserves. Safe.
- **Claimed-collection fee tier** (§2.4) — adjusts the fee rate applied to
  *future* trades only, within the existing 0–1000 bps bound, always shown
  to a buyer before they sign. A compromised creator key can raise their
  own future fee (self-harming, visibly, opt-in per trade); it cannot touch
  reserves already in the vault. Safe.
- **Treasury reassignment** — changes *where future* fee flows land, never
  grants a claim on existing pooled ETH; the wallet-verification design in
  §2 (signing from the collection's own launch/royalty address to change
  treasury) additionally requires proving control of the *right* key before
  even that future-facing change is allowed. Safe.
- **Buyback percentage** (§2.5) — the one gap this audit found: a
  timelock alone bounds *when* a change lands, not *how much damage* it can
  do once it does, since raising it high enough could starve the Global
  Index's own promised LP revenue-share indefinitely. Closed above with a
  hard, contract-level maximum ceiling in addition to the existing
  timelock.

No other gaps were found in this pass. Any new adjustable control proposed
for this system in the future must be run through this same test before
it ships: *does a compromised key holding this control ever get a path to
reserves that are already pooled?* If yes, it needs a structural fix before
it's acceptable, not just a timelock.

---

## 3. Routing intelligence (1inch/Matcha-style)

### 3.1 What "best execution" means here

Compare every available venue for a given v-token — the native Instant Swap
vault, plus any external pool (Uniswap, 9mm) once one exists for that
token — and route a trade, or split a large one, across whichever
combination gets the best net price. The app already does exactly this
shape for $PLANK itself (`lib/market/token-registry.ts`'s venue-neutral
design, routing through Uniswap and 0x today, explicitly built "so venues
can be added later"). Extending it to vault shares is applying an existing,
proven pattern to a new asset class, not inventing a new architecture.

### 3.2 The 9x / 9mmPro finding — blocked on real integration details

Per the admin (2026-08-04): **9x is the 9mmPro aggregator, and both it and
9mm's own DEX contracts are already live on Robinhood Chain.** This is the
highest-leverage first integration — reusing an existing, live aggregator
instead of building multi-pool pathfinding from scratch. This repo has zero
visibility into 9x/9mmPro's actual contract addresses, ABI, quote API, or
docs. **This section cannot be implemented until that information comes
directly from bullish** (he operates 9mm). Treat "get real 9x integration
details from bullish" as a concrete, named blocker, not an assumption to
guess past.

### 3.3 What's buildable today, independent of the 9x blocker

The router's core logic — compare N venues' quotes for the same trade, pick
or split the best combination, present it the way Matcha shows its route
breakdown — can be built and tested against the venues we *do* have
real access to today (native vault, Uniswap, 0x), with 9x added as one more
adapter the moment its details arrive. The venue-neutral architecture means
adding it later is genuinely "swap one adapter in," not a rewrite.

### 3.4 Index-share routing: mint-vs-secondary arbitrage, without starving the primary vaults (2026-08-04)

Buying or selling an index share on a secondary market (Uniswap, 9mm) does
not, by itself, touch the underlying collections the index actually holds —
only trading the index's *own* vault directly (mint/redeem) does that. Left
alone, a purely efficiency-seeking router would happily route all volume to
whichever is cheaper in the moment, which over time could mean secondary
liquidity absorbs sustained demand that never reaches the underlying vaults
at all — a "the derivative cannibalizes the underlying" risk.

**Mint-vs-secondary arbitrage integration.** The same best-execution router
from §3.1 should treat "buy the index share on the secondary market" and
"mint it directly from the index vault" as two more venues to compare, same
as it already compares the native vault against Uniswap and 9mm for any
other asset. This is the real precedent ETF Authorized Participants already
exploit professionally: whenever the secondary price of a share and the
real NAV of what it represents diverge, buying the cheap side and settling
the expensive side (mint if secondary trades rich, redeem if secondary
trades cheap) is a genuine arbitrage that mechanically pulls the two back
together — and it converts sustained secondary demand into real,
underlying-touching mint activity automatically, without requiring anyone
to be a professional arbitrageur to do it. Routing this through the same
consumer-facing router that already exists means ordinary users capture
what's currently an AP-only privilege in real-world ETFs.

**The primary-vault volume floor.** Arbitrage alone closes *price*
divergence but doesn't guarantee *volume* reaches the primary vault, since
efficient secondary liquidity can absorb flow indefinitely without ever
triggering the arbitrage trigger point. Real precedent for exactly this
problem: the U.S. equities Order Protection Rule exists specifically to
stop dark-pool/off-exchange venues from silently capturing flow away from
the lit, primary exchange that everyone's price discovery actually depends
on. Two layers, applied together, not as alternatives:

1. **Order-splitting is the router's default, not winner-take-all**, for
   anything beyond trivial trade size — the router divides a trade across
   the primary vault and secondary venues in the same execution, rather
   than sending 100% of a trade to whichever quoted marginally better.
   This is also just better execution practice on its own (reduces price
   impact versus dumping the whole size on one venue).
2. **A structural minimum volume-share the primary vault is always
   guaranteed**, set **adaptively proportional to the primary vault's own
   real current share of total available liquidity across all venues** —
   never a frozen fixed percentage, since a fixed number would either be
   too high once secondary liquidity genuinely deepens (bad execution for
   users) or too low if secondary liquidity thins back out (starves the
   vault that's supposed to be primary). As the primary vault's real share
   of liquidity moves, its guaranteed floor share moves with it.

These two layers stack with the mint-vs-secondary arbitrage above rather
than replacing it: arbitrage keeps price honest, the floor keeps volume
flowing to the primary vault even in the range where arbitrage alone
wouldn't yet trigger, and order-splitting-by-default means both happen in
the same trade instead of an all-or-nothing routing decision. The floor
itself is a published, timelocked, admin-adjustable parameter (same
discipline as every other parameter in §2.7) and its current value, along
with the live primary/secondary volume split it's producing, is shown on
the same public Grand-Exchange-style ticker (§2.3) — so the mechanism
protecting the fundamentals is as visible as the price it's protecting.

---

## 4. Build order (risk-ordered, matches what's actually shippable now)

1. **Plank Checks core** (§1) — ships first. Zero contract risk, fully
   buildable today, no external dependency.
2. **Meme-archiving attribution** (§1.5) — small, contained addition once
   §1 lands.
3. **Index Vault contracts + full test suite** (§2) — buildable as code now;
   **not deployed to mainnet** until an external audit clears it, same gate
   V3 went through. Building and testing can start in parallel with §1.
4. **Routing intelligence** (§3) — the core comparison/splitting logic is
   buildable now against existing venues; the 9x adapter specifically is
   blocked on bullish providing real integration details.

---

## 5. Architectural flexibility — staying able to evolve like competitors do

None of this is worth much if it's a dead end the moment the roadmap shifts.
Four concrete commitments, none of which cost anything to hold to now:

**Every economically significant number is a named, adjustable parameter,
never a hardcoded literal.** Fee splits, weight-curve constants, the buyback
percentage, the index weight cap, the free-wallet limit, the point weights —
all of it lives in one place, changeable through the timelocked process in
§2.7, never buried inline in contract logic where changing it means a
redeploy. This is the same discipline `MARKET_DEFAULT_FEE_BPS` and the
vault-registry pattern already established for per-collection fees; it just
needs to be applied consistently to everything new.

**New constituent types are an adapter, not a rewrite.** The Global Index
should be defined against an interface ("anything that can report a
verifiable NAV and accept/return value against it"), not against
`MarketplankVaultV3` specifically. Today that interface has one
implementation (vault share tokens); tomorrow it could accept an
NFT-fractionalization scheme that isn't a Marketplank vault at all, a wrapped
position from another chain, or a real-world-asset token, without changing
anything about the index itself — only adding a new adapter behind the same
interface. This is the same "venue-neutral" discipline
`lib/market/token-registry.ts` already uses for swap venues, applied one
layer up.

**Data and settlement stay separated, so a UI/feature pivot never touches
custody.** Plank Checks is proof this already works: the entire points
system is a read-only layer over data other, already-audited systems
produce. Keep that boundary sacred as the roadmap grows — a new leaderboard
view, a new reward type, a new season format should never require touching
anything that holds funds.

**Every new asset type gets its own audit gate, scaled to what it actually
risks — never inherited from a sibling system's audit.** V3's audit does not
cover an Index Vault; an Index Vault's audit will not cover whatever comes
after it. This is slower per-launch and faster overall, because it's the
only way "move fast" and "hold real user value" coexist without one
eventually eating the other.

---

## 6. DeFi mechanisms not yet employed anywhere in the plank.love vision

A direct gap-analysis answer to "what tricks and aligned incentives aren't
we using yet" — real, established patterns, not speculation, each mapped to
where it would actually fit:

- **Vote-escrow / gauge weighting (Curve's veTokenomics).** Lock $PLANK for
  voting power over where index emissions or fee-share flow — turns
  long-term PLANK holders into active stewards of which collections get
  boosted liquidity, rather than passive holders. A natural fit once the
  buyback mechanic (§2.5) exists to lock up, but a real, separate, larger
  project of its own — not a launch-day feature.
- **Protocol-owned liquidity (Olympus DAO's model).** Instead of relying
  entirely on mercenary LP capital that can leave overnight, have the
  treasury directly hold a permanent LP position (funded by real revenue,
  never printed), so a meaningful floor of liquidity never depends on
  anyone else's incentive to stay.
- **Time-locked vesting on creator fee shares (§2.4).** Without it, a
  creator opting into a higher fee tier could pump their own collection's
  activity briefly, harvest the fee share, and abandon it. Vesting the
  creator's fee-share payout over time aligns their incentive with the
  collection's durability, not just its next 24 hours.
- **Retroactive public-goods-style rewards for early risk-takers.** Once
  points can convert to real value (§1.7), consider a one-time retroactive
  bonus for wallets with real, verifiable activity *before* any of this
  existed — rewards the people who took the actual risk of using an
  unproven system, a well-established pattern in how mature protocols treat
  their earliest real users.
- **A genuine insurance/backstop fund (Aave's Safety Module).** A small,
  published percentage of protocol revenue accumulates as a standing
  backstop against a future black-swan event (an exploit despite audits,
  an oracle failure) — funded the same never-negative-sum way everything
  else here is, and a real trust signal to prospective collections
  deciding whether to list here versus elsewhere.
- **Dutch-auction-style rebalancing (Balancer LBP mechanics), as an upgrade
  path beyond the TWAP/small-piece execution in §2.7.** Once volume
  justifies the complexity, a Dutch auction for rebalance trades can extract
  even less MEV than piecewise execution alone, at the cost of real added
  complexity — worth having in mind as a later optimization, not a
  first-version requirement.
- **Composability with a real lending market, if one ever exists on
  Robinhood Chain.** The Global Index share, once trusted and liquid
  (Gen 2 in the ticker's own roadmap, §"public price ticker" discussion),
  is a natural collateral asset — this is deliberately not scoped or
  designed here, since it depends entirely on infrastructure this repo
  doesn't control, but it's the direct, obvious next step once it exists.

None of the above is scoped for near-term build — flagged here specifically
because they're the kind of mechanism a competitor with a longer head start
would already be reaching for, and worth having named and prioritized rather
than discovered under pressure later.
