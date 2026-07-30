# Marketplank security audit — 2026-07-27 (Fable pass)

> [!NOTE]
> Historical internal audit and remediation record. Later sections in this
> document supersede earlier blockhash findings with the drand design, but the
> final pre-launch recommendation still reflects the state at the moment it
> was written. V1 and V2 were subsequently deployed, Marketplank was enabled,
> and the application moved from Vercel KV/Cloudflare Worker hosting to
> InMotion Passenger with PostgreSQL. No independent third-party audit has
> been recorded in this repository.

**Verdict: NOT READY for `MARKET_ENABLED=true`.**

This pass found defects that the previous audit either missed, declared sound,
or explicitly accepted on a risk assessment that turns out to be wrong. Several
were reproduced against a running instance, not merely reasoned about.

Read the "What I could not verify" section before you act on anything here. It
is not an appendix; it is half the result.

---

## 0. Method, and why you should discount this document

Five independent adversarial passes ran first, each on **Claude Fable 5**
(each self-reported its model id on demand; every result quoted here comes from
an agent that attested `claude-fable-5`). Each was told to form its own view
**before** reading `AUDIT-2026-07-27.md` or `SPEC.md`, so the prior audit's
conclusions could not anchor them.

Discipline applied throughout: **reproduce before you fix.** Every finding
below that is marked PROVEN has a test or a live request that fails because of
the defect. Findings that could not be demonstrated are marked UNPROVEN and are
kept separate — they are hypotheses, not results.

**The conflict of interest is real and unresolved.** I am the same model family
that wrote most of this code. I share its blind spots by construction. Five
adversarial passes reduce that risk; they do not eliminate it. `SPEC.md` gate 3
already requires an independent third-party audit before go-live, and nothing
in this document satisfies that gate.

---

## 1. On-chain facts, independently verified

Every address the code depends on was checked against the chain, not taken
from the repo. Chain id confirmed `0x1237` (4663).

| What | Address | Result |
|---|---|---|
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` | **Canonical.** 23,981 bytes. Bytecode differs from Ethereum mainnet in exactly two regions: the cached chainId (`1237` vs `0001`) and the 32-byte cached EIP-712 domain separator. The Robinhood domain separator was independently recomputed from `keccak(EIP712Domain, "Seaport", "1.6", 4663, address)` and **matches the value embedded in the deployed bytecode**. Every other byte is identical. |
| ConduitController | `0x00000000F9490004C11Cef243f5400493c00Ad63` | **Canonical, byte-identical to mainnet** (same keccak of deployed code). |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Legitimate bridged **aeWETH**, but it is an **EIP-1967 upgradeable proxy** (impl `0xC6B8…947e`, admin `0xa3ac…67df`). Normal for an Orbit chain; the trust assumption equals trusting the rollup. `deposit()`/`withdraw()` confirmed functional. |
| RobinWood NFT | `0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156` | Verified `RobinWoodPlank`, ERC-721 + Enumerable, `totalSupply() = 1542`. Owner is `0x269A…bB0d`, an **EIP-7702 delegated EOA** — a single hot-key-style admin. |
| $PLANK | `0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc` | Verified ERC-20, `owner() == 0x0` (renounced). |
| Fee treasury | `0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8` | **EOA** (`eth_getCode` empty), so it can always receive fees — sales cannot revert on the fee leg. But **nonce 0, balance 0**: nobody has ever demonstrated control of this key. If it is wrong or lost, every fee is burned to an address no one can spend from. |

**Impostor WETH is a real hazard, and the code is right to avoid symbol
lookup.** ~12 other contracts on this chain report symbol `WETH`. The validator
resolves WETH by hardcoded address only — verified by grep, no symbol
resolution anywhere.

---

## 2. Where the prior audit was wrong

The brief warned that prior conclusions are hypotheses. That was correct.

**2.1 — "Deliberately unresolved: EIP-712 signature verification at the relay."**
The prior audit knew signatures were unverified and accepted the risk, reasoning
that a bad order "simply fails on-chain, costing a would-be buyer gas but never
funds." **That risk assessment is wrong**, and the error is not subtle: because
a forged order is never signed, it can never be *cancelled* on-chain either, so
the DELETE path (which only removes orders Seaport reports dead) can never
remove it. ~102 unauthenticated HTTP requests permanently evict a real user
from the marketplace for up to 180 days. That is not "costs a buyer gas."
See CRITICAL-1 and CRITICAL-2.

**2.2 — "Reviewed and found sound: `lib/wallet.ts` … Permit2/token-only approval
allowlist."** The Permit2 constant is **malformed** — one hex character short of
a 20-byte address. I verified the literal independently. The approval allowlist
built from it can never match the real Permit2, so the guarded path is dead, not
sound. Declared sound; actually broken.

**2.3 — "HIGH 4: Random redemption could be cherry-picked for free — fixed by
commit-reveal."** The fix is bypassed. It freezes the *seed* but not the
*selection domain*: `heldTokenIds` stays freely mutable by anyone after the
commit, so an attacker permutes the array rather than rerolling the seed, and
lands the draw on the rare token in a single transaction. See VAULT-1.

**Credit where due.** The prior audit *did* disclose the `refreshRandomRedeem`
reroll as a known, bounded trade-off rather than hiding it. That disclosure is
accurate. The problem is that VAULT-1 defeats the same protection far more
cheaply — no waiting at all.

**Confirmed sound, independently:** the Seaport canonicality claim (§1), the
listing-side price derivation, rejection of `CONTRACT` and zone-restricted
orders, `totalOriginalConsiderationItems` consistency, Dutch-auction rejection,
vault reentrancy discipline, fee immutability, and the Trade widget's
simulate-before-send hardening (which is genuinely better than most production
dapps).

---

## 3. Findings

Severity reflects impact on a real user with real money.

### CRITICAL-1 — The relay accepts orders nobody signed (PROVEN, reproduced by hand)

`lib/market/order-validation.ts` — the entire signature check was:

```ts
if (typeof o.signature !== "string" || o.signature.length < 4) fail("Order has no signature.");
```

No `verifyTypedData`, no `ecrecover`, no EIP-1271, no domain, no chainId. The
`maker` was simply `parameters.offerer` — a string the client typed.

**I reproduced this myself** against a local instance, with the store emptied
first so the result was unambiguous:

```
POST /api/market/orders   signature "0xdeadbeef", offerer = a wallet I do not control, price 1 wei
→ HTTP 200
GET  /api/market/orders?collection=robinwood&kind=listing
→ the forged 1-wei listing, served publicly, with the victim's real artwork
```

Every question about compact 2098 signatures, malleable `s`, or `v` encoding is
moot: the bytes were never read.

**Impact:** a fake 1-wei floor price attributed to a real wallet; every buyer
who clicks burns gas on a guaranteed revert.

### CRITICAL-2 — Forged orders are undeletable, which locks the victim out (PROVEN)

DELETE removes an order only if Seaport reports it dead. A never-signed order is
never cancelled, filled, or invalidated, so `getOrderStatus` returns all-zero
and the relay answers `409 STILL_LIVE`. The junk is immortal until an expiry the
attacker chooses (cap 180 days), and `MAX_ORDERS_PER_MAKER = 100` is counted
against the **claimed** maker.

**Observed, unprompted, in my own environment:** while reproducing CRITICAL-1 I
found the book already holding 100 forged listings attributed to one real
wallet, and my own genuine POST was refused:

```
{"error":"TOO_MANY","message":"You have too many open orders."}
```

That is the lockout, live. Rendered, it is 100 identical fake "#1" listings at
~0 Ξ — see the audit screenshots.

### CRITICAL-3 — Bid clawback: displayed price ≠ what the seller receives (PROVEN)

`validateOfferOrder` set `priceWei` from the offer item alone. ERC-20
consideration amounts were never subtracted and never capped, and only items
paid to the fee recipient were even summed. Because the Seaport **fulfiller**
pays every consideration item, a bid of `offer = 1 WETH` with
`consideration = [NFT→bidder, 0.99 WETH→bidder]` validated, displayed as a
**1 ETH bid**, and netted the seller **0.01 ETH**.

This is the cardinal sin the file's own header says it exists to prevent —
closed on the listing side, open on the offer side. Tests `A1`, `A2`.

### CRITICAL-4 — One payment, N planks (PROVEN)

`sawCollectionItem` was a boolean and `tokenId` was overwritten by the last NFT
consideration item seen. A bid naming **two** ERC-721 consideration items
validated, displayed as an offer on one token, and would hand over both for a
single payment. Test `A3`.

### VAULT-1 — CRITICAL — Commit-reveal is defeated by permuting the array (PROVEN)

The draw is `heldTokenIds[keccak256(seed, msg.sender) % heldTokenIds.length]`.
The seed is frozen at commit — but the **length and ordering of `heldTokenIds`
remain mutable by anyone afterwards**, and `deposit()` is permissionless and
unrestricted while a request is pending. One block after committing, the seed is
public, so the attacker computes off-chain how many throwaway NFTs to deposit to
land the index on the rare token, then executes `deposit × k; claimRandomRedeem()`
in **one transaction**, wrapped in `require(got == rare)` so a miss reverts
everything for the price of gas.

This reinstates exactly the free-retry rare-sniping that the previous audit's
fix was introduced to stop. Proven by `EXPLOIT A` with a purpose-built sniper
contract.

### VAULT-2 — HIGH — Any third party can steer or grief a pending draw (PROVEN)

Same root cause, exercised by someone else. A victim commits; any observer —
or the single Orbit sequencer, which orders transactions unilaterally —
front-runs the victim's claim with one unrelated `deposit()` and changes an
outcome the victim has already paid for. Proven: bob's draw was token 5; one
unrelated deposit made it token 4. `EXPLOIT B`.

### VAULT-3 — MEDIUM — Seeded pool ETH is stranded; the AMM cannot be bootstrapped (PROVEN)

`seedLiquidity()` is the only ETH inflow and there is deliberately no withdrawal
path. The **share** side of the pool is `balanceOf(address(this))`, and nothing
moves shares into the vault except `sellShares` — which itself reverts with
`EmptyVault` while the share reserve is zero. `buyShares` reverts identically.
A freshly seeded vault is therefore **bricked on both sides and the treasury's
ETH is unrecoverable**, unless a stranger makes an uncompensated share donation.
`EXPLOIT C`.

### WALLET-1 — HIGH (functional) — `PERMIT2_ADDRESS` is malformed (PROVEN, verified twice)

`lib/constants.ts` held a Permit2 address one hex character short of 20 bytes.
`APPROVE_SPENDERS` derives from it, so `assertSafeSwapDestination` rejects every
$PLANK sell approval with "Blocked unsafe approval target". The sell path was
dead for any wallet without a pre-existing allowance. I confirmed the literal
length independently of the agent that found it.

### WALLET-2 — HIGH — Accept-bid never re-derives the order client-side

`handleBuy` deliberately re-runs `validateListingOrder` in the buyer's own
browser, with a comment explaining that this is what stops a compromised API
from showing one price while the wallet signs another. `handleAcceptOffer` had
**no equivalent** — the relay's `rawOrder` went straight into `fulfillOrder`
with no validation, no tokenId cross-check, and no confirm modal. seaport-js
derives the fulfiller's approval target from the order, so a crafted offer
could make a seller `setApprovalForAll` on an attacker-named ERC-721 while the
screen said only "Accepting offer on #N".

### WALLET-3 — HIGH — Infinite approvals, granted before they are needed, with no revoke path

`exactApproval` was never passed, so seaport-js defaulted to
`setApprovalForAll(Seaport, true)` over the seller's entire collection and
`WETH.approve(Seaport, 2^256-1)`. Both are broadcast **before** the order is
signed, so a user who approves and then cancels at the signature prompt is left
with a live blanket approval and nothing to show for it. No revoke UI existed.

### WALLET-4 — HIGH — The market/vault surface bypasses `lib/wallet.ts`

`lib/market/seaport.ts` and `vault.ts` build a raw ethers `BrowserProvider` and
send through the ethers signer, so `sendTransaction()`'s per-send `eth_chainId`
recheck, `to`-allowlist, and hard-fail-on-reverting-`eth_call` never run.

**Nuance in the app's favour, worth stating because the brief asked:** the
static-network construction *pins* the EIP-712 domain chainId to 4663, so
wrong-chain **signing** is not a vulnerability here. That specific concern is
disproven.

### RELAY-1 — HIGH — Rate limiting is bypassable; no body size cap

`getClientIp` trusted the **first** element of the attacker-supplied
`X-Forwarded-For`. Observed: 40 unspoofed POSTs correctly hit 429; 60 POSTs with
a rotating XFF produced **zero** 429s. `readJsonBody` had no size limit — a
**20,972,119-byte** body was accepted, parsed, validated, and stored verbatim.
The rate-limit `buckets` Map had no eviction (50k entries in test).

### RELAY-2 — MEDIUM — The order book is served with zero liveness filtering

GET pruned on `expiresAt` only. No `getOrderStatus`, no `getCounter`, no
`ownerOf`, no `isApprovedForAll` at read time. Cancelled, filled,
counter-invalidated, transferred-away and un-approved orders all stayed visible
and clickable. `ownsToken` additionally **failed open** (`return true`) on any
RPC error, with a single RPC and no fallback.

### Medium and low, in brief

- **ORD-1 (HIGH)** — `conduitKey` was never validated. An arbitrary key yields an
  undefined operator and guaranteed-revert fills.
- **ORD-2 (HIGH)** — ERC-721 consideration amounts were never asserted `== 1`;
  the same gap would be silent quantity inflation on an ERC-1155 path.
- **ORD-3 (MEDIUM)** — criteria bids accepted a non-zero Merkle root while being
  displayed as "offer on any plank", so sellers outside the root saw a bid they
  could never fill.
- **ORD-4 (MEDIUM)** — `endTimeToIso` threw `RangeError`, not
  `OrderValidationError`, turning a malformed order into an unauthenticated 500.
- **ORD-5 (LOW)** — `maker` was echoed in attacker-chosen casing, letting one
  wallet mint distinct order ids per casing.
- **VAULT-4 (LOW/design)** — the constant-product pool charges **no swap fee**, so
  seeded ETH is a one-way subsidy to arbitrageurs.
- **UX-1 (MEDIUM)** — "Offer any" collection-wide bids are built as criteria items
  but fulfilled with no criteria resolver or proof, so they are unfillable while
  still consuming the maker's order cap and leaving a live WETH approval.
- **UX-2 (LOW)** — `handleAcceptOffer` had no double-submit lock, unlike every
  other action.

---

## 3b. Fixes applied, and how each was verified

Every fix was made by a Fable pass that owned a disjoint set of files, and each
was required to leave the exploit test in place and make it pass by changing the
code. Test count went from **36** (17 relay/validator + 19 contract) to **105**
(73 + 32). `npm test`, `npm run build` and `npx tsc --noEmit` are all green.

| Finding | Fix | Verification |
|---|---|---|
| CRITICAL-1 | New `lib/market/signature.ts`: full Seaport 1.6 EIP-712 digest over `OrderComponents` incl. `counter`, domain pinned to chainId 4663 and the Seaport address; `recoverAddress` must equal `offerer`. EIP-2098 compact sigs normalised; high-`s`, bad `v`, zero-address recovery rejected. EIP-1271 via `isValidSignature` when the offerer has code. **Every RPC failure rejects.** | **I re-ran my own forgery by hand.** The exact request that returned 200 now returns `400 BAD_SIGNATURE` and the book stays empty. Separately, a **genuine** EIP-712 signature from a fresh EOA passes the signature check and proceeds to the ownership check (`NOT_OWNER`) — proving the gate rejects forgeries without blanket-rejecting everything. |
| CRITICAL-2 | Orders whose signature fails offline are now purgeable; plus authenticated self-delete via a `personal_sign` proof bound to the order id. On-chain-dead path retained. | Root cause closed by CRITICAL-1; relay tests cover the purge path. |
| CRITICAL-3 / -4 | Offer `priceWei` is now the seller's **NET** (offer amount minus fee); any ERC-20 consideration paid to a non-treasury recipient is rejected; exactly one ERC-721 consideration item required. | Tests `A1`–`A3` fail before, pass after. |
| VAULT-1 / -2 | `requestRandomRedeem` freezes `frozenLen` at commit and draws modulo it, and the draw is **pinned** to a concrete token as soon as the block hash exists. Deposits can only append, outside the draw set. | `EXPLOIT A` still drives the full padding attack 10× and now asserts the sniper reverts; `EXPLOIT B` passes unmodified. |
| VAULT-D (mine) | **My suspected `refreshRandomRedeem` reroll was verified real** — an unclaimed request re-anchored changed the drawn token from 6 to 7. `refreshRandomRedeem` was removed; pinned draws never expire; expired-unpinned requests go to a permissionless `forfeitExpiredRedeem` that re-mints the burned share to the treasury. | `EXPLOIT D` + `D part 2`. |
| VAULT-3 | Treasury-only `seedShares(uint256) payable` bootstraps both pool sides atomically. Still no withdrawal path. | `EXPLOIT C`; a test asserts no `withdraw*` function exists. |
| WALLET-1 | Permit2 address corrected, plus a module-load assertion that every exported address constant is a well-formed 20-byte address. | `AUDIT-1`, `AUDIT-4`. |
| WALLET-2 | `handleAcceptOffer` now mirrors `handleBuy`: re-derives via `validateOfferOrder`, cross-checks tokenId and price, and routes through a confirm modal showing **net proceeds**. | Pure helper `assertAcceptableOffer` unit-tested (`AUDIT-5`). **The React wiring itself is not test-covered** — see §4. |
| WALLET-3 | `exactApproval: true` (per-token `approve`, bounded WETH allowance) plus a revoke panel in MyPositions. | seaport-js behaviour verified in `node_modules`; **revoke UI not driven in a browser**. |
| WALLET-4 | Market and vault sends now go through `sendTransaction()` with `kind: "market" \| "vault"` allowlists, simulation, and a chainId re-assert before every send. EIP-712 signing keeps the pinned static-network domain. | `AUDIT-8`. |
| RELAY-1 | Client IP taken from the platform header or the **rightmost** hop; 64KB body cap enforced before parsing; bucket map evicted. | Relay tests. |
| RELAY-2 | Read-time liveness filtering with a 30s cache; `ownsToken` now **fails closed**. | Relay tests. Liveness display deliberately fails *open* so an RPC outage does not blank the book — an explicit, documented asymmetry. |
| ORD-1…5, UX-1, UX-2 | conduitKey restricted to the zero hash; ERC-721 amounts must be 1; ERC-1155 rejected outright; criteria root must be 0; `endTime` bounded; `maker` lowercased; **"Offer any" disabled (fail closed)** because the criteria-resolver fulfil path could not be verified; accept-offer double-submit lock. | Tests `A4`–`A7`, `AUDIT-6`. |

**Two test assertions were rewritten, and both deserve your scrutiny.** `A2` as
originally written was jointly unsatisfiable with `A1` (same order; one demanded
rejection, the other demanded a returned price) — it was re-pointed at the only
legitimate deduction shape, with `A1`'s rejection still enforced. Vault
`FINDING 6` was rewritten because a genuinely frozen draw changes which token is
reserved. Neither exploit test was deleted or loosened; both replacements are
strictly stronger. Verify this yourself if you verify nothing else.

## 3c. What was built (Phase 2/3), and what I actually observed

Verified by me in a real browser at **1280px and 390px**, with screenshots:

- **Activity feed** (`/api/market/activity`, new) — built from the collection's
  own ERC-721 `Transfer` logs, not from the relay, because relay-derived history
  could be poisoned by anyone who can write to the book. Seaport's
  `OrderFulfilled` is not the primary source: it carries the collection only in
  its data payload, so an unfiltered query returns "logs matched by query
  exceeds limit of 10000" (observed). **Renders real chain data**, including a
  real Seaport sale of #704 whose price shows "—" because it settled in WETH —
  no price rather than a false zero.
- **Item detail** (`/api/market/token`, new) — real owner, real traits, real
  per-token history; malformed ids rejected before any RPC or gateway call.
  Cards are now clickable and keyboard-operable.
- **Search and price filters**, pinned by 7 unit tests including the case where
  a half-typed decimal must not blank the grid.
- **URL state** — `?tab=` and `?item=` are shareable and Back/Forward works.
- **Wallet chip** with address and live balance.

Two defects I introduced and then fixed after seeing them rendered: the activity
enrichment was serial (the feed hung on "Loading…") and the token API returned a
raw `ipfs://` image URI that the site's own CSP blocks. Both were caught only by
looking at the page, which is the argument for looking at the page.

## 4. What I could not verify, and why

This section is as important as the findings.

1. **Arbitrum Orbit `block.number` / `blockhash` semantics — UNPROVEN.** Hardhat
   simulates L1 semantics, so the exploit tests cannot settle this. On Nitro,
   `block.number` is an estimate of the **L1** block number while `blockhash()`
   resolves against L2 blocks, and Arbitrum documents its block hashes as **not
   cryptographically secure and derivable by the sequencer in advance**. Two
   consequences remain unmeasured: `BLOCKHASH_WINDOW = 256` may be denominated
   in the wrong unit, and **the single sequencer can bias any draw outright**,
   regardless of VAULT-1/2. Do not treat `blockhash` as a safe randomness source
   on this chain without testing against the live chain.
2. **No live-chain fill was ever executed.** No funded wallet on chain 4663 was
   available, and I do not handle private keys. Every money-movement conclusion
   rests on Seaport's specification and the seaport-js source, not on an
   observed on-chain trade. **No buy, sell, bid, accept, cancel, deposit or
   redeem has been observed working end to end against the live chain by me.**
3. **The vault has never been deployed or run against a real chain.** All vault
   results are Hardhat-only.
4. **Vercel KV behaviour under load is inferred, not observed.** The relay tests
   ran against the file/`globalThis` fallback. The single-key read-modify-write
   in `putListing` has no CAS, so concurrent POSTs can lose orders — read from
   the code, **not** reproduced by a race harness.
5. **Whether Vercel's edge overwrites `X-Forwarded-For` in production** is
   unconfirmed; the bypass is proven only against `npm run dev`. The unbounded
   bucket map is unconditional regardless.
6. **EIP-1271 contract-wallet signers** are untested end to end.
7. **The fee treasury key.** Nonce 0 and balance 0 mean nobody has demonstrated
   control of it. I cannot verify the owner holds it.
8. **`/api/uniswap/*` server routes** were outside this scope and were not
   audited.

---

## 5. Residual risk

Even with every finding above closed, the following remain true and are not
mine to sign off:

- **No independent third-party audit exists.** `SPEC.md` gate 3 requires one
  before `MARKET_ENABLED=true`. This document does not satisfy it, and I am not
  a neutral reviewer of code I helped write.
- **The vault's randomness depends on a property of this chain that was not
  tested on this chain**, and on a **single sequencer** that can reorder
  transactions at will.
- **The NFT collection has a live EIP-7702 EOA admin**, and **WETH is an
  upgradeable proxy** controlled by the bridge admin.
- **The relay is a single point of trust for order availability.** Client-side
  re-derivation limits what a compromised relay can *steal*, but it can still
  censor, spam, and mislead.

---

## 5b. Post-audit change: randomness replaced with drand + BLS (2026-07-27, later same day)

Owner decision: accept no design that leaves the sequencer able to bias the
draw. `blockhash` is gone. New architecture:

- `contracts/DrandBeacon.sol` — a permissionless beacon: anyone can call
  `submitRound(round, signature)`, which verifies a real BN254 BLS pairing
  (`contracts/lib/BLSBN254.sol`, written from RFC 9380, not vendored blind) and
  caches the result. First valid submission for a round wins; nothing can
  overwrite a cached round; invalid signatures revert and never poison state.
- The vault's `requestRandomRedeem` now targets a **future drand round** that
  doesn't exist yet at request time, instead of a block number. `claimRandomRedeem`
  reads that round from the beacon once anyone has relayed it (~seconds later,
  `scripts/relay-drand.ts` is a permissionless convenience relayer, not a trust
  dependency). Frozen draw length, single-pin, no-reroll all carry over
  unchanged from the earlier fix.
- **The real-signature test is genuine, not mocked** — I independently ran it
  myself (`npm run test:contracts`) rather than trusting the build agent's
  report: a real BN254 keypair signs a real message via `@noble/curves` (an
  independent third-party curve implementation reached through `viem`'s
  dependency tree, not our own code), and the on-chain verifier accepts the
  genuine signature and rejects six distinct forgery shapes. 32 tests → 43,
  all green, confirmed by me.
- **What is not yet proven:** wire compatibility with the live drand network.
  No fixture round was available in this sandbox (no network access), so the
  chain hash, group public key, genesis, and period are placeholders — real
  values must be pulled from `https://api.drand.sh/<chainHash>/info`, cross-
  checked against a second independent mirror, **by the owner**, before deploy.
  The deploy tool (`scripts/deploy-tool/`) refuses to fetch these itself for
  exactly this reason — that fetch happening inside AI-authored code is not
  something you should trust unseen.
- **Honest framing of what this buys:** the trust root moves from "the single
  sequencer that also orders your transactions" to "a threshold of drand's
  externally-operated, publicly-auditable League of Entropy committee not
  colluding with your adversary." That is a real improvement, not a solved
  problem — say so to users if you ship it, don't call it trustless.

## 5c. Post-audit change: the drand gap closed, and a real deploy tool built (2026-07-28)

Two things that were placeholders in §5b are no longer placeholders:

**Real drand parameters, cross-checked and proven.** I fetched
`https://api.drand.sh/v2/beacons/evmnet/info` and the same endpoint on
`api2.drand.sh` myself — both agreed exactly on chain hash, public key,
genesis, period, and scheme (`bls-bn254-unchained-on-g1`). I then fetched a
**real, currently-published round** (19229507) from both mirrors, also exact
agreement, and had a Fable pass wire it into
`test/contracts/fixtures/drand-round.json` and run the previously-gated
"verifies a REAL drand round" test. **It passed on the first attempt** — the
on-chain BLS verifier accepts a signature actually produced by drand's live
network, not a self-consistent mock. I independently re-ran the full suite
myself afterward: 44/44 passing. This closes the one gap §5b flagged as
genuinely unproven.

One real bug surfaced and got fixed along the way: the G2 public key ordering.
EIP-197's pairing precompile wants `[x_imag, x_real, y_imag, y_real]`; a naive
port of Anyrand's own published quickstart snippet (`[x.c0, x.c1, y.c0,
y.c1]`) would have been wrong for this contract specifically. The Fable pass
resolved it empirically — imaginary-first parses to a valid on-curve point,
real-first doesn't — rather than trusting either convention on faith. Worth
noting: getting this wrong is a *safe* failure mode (the pairing check simply
never validates, so the beacon never accepts anything), not a security hole.

**A wallet-signed deploy tool, not a private-key script.** `scripts/deploy-tool/`
is a standalone page — never shipped to plank.love — where you connect either
a browser extension or a mobile wallet via WalletConnect v2 (QR code) and sign
every transaction yourself. I never see a key either way. Two real things worth
knowing:

- The esm.sh CDN could not transpile WalletConnect's dependency tree (confirmed
  by hand — 404s on `uint8arrays` and `@walletconnect/relay-auth` deep
  imports), so it's bundled locally with esbuild instead. Documented in the
  tool's own README.
- A Fable adversarial review of the finished tool found the Step 5
  "independent verification" panel — the one thing meant to catch this tool
  lying to you about what actually deployed — was **calling a function that
  doesn't exist** (`beacon.genesis()` instead of `beacon.genesisTimestamp()`),
  which meant it silently failed and skipped every check every time. I
  confirmed this myself against the real ABI before fixing it, added checks
  the review flagged as missing (`vault.beacon()`, `beacon.getPublicKey()`,
  `beacon.domain()` — the values an attacker would most want to swap), and
  added a chain re-check immediately before each deploy transaction signs,
  not just at connect time. The lesson generalizes: a "verify what actually
  happened" step is only as good as its own correctness, and this one wasn't,
  until it was checked.

## 5d. Final pre-gas-spend gate (2026-07-28): two more real HIGH bugs found and fixed

Before the owner connected a wallet to pay real gas, I ran one more adversarial
pass — Solidity safety AND gas efficiency together, a full dependency/supply-
chain audit, and a live UI/UX review — specifically because nothing here is
upgradeable (verified: no proxy, no owner, every parameter `immutable`), so a
miss here ships forever. Findings, each independently re-verified by me before
any fix was applied — not taken on the reviewing agent's word:

**F-1 (HIGH) — drand round off-by-one erased the safety margin.**
`DrandBeacon.currentRoundAt` computed `floor((t-genesis)/period)` instead of
drand's real convention, `floor((t-genesis)/period) + 1`. I verified this
myself against the repo's own real fixture data (genesis 1727521075, period 3,
round 19229507 published at t=1785209593 — `floor((1785209593-1727521075)/3)`
= 19229506, one less than the round actually live at that instant). The
consequence: the vault's intended 2-round (~6s) lead over the sequencer's clock
was quietly eroding to ~3s, and if `block.timestamp` on this chain ever lags
real wall-clock by more than one period, an attacker could compute the target
round's outcome from the already-published signature before their request
even lands — defeating the entire commit-then-draw property. Fixed with the
`+1` correction; the existing "target round is in the future" test was found
to be circular (it compared against the contract's own buggy view of "now",
so it passed regardless of the bug) and was replaced with one that computes
the correct external formula independently. 53/53 tests pass; I re-derived the
corrected formula against my own ground-truth round data and it now matches
exactly.

**F-2 (HIGH) — a requester that can't receive an NFT permanently bricked random
redemption for everyone.** I traced this myself: `pinPendingDraw()` is a
standalone, permissionless function that commits `pinned = true` to storage in
its own transaction, separate from delivery. If the requester is a contract
without a working `onERC721Received`, every subsequent claim attempt reverts
on the transfer — but the pin from the earlier, already-successful transaction
stays committed, and `forfeitExpiredRedeem` requires `!pinned`, so it's
permanently blocked too. Since there is only one pending-request slot
vault-wide, this kills random redemption for every user, forever, for the cost
of one share — and is reachable *by accident* by any smart-contract wallet.
Fixed by switching the final delivery in `_settle` from `safeTransferFrom` to
plain `transferFrom`: the recipient chose to request redemption, so removing
the receiver-safety callback from that one specific transfer removes the
deadlock surface without weakening `deposit`/`redeemTarget`, which keep the
safe variant. A PoC using a purpose-built non-receiving mock reproduced the
permanent brick against the pre-fix code (two distinct terminal reverts, one
of them past the full 24h expiry window) and confirmed the fix closes it.

**Gas, applied because the interface between the two contracts was still free
to change before either deployed:** the beacon's public key and DST moved from
storage to true `immutable`s (~14,800 gas saved on every relayed round — the
system's hottest function), the vault's pending-request bookkeeping was packed
into one storage slot instead of two (~21,600 gas saved per request), and
`_pinPendingDraw` was collapsed from two external calls to one (~2,700 gas per
pin). A duplicate-token-entry guard was added as defense-in-depth. Measured:
DrandBeacon 5,330→5,713 bytes deployed, MarketplankVault 10,519→10,707 —
both comfortably under the 24,576-byte EIP-170 limit (I confirmed both figures
myself from the compiled artifacts).

**Dependency audit**: the three dependency trees (main app, Hardhat toolchain,
deploy-tool) are genuinely isolated, no typosquatting or maintainer-transfer
red flags, and the OpenZeppelin 4.9.6 pin is sound. One real runtime-reachable
finding: `next` 16.2.10 carried several HIGH advisories (SSRF in Server
Actions, cache confusion, image-optimizer DoS) fixed in the 16.2.12 patch —
applied. `postcss`/`sharp` (image-optimization path, genuinely used — 8 files
import `next/image`, no `unoptimized` escape hatch) were pinned forward via
package.json `overrides`; the `sharp` bump specifically was tested for real
(build + a direct request through Next's `/_next/image` route) since it sits
outside Next's own declared peer range, not just assumed safe. The
deploy-tool's WalletConnect dependency carries a bundled `lodash` HIGH
advisory, but it's unreachable — nothing in this flow feeds attacker-controlled
input to the vulnerable functions, and the actual key custody lives entirely
in the owner's separate wallet app, never in this page.

**UI/UX**: no blocking issues at either 1280px or 390px. I fixed the two
functional ones — the tab strip's native scrollbar (hidden, matches the
site's polish level) and a tab landing off-screen with nothing visibly
selected when reached via a direct link like `?tab=swap` (now scrolls itself
into view) — plus the Offer form not closing on Escape (now consistent with
the item detail modal) and Activity rows labeled "Sale" showing a bare,
broken-looking "—" for WETH-settled trades (now reads "in WETH"). Full test
suite re-run after: 73 relay/market + 53 contract = 126 passing, typecheck and
build clean.

## 6. Go-live recommendation

### Do not deploy the vault. Do not set `MARKET_ENABLED=true` yet.

**The vault must not be deployed with real value.** This is not a close call:

1. Its random redemption depends on `blockhash`, and **Arbitrum's own
   documentation states L2 block hashes are not cryptographically secure and can
   be derived in advance by the sequencer.** The fixes close every
   *permissionless* attack — any user, any bot, the redeemer themselves. They do
   not close the **single sequencer**, and no contract logic can. Ship targeted
   redemption only, or move to a VRF / L1 beacon.
2. The AMM has **no LP accounting, no swap fee, and a share reserve that is a
   bare `balanceOf(this)`**, so anyone can donate shares to move the price and
   the first buyer into a thin pool is sandwichable. It is a toy pricing curve
   holding permanently-committed treasury ETH.
3. **Revision 2 of this contract was self-reviewed too, and shipped a bypassable
   fix for the exact defect it claimed to close.** That pattern — not anyone's
   confidence — is the thing to weigh.

**The marketplace (Seaport) layer is in materially better shape** than it was
this morning: forgery is closed and I verified that by hand, the offer-side
price now equals what the seller receives, approvals are scoped, and every send
goes through the hardened wallet rail. But `SPEC.md` **gate 3 requires an
independent third-party audit**, and this document does not satisfy it — I am
the same model family that wrote the code and I share its blind spots. I am not
going to flip the flag on my own review, and you should not want me to.

**Also unresolved before any launch:** nobody has demonstrated control of the fee
treasury key (`0xcdb7…e9d8` has nonce 0 and balance 0). Send a trivial
transaction from it first. A wrong address there burns every fee forever.

### If the owner chooses to proceed anyway

I do not handle private keys, so every step below is yours to run.

**Deploy the vault** (only after a third-party audit, and preferably with random
redemption disabled):

```bash
cd robinwood-plank
export PRIVATE_KEY=...            # your deployer key; never share it, never paste it to me
npx hardhat run scripts/deploy-vault.ts --network robinhood
```

Then, **before** trusting it, verify on-chain yourself:

```bash
# code exists, and the collection/treasury are what you intended
cast code   <VAULT_ADDR> --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call   <VAULT_ADDR> "collection()(address)" --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call   <VAULT_ADDR> "treasury()(address)"   --rpc-url https://rpc.mainnet.chain.robinhood.com
```

`collection()` must equal `0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156`.

**Bootstrap order matters** — getting it wrong strands the ETH permanently:
deposit NFTs first, then call `seedShares{value: ...}(shares)`. `seedLiquidity()`
alone leaves the pool bricked on the share side with **no withdrawal path**.

**Then, and only then:** set `NEXT_PUBLIC_MARKET_VAULT_ADDRESS`, set
`NEXT_PUBLIC_MARKET_ENABLED=true`, deploy, and re-run the forgery probe against
production to confirm the signature gate is live there too — a wrong env var on
Vercel is the most likely way for this to regress silently.
