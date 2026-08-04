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
