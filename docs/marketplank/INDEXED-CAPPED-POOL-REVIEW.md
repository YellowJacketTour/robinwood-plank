# Indexed capped survivor pool — review candidate

This is a separate, stateful implementation in `PlankScalableCrash.sol`. It is
not selected by the working preview or mainnet deploy script. Existing games
keep their existing settlement rules. A migration needs the new ABI, indexed
claims, bounded roster pagination, a claim-history recovery interface, and a
fresh deployment; do not point the existing browser at this contract silently.

## Exact clearing

Let a position have integer stake units `u_i = stake_i / 10,000 wei`, target
`t_i` in basis points and survivor floor `f` in basis points. Only `t_i <= crash`
survives. The contract rejects non-integral stake units. This quantum is a
precision restriction, not a dollar-denominated minimum: a 1e12-wei minimum
remains compatible. Transaction fees are separate from the stake.

Let `D = floor(totalStake * (10,000 - rakeBps) / 10,000)` and `H` be the
underwriting escrow fixed before the round's entropy. Available funding is
`B = D + H`. Define the monotone cost function

`C(x) = sum_survivors(u_i * min(t_i, x))`.

If `B >= C(crash)`, each survivor receives exactly `u_i * t_i` wei. Otherwise,
find the largest integer `x` for which `C(x) <= B`. The Fenwick index supplies
prefix stake units `U(x)` and prefix caps `P(x)`. The cost query is
`P(x) + x * (U(crash) - U(x))`. With

`alpha = (B - P(x)) / (U(crash) - U(x))`,

positions at targets at most `x` receive their exact caps, and other survivors
receive `floor(u_i * alpha)`. Binary search takes at most 27 cost queries over
the fixed target range. No position array is scanned at settlement.

The denominator cannot be zero in the underfunded branch: that would mean all
caps fit, contradicting the branch condition. All products fit uint256 under
the enforced aggregate stake and underwriting bounds, each at most 1e33 wei.
The packed index fields bound units by 1e29 and weighted caps by 1e37, both
below uint128 maximum. Individual admitted stakes also retain the uint96 cap.

## Safety statements and their limits

* **Solvency:** summed entitlements never exceed `B`. The entire allocated
  amount stays in claim escrow, excluded from the next round's seed and all
  other withdrawals. Claims move value from this escrow to the owner's pull
  ledger. Anyone may trigger a claim; only its owner controls withdrawal.
* **Funded floor:** configuration enforces `f <= 10,000 - maximumRakeBps`.
  Because stakes are integral units, survivor floors are exact and affordable
  from `D` even when every position survives. A survivor floor is not a refund
  guarantee for positions whose targets exceed the crash.
* **Full-X ceiling:** every payout is at most `stake * target / 10,000`.
  A tiny survivor cannot capture the whole crash pool simply by being alone.
  The separately priced lottery can award a large jackpot to a small stake.
* **Split resistance:** splitting a fixed amount at the same target leaves
  `C(x)`, the clearing point and other players' entitlements unchanged.
  `sum floor(u_j * alpha) <= floor(sum(u_j) * alpha)`, so address splitting
  cannot increase that amount's payout. Changing targets is a different
  portfolio, not the same strategy split across identities.
* **Dust:** underfunded division dust is less than one wei per uncapped
  survivor. It remains reserved until all surviving units have claimed; then
  it returns to the buffer. Abandoned claims do not expire or become seed.
  Same-target Sybils can increase this tiny locked residue, but cannot take it.
* **Protected principal:** underwriting excludes protected principal and is
  clamped by buffer fraction, income budget and immutable maximum underwriting.
  A separate aggregate round-stake cap applies before accepting any funds.
  The spendable buffer and lottery jackpot are not themselves guaranteed to
  increase after every payout. Protected principal and jackpot must not be
  conflated in displays or economic claims.
* **Lottery ticket weights:** each accepted stake appends a cumulative ticket
  endpoint. A binary search finds the interval containing the existing
  stake-weighted ticket. Address count grants no extra tickets. Hash-modulo
  reduction retains the existing negligible bias; it is not claimed to be
  exactly unbiased rejection sampling.

Neither rake nor iteration creates new value. Future players can receive
subsidized full-X payouts from retained prior income, but aggregate withdrawals
and retained balances cannot exceed stakes plus external income. Profitable
funded opportunities are available to bots as well as humans; budgeted exposure
is the defense, not wallet rank or a promise to distinguish good players from
adversaries. Different-target diversification and strategic entry timing remain
valid strategies to examine, not an assertion of universal negative attacker EV.

## Cost and operational limits

Admissions require logarithmic index updates and permanent per-position
storage. Claims are independent and constant cost, apart from normal chain gas
pricing. Lottery ticket selection needs at most 30 probes at the one-billion
seat arithmetic ceiling. That ceiling is **not** measured billion-user network
capacity. The scale tests mine positions individually inside an explicitly long
test betting window; they do not demonstrate fitting those transactions into a
30-second public round. Target-network throughput, fee affordability, RPC
indexing, frontend pagination and claim recovery still need deployment evidence.

No entropy operator or off-chain settlement root is introduced. drand threshold
honesty, chain timestamp/finality assumptions and at least one available relayer
remain external assumptions. The inherited timeout escape must be reviewed
against withheld relays, censorship and outcome-selective refunds. The copied
lottery failure and gas-starvation behavior needs review against this new gas
profile; a proof for the older scanning contract is not automatically a proof
for this one. Storage is deliberately append-only and will grow with usage.

## Reproduction and release evidence

1. `npm ci`; `npx hardhat compile --force`.
2. `npm run lint:inmotion`; `npx tsc --noEmit`; `npm test`; `npm run build`.
3. The deterministic contract suite covers quantization, exposure limits,
   actual 256/1,024/4,096-position settlement, delayed claims, exact refunds,
   dust, protected principal, split wallets and independent clearing across
   200 books at four crash boundaries each.
4. Set `PLANK_REAL_BEACON=1` and optionally `PLANK_REAL_BEACON_OUTPUT`, then run
   `npx hardhat test test/contracts/PlankScalableCrash.real-beacon.test.ts`.
   This waits for real future drand rounds and verifies their public signatures
   through the actual on-chain verifier on a **local EVM**. It is not a
   public-testnet soak. Network failures fail this opt-in test.
5. `npx tsx scripts/plankcrash-release-snapshot.ts --out=<new-path>` binds current
   source, compiler inputs, ABI and runtime templates. It rejects stale sources
   in build information and mismatched artifact output. Constructor immutables
   are additionally checked against deployment configuration in review.

Official drand references: [network selection](https://docs.drand.love/developer/),
[HTTP API](https://docs.drand.love/developer/API-v1/drand-http-api/), and
[protocol specification](https://docs.drand.love/docs/specification/).

### Public testnet and launch

The existing `config/plankcrash-testnet-canary.json` identifies a permissionless
test mock. It cannot satisfy the real-beacon gate. Obtain a funded, reviewed
testnet deployment using `DrandBeacon` with evmnet's pinned key, domain,
genesis and period. No mainnet deployment is part of this work.

Run real rolling play for at least 24 hours and 100 settled rounds. Exercise
withdrawal, refund, reconnect, relay outage and congestion drills and retain
their actual transaction/operational evidence. A reviewer supplies a JSON
incident report with a `drills` object containing those five boolean keys.
These flags are attestations supported by that report, not facts a settlement
log alone can prove. Confirmations checked by the collector are 20 L2 blocks;
this does not substitute for a separate L1 settlement/finality analysis.

Then run `npx tsx scripts/plankcrash-real-beacon-soak.ts` with:

* `PLANKCRASH_TESTNET_RPC_URL`: public testnet RPC, chain ID 46630.
* `PLANKCRASH_SOAK_CRASH`, `PLANKCRASH_SOAK_CONTRACT`: exact deployed address
  and either `PlankCrash` or `PlankScalableCrash`.
* `PLANKCRASH_SOAK_FROM_BLOCK`: start of the recorded run.
* `PLANKCRASH_INCIDENT_DRILL_REPORT_PATH`: the actual drill report.
* `PLANKCRASH_EVIDENCE_SIGNING_KEY`: dedicated evidence-signing key, supplied
  securely; never copied into this repository or any artifact.
* `CANARY_EXPECTED_SIGNER`: independently pinned signer address.
* `PLANKCRASH_REAL_BEACON_SOAK_PATH`: a new output file.

The collector is read-only on-chain. It rejects mock runtime code, fetches
canonical receipts, checks real beacon parameters and signs the resulting
coverage report. It does not manufacture play or drills.

The mainnet gate additionally requires `PLANKCRASH_RELEASE_CONFIG_PATH` to
equal `deploymentOverrides()` from `scripts/lib/plankcrash-release-binding.ts`,
which captures only public inputs actually consumed by the deployment script.
Source fingerprints bind defaults as well as overridden inputs. An independent
review binding at `PLANKCRASH_REVIEW_BINDING_PATH` must have schema
`plankcrash.review-binding.v1`, the exact `sourceFingerprint`,
`configFingerprint`, and unprefixed `contractAuditSha256` / `mathReviewSha256`
digests of the supplied review documents. The existing contract review, math
review, legal, incident and bounty requirements remain. The gate re-queries
the public network rather than accepting signed receipt strings alone.

The deployment remains blocked until these artifacts exist and match. The
indexed candidate also needs browser/keeper claim integration and a release
selection decision before replacing the current scanning contract. Limited
exposure must be enforced in the deployed contract, not only a frontend limit.
