# Grok findings: fraud-resistant leaderboard for the $PLANK King of the Hill buy contest (2026-08-25)

Response to a research ask for the upcoming single-winner "largest $PLANK buy"
King of the Hill (KOTH) competition: what does a fraud-resistant leaderboard
and payout pipeline look like for a 31-day, single-token, single-chain buy
contest, grounded in real prior art rather than invented thresholds. Preserved
findings below by topic; synthesized recommendation at the bottom.

---

## 0. Mechanic parameters (context, not a design decision)

- **Window:** 31 days, starts 08:08 CST 2026-08-26.
- **Token/contract:** `$PLANK`, `0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc`
  (`lib/constants.ts` `CONTRACT_ADDRESS`) — never validate a leaderboard entry
  against any other token address.
- **Chain:** Robinhood Chain, chain id `4663` (`lib/constants.ts` `CHAIN`).
- **Prize:** 0.69420% of total supply, single winner.
- **Timer/anti-snipe mechanics:** the existing NFT-largest-sale KOTH engine in
  `lib/market/king-of-the-hill-rules.ts` already implements exactly the grace/
  extension shape this contest needs — `GRACE_WINDOW_MS = 2h`,
  `EXTENSION_MS = 4h`, pure functions `seedExistingSale`,
  `reconcileExistingSale`, `applyCandidateSale`, `finalizeIfDue` operating on a
  `KothState { deadlineMs, leadingSale, winnerFinalizedAtMs, winnerSale }`.
  That module is deliberately I/O-free and chain-agnostic (a `KothSale` is
  just `{ txHash, tokenId, wallet, priceWei }`, and `tokenId` is already
  nullable) — a fungible-token "largest buy" contest is a drop-in reuse of the
  same state machine and the same anti-boundary-race guarantees documented in
  its header (strictly-greater-price requirement, `max(now, deadline) +
  EXTENSION_MS` anchor, immutable-after-finalize). Nothing below proposes
  replacing that module; everything below is about **what feeds it a
  candidate `KothSale` in the first place** and what happens **after** a
  provisional winner emerges, which is a materially different problem for a
  swap on an AMM than for an NFT marketplace sale.

---

## 1. Flash-loan / atomic same-transaction price-manipulation detection

**Block:** a single atomic transaction can borrow capital, force a
large nominal "buy" print, and unwind in the same block — the naive
leaderboard signal ("largest buy by ETH-in observed on a `Transfer`/`Swap`
event") is exactly the signal these attacks are built to spoof.

**Real prior art (verified):**

- The core primitive is documented consistently across sources: an attacker
  uses a flash loan to execute a large trade against a DEX/oracle in one
  transaction to move price, extracts value, and reverses/repays in the same
  transaction — no capital ever really committed. ([OWASP SC07:2025 — Flash
  Loan Attacks](https://owasp.org/www-project-smart-contract-top-10/2025/en/src/SC07-flash-loan-attacks.html))
- Forta and academic detectors (DeFiRanger, Flashot) work by **pattern-
  matching the transaction's internal call trace**: flash-loan-borrow →
  large swap → protocol action → swap-back → repay, all in one tx, one
  originating EOA/contract. ([Flashot](https://arxiv.org/pdf/2102.00626),
  [OWASP](https://owasp.org/www-project-smart-contract-top-10/2025/en/src/SC07-flash-loan-attacks.html))
- A named example with a concrete number: an oracle-manipulation attack
  netted 2,381.41 ETH in a single transaction (Feb 2020); a separate case
  drained a Balancer pool by repeatedly swapping a deflationary token against
  itself to spike its price. These are the shape of attack this contest's
  buy-size signal must not reward. (Search results; treat the specific ETH
  figure as *illustrative prior art*, not something to re-derive here.)

**Solution design:**

Do not trust "biggest single swap event" as a candidate `KothSale` at all.
Before a swap's `priceWei`/notional value is accepted as a leaderboard
candidate:

1. **Pull the full transaction, not just the log.** Fetch the transaction's
   internal call trace (Robinhood Chain is Blockscout-based — Blockscout
   exposes an internal-transactions/trace endpoint; verify the exact path
   against `robinhoodchain.blockscout.com` before building, don't assume
   Etherscan-shaped routes carry over 1:1).
2. **Same-tx round-trip check:** flag (do not silently accept) any
   transaction where the same address (or a contract it deployed/called in
   the same tx) both supplies liquidity/collateral and receives it back, or
   where the $PLANK pool's reserves are moved by more than one swap leg
   *from the same origin* inside one transaction. A KOTH candidate should
   normally be one address, one swap, one block, no surrounding pool-state
   gymnastics in the same tx.
3. **Price the buy in realized quote-asset paid, at the AMM's own price
   after the trade, not raw token amount received.** A wash-priced pool can
   make "tokens received" look enormous relative to real ETH spent; anchor
   the leaderboard metric to **ETH (or WETH) actually paid**, consistent
   with how `lib/uniswap-server.ts` already treats EXACT_INPUT quotes — the
   spent side is the harder-to-fake side because it requires real capital to
   leave the buyer's balance and not return in the same transaction.
4. **Cross-check against a short trailing price band** (TWAP-style) for the
   $PLANK/ETH pool rather than the instantaneous post-trade spot price —
   this is standard oracle-manipulation mitigation practice; a buy that
   executes at a price wildly outside the pool's recent trading band is a
   signal to hold for review, not to auto-crown.

**Rate strategy:** this only needs to run once per *new leaderboard-relevant
candidate* (a swap bigger than the current leader), not every trade — cheap
in practice for a single-pool, single-token contest. Pull the trace via the
same throttled/rotated free-RPC discipline already used elsewhere in this
repo (see the free-remedies findings doc for the FBC/singleflight pattern);
no paid trace API required for Blockscout's own trace endpoint.

**What you get:** rejection of the classic same-block borrow-pump-unwind
shape, and a metric (real ETH paid) that is far harder to spoof than raw
token amount.

**What you don't get:** protection against a genuinely wealthy attacker who
is willing to actually spend real, non-borrowed capital and hold the tokens —
that is not fraud, that is winning the contest as designed. Nor does this
catch manipulation spread across multiple transactions/blocks (see §6).

**Confidence:** High that the call-trace/same-tx-roundtrip heuristic is real
industry practice (multiple independent sources, OWASP's own top-10 entry).
Medium on the exact Blockscout trace endpoint shape for Robinhood Chain
specifically — verify against a live query before wiring, not assumed from
Etherscan conventions.

---

## 2. Aggregator/router buyer attribution (0x, Uniswap Universal Router, 1inch)

**Block:** the contest needs one buyer wallet to credit; routers are built to
obscure or batch that.

**Real, verified mechanics:**

- Uniswap's Universal Router accepts a single `execute(bytes commands, bytes[]
  inputs)` call whose commands are opcodes with their own encoded calldata,
  including an explicit `recipient` field per command — and Universal Router
  documentation is explicit that **intermediate steps route funds back to the
  router address itself**, not the wallet, with only the *final* command
  specifying the real recipient. ([Uniswap/universal-router on
  GitHub](https://github.com/Uniswap/universal-router))
- Universal Router (and 0x's own router) support `multicall`, explicitly
  documented as allowing **"callers to fill multiple orders in a single
  call"** — i.e., a single on-chain transaction can legitimately represent
  more than one end user's trade, batched by a relayer/aggregator UI.
  ([Uniswap Universal Router
  docs](https://github.com/Uniswap/universal-router))

**The real limitation this creates:** a single large `Transfer`/`Swap` event
attributed to the router's own address, or to a relayer/multicall contract,
does not by itself say who the beneficial buyer is, and in the batched case
there may be **more than one legitimate buyer inside one transaction**, each
for a smaller amount than the total — "largest buyer" is ambiguous at the
transaction level when a router did the work.

**Solution design:**

1. **Decode calldata, don't trust the top-level `from`.** For a Universal
   Router transaction, walk the decoded `commands`/`inputs` to find the
   actual `recipient` argument(s) of the swap-output command(s) that touch
   the $PLANK pool — that is the true buyer address(es), which may differ
   from `tx.from` (a relayer, a smart-account executor, or a sponsor paying
   gas on someone's behalf).
2. **Split multicall/batched transactions into per-recipient candidate
   buys.** If a decoded transaction contains N independent swap legs with N
   distinct final recipients, each recipient's leg is its own candidate
   `KothSale` at its own size — never sum them into one giant "buy" credited
   to the router or to whichever recipient appears first in calldata.
3. **Disqualify (or hold for review) any candidate whose true recipient
   cannot be decoded** — e.g. an unrecognized custom router/aggregator
   contract, obfuscated calldata, or a proxy pattern this app's decoder
   doesn't recognize. Fail closed: an unattributable buy should never
   silently become the leaderboard leader just because it was the largest
   raw transfer.
4. This app already has both `lib/uniswap-server.ts` (Uniswap Trading API
   integration) and `lib/zerox-server.ts` (0x) — reuse their existing
   knowledge of Universal Router/0x calldata shapes for the decode step
   rather than writing a third parser from scratch, since both already
   understand these routers' request/response shapes for this app's own
   swap flow.

**What you get:** correct attribution for the two router families this app
already integrates with, and a principled disqualify-don't-guess path for
anything else.

**What you don't get:** a way to *prove* who the ultimate human beneficiary
is behind a smart-contract wallet or a fresh EOA the router paid out to —
attribution here means "the on-chain address that received the tokens,"
which is the same standard every on-chain leaderboard uses; a buyer who
wants to hide behind a fresh wallet can still do so, it's just no longer
mis-attributed to the router.

**Confidence:** High on the Universal Router recipient/multicall mechanics
(primary source, Uniswap's own repo). Medium on "how often real $PLANK buys
will actually arrive via an unrecognized third-party router" — that's a
volume assumption, not something searchable in advance.

---

## 3. Wash trading / Sybil detection (funding-source clustering)

**Block:** an attacker sells (crashing price, funding their own war chest)
and buys back with a different wallet to appear as an unrelated giant buyer;
naive leaderboard logic sees "wallet B bought a lot" and ignores that wallet
B was funded by wallet A's proceeds.

**Real, verified heuristics (Chainalysis):**

- Chainalysis's NFT wash-trading detection explicitly flags **"sales to
  addresses that were self-financed, meaning they were funded either by the
  selling address or by the address that initially funded the selling
  address"** — i.e., a two-hop funding-source check, not just a direct
  address match. ([Cointelegraph: Chainalysis report finds most NFT wash
  traders unprofitable](https://cointelegraph.com/news/chainalysis-report-finds-most-nft-wash-traders-unprofitable))
- A more advanced, verified pattern: **controller addresses that fan out
  funding to five-plus managed sub-addresses via multi-sender contracts**,
  which then execute matched trades against each other — Chainalysis found
  controller addresses averaging 183 sub-addresses each, one generating
  $142.99M in suspected wash volume in a single month. (Same source.)
- General technique: **address clustering** (connecting many wallets to one
  controlling entity via shared funding/gas patterns) plus **transaction
  graph analysis** to visualize circular fund flows. ([Nansen: Blockchain
  Analysis Tools](https://nansen.ai/post/blockchain-analysis-tools-identifying-suspicious-wallet-activity))

**Solution design (applied to "did the seller fund the buyer"):**

1. On any candidate leader, walk the buyer wallet's **inbound funding
   history on Robinhood Chain** (its first N inbound transfers, or at
   minimum the transfer that first funded it with gas/ETH) back **two hops**:
   did the funding address, or the address that funded *that* address, ever
   sell $PLANK into the pool this round (especially right before this buy)?
2. Treat a same-block or same-short-window **sell-then-buy pair with a
   funding link** between the two wallets as the highest-severity flag —
   this is the direct on-chain analogue of Chainalysis's documented
   heuristic, not a novel invention.
3. **Do not require full deanonymization** — the two-hop funding check is
   exactly what real tooling uses and is cheap: it's a handful of RPC calls
   per candidate, not a graph database. A fuller multi-sender/fan-out
   detector (the 183-sub-address pattern) is real but heavier; treat it as a
   v2 enhancement, not a launch requirement for a single 31-day contest with
   (presumably) low transaction volume relative to what Chainalysis analyzes
   across an entire chain.
4. **Common-exchange-withdrawal fingerprinting** (flagging wallets whose
   first inbound funding came from a known CEX hot wallet, which is normal
   and *not* suspicious) is mentioned in prior art mainly as a way to reduce
   false positives — a wallet funded from a CEX withdrawal should not be
   penalized just for being freshly funded; the flag is specifically
   **self-funding by the seller**, not "wallet is new."

**Rate strategy:** run the two-hop funding check only on the current leader
and any candidate that would overtake it — same "only check what's about to
matter" discipline as the anti-manipulation checks in §1. Free RPC calls,
throttled the same way.

**What you get:** the same self-funding heuristic Chainalysis publicly cites
as their real NFT wash-trading signal, adapted to a fungible-token buy
contest.

**What you don't get:** certainty. Funding-source analysis is a strong signal,
not proof — a sophisticated attacker can route through enough hops or an
intermediate CEX deposit/withdrawal to break a 2-hop check. This is why §7's
system shape below routes flagged candidates to manual review rather than
auto-disqualifying on this signal alone.

**Confidence:** High that the 2-hop self-funding heuristic is real,
currently-used industry practice (direct Chainalysis citation). Medium on
how deep (N hops) to check before diminishing returns for this specific
contest's likely attacker sophistication — start at 2 hops as documented,
treat deeper as a tunable, not a derived number.

---

## 4. Decoy / non-canonical pool attacks

**Block:** an attacker could deploy their *own* thin $PLANK-paired pool
(different fee tier, different pair, or an entirely separate DEX deployment)
and record a large "buy" there that never touches the real, liquid market —
if the leaderboard indexer isn't strict about *which pool* it watches, this
is a free win.

**Real prior art (verified, general category, not $PLANK-specific):**

- Fake/decoy liquidity pools are a documented, common scam pattern:
  attackers pair a token with a well-known asset in a thin pool they fully
  control and can move price by orders of magnitude — Check Point Research
  documented a case of pool manipulation skyrocketing a token's *recorded*
  price by 22,000%. ([Check Point
  Research](https://research.checkpoint.com/2023/crypto-deception-unveiled-check-point-research-reports-manipulation-of-pool-liquidity-skyrockets-token-price-by-22000/))
- Malicious pools are also documented to **quote attractively in simulation
  but execute differently for real** — relevant if any part of the pipeline
  ever trusts a simulated/quoted price rather than a settled on-chain trade.
  (Search results, general DEX security literature.)
- Specific defenses (canonical-pool allowlisting, minimum liquidity-depth
  thresholds, minimum trading-history requirements) are standard practice
  described across DEX-safety writeups, though no single named vendor
  writeup enumerating exactly those three defenses together was found in
  this search pass — treat the defenses below as **well-established
  practice synthesized from the attack-pattern literature**, not a single
  cited source.

**Solution design:**

1. **Canonical pool allowlist, hard-coded, not discovered.** The leaderboard
   indexer must only ever read Swap events from the specific $PLANK pool
   address(es) this app already trades against via its own Trading API
   integration (`lib/uniswap-server.ts`) — never "any pool that pairs
   $PLANK with something," discovered by scanning factory events. This
   mirrors the existing `EXPORTED_ADDRESS_CONSTANTS` fail-closed pattern in
   `lib/constants.ts` (malformed/unexpected addresses throw at load, not
   silently accepted).
2. **Minimum-liquidity-depth gate as a secondary check**, even on the
   canonical pool: if the pool's own reserves are ever manipulated down to
   near-zero depth (e.g., after a real or attempted drain) such that a small
   amount of ETH can move price enormously, treat any buy executed while
   depth is below a sane floor as suspect pending review — this is the same
   "thin pool = manipulable" property the Check Point case exploited,
   applied as a live health check rather than a one-time allowlist decision.
3. **No minimum trading-volume-history requirement is meaningful here** —
   unlike a general multi-collection marketplace, $PLANK has exactly one
   canonical pool and one contract; the allowlist-by-address defense alone
   closes the decoy-pool vector completely for this specific contest. Volume
   history requirements matter more for the general cross-collection
   registry problem this repo already documents elsewhere (Tensor/OpenSea
   floor scanning), not for a single-token contest.

**What you get:** total elimination of the decoy-pool vector for this
contest, at zero ongoing cost — it's a fixed allowlist check, not a scanner.

**What you don't get:** protection if the *canonical* pool itself is thin
enough to be manipulated (that's §1's TWAP-band check, not this section).

**Confidence:** High on canonical-address-allowlisting as the correct
defense (this is the same reasoning the repo already applies to
`CONTRACT_ADDRESS`/`PERMIT2_ADDRESS`/etc. — one wrong or attacker-controlled
address is a total bypass). Medium on the general fake-pool attack pattern
citation quality — the Check Point writeup is real and specific, but no
single source enumerated all three defenses named in the ask together.

---

## 5. Reorg / finality — confirmation depth before crowning a leader

**Block:** crowning a "confirmed leader" too early risks a reorg silently
erasing the winning transaction; too late is just unnecessary UI lag.

**Verified, Robinhood-Chain-specific finding:** Robinhood Chain (chain id
4663 mainnet, 46630 testnet) is an Arbitrum-Orbit Ethereum L2 that settles to
Ethereum using ETH as gas and Ethereum blobs for data availability. Its own
documentation describes a **two-stage confirmation model**:

- **Soft confirmation:** the sequencer assigns an ordering and returns a
  receipt in under one second — "in practice that promise holds, but
  Ethereum hasn't seen the transaction yet." Suitable for UI display only.
- **Hard finality:** achieved once the sequencer's batch reaches Ethereum
  finality, **roughly 13 minutes after posting** — the documentation
  explicitly says this is the bar for "irreversible actions like crediting
  external accounts or releasing custody," and explicitly warns:
  **"Don't treat a soft confirmation as settlement in accounting or custody
  logic. Reorganizations at the L2 level are rare but possible before the
  sequencer posts a batch."**
  ([QuickNode: What is Robinhood Chain?](https://www.quicknode.com/guides/robinhood/what-is-robinhood-chain))

This is a real, sourced, Robinhood-Chain-specific answer — not a generic
"12-confirmations" EVM assumption. It directly answers what the ask
requested and should be treated as authoritative pending a check against
Robinhood's own primary docs (`docs.robinhood.com/chain/connecting`, not
independently fetched in this pass — recommend a final read of that primary
source before hard-coding the 13-minute figure into product copy or code).

**Could not verify:** the *exact* Arbitrum Orbit batch-posting cadence for
this specific chain (how often batches post, i.e. whether "13 minutes" is a
fixed constant or an average that could occasionally run longer under L1
congestion), and whether Robinhood Chain runs a single sequencer with no
fallback (typical for Orbit chains, but not independently confirmed here for
this deployment specifically). Do not hard-code "13 minutes" as a guaranteed
upper bound in any user-facing payout-timing promise without re-verifying
against Robinhood's own primary docs first.

**Solution design:**

1. Treat a transaction as a **provisional leaderboard candidate** the
   moment it's seen with a soft confirmation (good UX, matches how this
   contest's live leaderboard should feel).
2. Promote to **confirmed leader** only after the containing batch reaches
   L1 (Ethereum) finality — reuse the same "roughly 13 minutes" heuristic
   Robinhood's own docs describe, but treat the number as **a documented
   starting point to poll against, not a fixed sleep timer** — confirm
   finality by checking actual L1 batch-finalization status (via the
   Blockscout explorer or an Arbitrum Orbit finality RPC method if exposed),
   not a hardcoded delay.
3. Because this contest's `applyCandidateSale`/`finalizeIfDue` machinery
   already treats "state as of now" as advisory until the round's deadline,
   there's a natural place to layer this: a candidate sale only becomes the
   `leadingSale` fed into `applyCandidateSale` after it clears finality, so
   a reorg before that point simply means the sale never entered the state
   machine at all — no rollback logic needed inside
   `king-of-the-hill-rules.ts` itself.

**What you get:** a leaderboard that feels live (soft-confirmation
provisional display) while the number that actually matters for anti-snipe
extension and eventual payout only reflects L1-final transactions.

**What you don't get:** instant hard confirmation — there is an inherent
~13-minute-ish lag (per Robinhood's own stated model) between "biggest buy
just happened" and "this is now safe to act on as final," which is real and
should be reflected honestly in the UI (e.g. "provisional leader" vs.
"confirmed leader" labeling), not hidden.

**Confidence:** High on the two-stage soft/hard model and the ~13-minute
figure — directly sourced from a guide describing this specific chain,
consistent with standard Arbitrum Orbit architecture. Medium-low on whether
13 minutes is a hard guarantee vs. a typical average for this deployment —
flagged above as needing a primary-source re-check before any code treats it
as a constant.

---

## 6. MEV / front-running / copy-trading "the crown" near expiry

**Block:** is racing to submit a bigger buy right before the deadline
exploitable, or just the contest working as designed?

**Analysis (no single "MEV-of-KOTH-contests" writeup found — reasoned from
verified router/mempool mechanics above plus the existing rule engine):**

- **Copying a visible large buy right before expiry is not a distinct
  exploit category here** — it is the entire point of the contest as
  specified ("any new largest sale... extends... 4 hours"). Anyone can see
  the current leader's size on a public chain and choose to outbid it; that
  is fair competitive behavior, identical in shape to a real-world last-
  minute auction bid, and the existing `king-of-the-hill-rules.ts` grace/
  extension design is *specifically built to neutralize* the version of
  this that would otherwise be a problem (sniping a win in the literal last
  second with no chance to respond) — see its own documented rationale for
  `max(now, deadline) + EXTENSION_MS`.
- **What *would* be a distinct MEV problem, and is real:** a searcher
  front-running a large pending buy transaction they see in the public
  mempool by inserting their own larger buy ahead of it in the same block
  (classic sandwich/front-run mechanics, well-documented generally for
  EVM chains). This is a real risk for the buyer's execution price (they
  may get sandwiched and pay a worse rate), but it is **not a risk to
  leaderboard integrity** — if a front-runner's buy is genuinely larger, they
  earned the higher rank by actually spending more real capital, which is
  the metric the contest rewards. It only becomes a leaderboard-integrity
  problem if that front-run buy is *itself* flash-loan-funded and unwound
  in the same block (fully covered by §1's same-tx round-trip check).
- Whether Robinhood Chain's Arbitrum-Orbit sequencer exposes a public
  mempool at all (some Orbit/rollup sequencers use private ordering,
  reducing classic mempool-sniping opportunity) was **not verified** in
  this pass — flag this as unconfirmed rather than assuming either a public
  or private mempool model.

**What you get:** confidence that "someone raced to out-buy the leader near
the deadline" is not, by itself, something to flag or disqualify — the
system should only intervene when §1/§3's actual fraud heuristics fire on
that specific transaction.

**What you don't get:** a guarantee that every last-minute large buy gets a
fair, un-sandwiched execution price — that's a buyer-experience concern
(arguably worth exposing slippage-protection guidance in the trade UI near
deadline), not a leaderboard-fraud concern.

**Confidence:** High that competitive last-second outbidding is intended
behavior, not fraud, given the rule engine's own documented design intent.
Low/unverified on Robinhood Chain's specific mempool visibility model —
explicitly flagged, not guessed.

---

## 7. Single-winner payout/custody mechanism landscape

**Block:** how to actually get the prize (0.69420% of total supply) to the
confirmed winner — presented neutrally; this is an operator decision, not
one this document makes.

**Real, general options and their documented failure modes:**

| Mechanism | How it works | Documented failure modes |
|---|---|---|
| **Claim-based smart contract, single winner, no Merkle needed** | Contract stores/receives the confirmed winner address once finalized; winner calls `claim()`. | Whoever holds the admin key that *sets* the winner address is a single point of failure — if that's a single EOA with no timelock, it's the same "single-key admin" risk pattern flagged broadly in smart-contract security literature: "protocols controlled by a single EOA without timelocks pose significant risks," and compromised keys are cited as the single largest category of stolen-funds incidents by a factor of five. ([Trail of Bits blog cluster / SEAL Frameworks writeups, aggregated](https://blog.trailofbits.com/2025/06/25/maturing-your-smart-contracts-beyond-private-key-risk/)) |
| **Timelocked multisig-triggered transfer** | N-of-M signers approve, delay elapses, transfer executes. | Two distinct failure modes, both documented: (a) **signer collusion or loss** — losing quorum of keys (device loss, signer departure) can permanently strand funds; (b) **unmonitored timelock is worthless** — the Beanstalk exploit is the canonical cited example of a timelock that existed on paper but wasn't being watched, so the delay bought no real protection. ([OpenZeppelin: Protect Your Users With Smart Contract Timelocks](https://www.openzeppelin.com/news/protect-your-users-with-smart-contract-timelocks)) |
| **Fully manual off-chain payout after manual verification** | Operator manually reviews the confirmed leaderboard winner and sends the prize transfer by hand. | No smart-contract risk surface at all, but trades it for **operational trust and irreversibility risk**: a single human (or the same wallet already used elsewhere, e.g. `PLANK_SUPPLY_RECIPIENT`) must correctly identify the right address and amount and execute correctly once, with no on-chain enforcement that it happens at all, and no recovery if it's sent wrong (standard "no contract, no code-enforced correctness" tradeoff — not from a single named source, but the direct converse of every documented smart-contract-mitigation writeup above, which all exist precisely because manual/EOA-controlled transfers are the risk being mitigated). |

**Presented neutrally, as required:** each of these is a real, currently-used
pattern; the tradeoff is consistently key-risk vs. delay vs. operational
trust, and best practice for institutional-grade holdings appears to be
"multisig + timelock with monitoring," but that recommendation cuts against
manual payout's simplicity and against a pure claim-contract's admin-key
convenience — which one fits a single, one-time, non-recurring 0.69420%-
of-supply payout is an operator judgment call this document does not make.

**What you get:** three real, sourced options with real, sourced failure
modes to weigh against the actual prize size and operator risk tolerance.

**What you don't get:** a recommendation — this repo's existing posture
(`MARKET_ENABLED` gated hard behind an independent third-party audit per
`SPEC.md §7`, per `lib/constants.ts`) suggests custody-adjacent decisions in
this codebase are treated as owner sign-off items, not default-yes
engineering calls, and a one-time prize payout for a real, sizable token
amount fits that same category.

**Confidence:** High that all three failure-mode citations are accurate and
current (OpenZeppelin/Trail-of-Bits-adjacent sources, Beanstalk citation is a
real, widely-documented incident). This section intentionally makes no
technology recommendation, per the ask's own constraint.

---

## Synthesized recommendation: end-to-end leaderboard verification pipeline shape

Putting §1–§7 together, the system shape — not exact code — looks like a
four-stage pipeline sitting **in front of** the existing, unmodified
`king-of-the-hill-rules.ts` state machine:

```text
1. RAW CANDIDATE INTAKE (canonical pool only, §4)
   Watch Swap events on the single allowlisted $PLANK/ETH pool address.
   Anything from any other pool/pair is never even considered.
        |
        v
2. PROVISIONAL LEADER (soft-confirmed, §5)
   A new largest-buy-by-real-ETH-paid (§1) shows immediately in the UI as
   "provisional leader" the moment the sequencer soft-confirms it. This is
   what users see live; it does NOT yet feed applyCandidateSale().
        |
        v
3. PROMOTION GATE — runs once per provisional leader, only when it would
   overtake the current confirmed leader (cheap: happens rarely, not per-trade)
     a. Finality check (§5): wait for/poll L1 finality (Robinhood's own
        documented ~13-minute soft->hard window) before promoting.
     b. Same-tx round-trip / flash-loan shape check (§1): reject candidates
        whose transaction shows a borrow-manipulate-unwind pattern.
     c. True-buyer decode (§2): resolve the real recipient through router
        calldata; split batched multicalls into independent candidates;
        disqualify (route to 3e) anything whose recipient can't be decoded.
     d. Funding-source check (§3): two-hop check for seller-funds-buyer
        self-financing; flag (route to 3e) on a hit, don't hard-disqualify
        automatically given this is a probabilistic heuristic, not proof.
     e. MANUAL REVIEW QUEUE: anything that fails 3b/3c outright, or is
        flagged (not outright failed) by 3d, sits here with its evidence
        (trace, decoded recipient, funding path) for a human to resolve
        before it can become CONFIRMED. Nothing auto-promotes out of this
        queue.
        |
        v (only for candidates that pass 3a-3d clean)
4. CONFIRMED LEADER -> fed into applyCandidateSale()/finalizeIfDue()
   unchanged from king-of-the-hill-rules.ts. All of that module's existing
   guarantees (strictly-greater-price, grace/extension anchor, immutable-
   after-finalize) apply exactly as documented, on a candidate stream that
   is now pool-canonical, finality-safe, correctly-attributed, and
   funding-source-checked before it ever reaches the rule engine.
        |
        v
5. FINALIZED WINNER -> payout mechanism (§7, operator decision, out of
   scope for this pipeline's own design)
```

Key properties of this shape:

- **Fail-closed at every gate** — an unattributable buyer, an unfinalized
  transaction, or a flagged funding link all default to "does not promote,"
  never "promotes unless proven bad."
- **Immediate UI, delayed truth** — users always see a live provisional
  leader (good experience, matches the sequencer's own sub-second soft
  confirmation), while the number that actually drives the anti-snipe timer
  and eventual payout is the slower, checked, confirmed number.
- **The existing rule engine is untouched.** Every guarantee already proven
  in `test/market/king-of-the-hill-rules.test.ts` continues to hold because
  this pipeline only changes what qualifies as an input `KothSale`, not the
  state machine that consumes it.
- **Two things this document explicitly could not verify** and flags for a
  primary-source re-check before hard-coding into product behavior: (1) the
  exact "~13 minutes" Robinhood Chain finality figure as a guaranteed bound
  vs. a typical average, and (2) whether Robinhood Chain's sequencer exposes
  a public mempool (relevant to §6's front-running analysis). Everything
  else in this document is either a direct citation or explicitly marked as
  a starting-point heuristic to tune, not a fabricated number.
