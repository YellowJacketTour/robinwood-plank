# Orange Draw and Powerboard voucher design — 2026-08-30

## Decision

Plank should not clone Powerball's 5-of-69 plus 1-of-26 product. That matrix is
excellent at manufacturing astronomical headline odds, but it introduces number
selection, duplicate combinations, tiered prizes, split jackpots, quick-picks,
and a large explanatory burden that conflict with Plank's automatic, proportional,
winner-take-all community voucher.

Plank's native object is the **Orange Draw**:

1. Every qualified crash seat creates an epoch-isolated voucher with linear
   weight equal to its qualified stake under the published rules hash.
2. At epoch close, all vouchers and their weights are frozen and committed.
3. A precommitted, future, verified randomness round produces two
   domain-separated draws.
4. The orange spins and opens to reveal one numbered core ball. A published
   `1..N` gate decides hit or rollover.
5. On a hit, a second unbiased draw selects one frozen voucher in direct
   proportion to weight. Its owner receives the entire displayed net prize.
6. On a miss, the displayed prize follows the precommitted rollover and
   monotonic-growth accounting. Presentation never manufactures a near miss.

The orange is the theater. The committed state transition is the game.

## Why linear weighted vouchers remain the defensible default

For voucher `i` with weight `w_i`, total epoch weight `W`, fruit-gate odds `N`,
and displayed net prize `J`:

```text
conditional share on hit      s_i = w_i / W
combined jackpot probability  p_i = (1 / N) * (w_i / W)
probability-weighted claim     v_i = J * p_i
```

Linear weight is wallet-splitting invariant: dividing one beneficial owner's
stake among any number of wallets leaves aggregate weight unchanged. A per-wallet
base ticket, cap, square root, or other concave wallet function creates a direct
Sybil reward unless the system has a credible personhood/beneficial-owner layer.
Ranks may constrain maximum stake as a risk policy, but must not secretly alter
lottery odds after the voucher is issued.

`v_i` is a probability-weighted prize claim, not cash, a guaranteed return, a
tradable appraisal, or total expected value of the crash wager. The interface
must use that full label.

## The voucher receipt

Before commitment, show the exact rule next to the wager:

```text
This qualified stake adds 10,000 Orange weight to epoch 14.
Current epoch total: 250,000. Current conditional share: 4.00%.
Fruit gate: 1 in 16. Current combined jackpot chance: 1 in 400.
Prize now sealed: 101,000 credits. Probability-weighted prize claim: 252 credits.
```

After commitment, the receipt must contain:

- versioned voucher ID and epoch;
- room/chain, round, owner, qualified weight, and rules hash;
- eligibility cutoff and preselected randomness network/round;
- current weight share and combined probability, explicitly marked dynamic
  until the epoch closes;
- final frozen `W`, canonical ordering/range proof, winning index, and proof URL
  after the draw;
- contribution provenance: how much that flight added to pending funding;
- net prize, founder fee already charged, reset reserve, and rollover rule.

The HUD should always answer four questions without opening a terms document:

1. **What do I own?** My epoch voucher weight and receipts.
2. **What is it competing against?** Total epoch weight and participant count.
3. **What can happen?** Exact gate odds, conditional share, and combined chance.
4. **What is payable?** Fully backed net prize and probability-weighted claim.

## Canonical unbiased draw

The mainnet envelope should commit before eligibility closes:

```text
rulesHash, chainId, contract, epoch, closeTime,
randomnessNetworkHash, targetRound, voucherRoot, totalWeight W, gate N
```

Derive separate streams:

```text
gateSeed   = H(beacon || "PLANK_ORANGE_GATE_V1" || envelope)
voucherSeed= H(beacon || "PLANK_ORANGE_VOUCHER_V1" || envelope)
```

Use rejection sampling for both bounded ranges. The laboratory's current
`N=16` gate is exactly unbiased when taking a 32-bit word modulo 16 because 16
divides `2^32`; a configurable non-power-of-two gate must not reuse that shortcut.
The voucher selector already rejects the incomplete high range before reducing
modulo `W`.

The voucher commitment should be an append-only Merkle or sum-tree root. A
sum tree supports a compact proof that the selected scalar lies in the winning
voucher's interval while preserving exact proportionality. Sequential epoch pots,
roots, and draws prevent later funding or reordered settlement from changing an
older entitlement.

## Three.js production scene

The first implementation is intentionally procedural and code-native, avoiding
an off-language casino prop:

- PBR orange peel with deterministic pores, pith faces, stem, and leaf;
- two peel hemispheres on independent pivots;
- internal ping-pong core with the authoritative number as a canvas texture;
- charge/spin, deceleration, peel split, core settle, outcome, and return acts;
- the animation reads the settled event and never chooses or delays the result;
- adaptive pixel ratio, one short-lived renderer, explicit texture/material/
  geometry disposal, mobile framing, and reduced-motion static reveal.

For an authored second generation, Blender should export one self-contained GLB
with named clips (`idle`, `charge`, `spin`, `split`, `land`, `celebrate`) and
logical nodes (`peel_L`, `peel_R`, `core`, `stem`, `leaf`). Three.js
`GLTFLoader` plus `AnimationMixer` is the supported runtime path. Meshopt/Draco
geometry compression, KTX2 textures, instancing for repeated balls, and a strict
mobile performance budget should be CI gates. Physics may add secondary motion,
but the final number and landing pose must be timeline-authored from authoritative
state rather than determined by client physics.

## Research basis

- [Official Powerball mechanics](https://www.powerball.com/media-center): the
  familiar product is a 5/69 + 1/26 combination game with nine prize modes and a
  shared jackpot. Those mechanics are not required to create a credible draw.
- [Walker & Young, An Economist's Guide to Lottery Design](https://onlinelibrary.wiley.com/doi/10.1111/1468-0297.00668):
  demand responds to prize return, skewness, secondary-prize variance, and
  rollover design. This supports one legible headline prize while warning that
  the parameter matrix affects behavior.
- [NBER, What Drives Demand for State-Run Lotteries?](https://www.nber.org/papers/w28975.pdf):
  demand reacts especially strongly to jackpot expected value, reinforcing the
  need to show odds and funded value rather than exploit rollover salience.
- [UK Gambling Commission consumer information rule](https://www.gamblingcommission.gov.uk/licensees-and-businesses/lccp/condition/4-3-3-lotteries-information-to-consumers):
  consumers need clear, accessible information before participation.
- [UK Gambling Commission RNG presentation findings](https://www.gamblingcommission.gov.uk/report/raising-standards-for-consumers-compliance-and-enforcement-report-2020-to/rts-7-generation-of-random-outcomes):
  no misleading probabilities, substituted near misses, or undisclosed rule and
  payout changes.
- [drand developer guide](https://docs.drand.love/developer/) and
  [protocol specification](https://docs.drand.love/docs/specification/): use a
  named chain root, a preselected future round, and verified threshold-BLS output.
- [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html),
  [AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html), and
  [Khronos glTF 2.0](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html):
  supported, interoperable asset and animation workflow for browser/mobile.

## Gates before real value

- Jurisdiction-specific gaming/lottery, age, KYC/AML, geofencing, marketing,
  token, tax, custody, and privacy review. A lottery benefit attached to a paid
  wager is not made legally harmless by calling it a free voucher.
- Independent economic, Solidity, randomness, database, and frontend audit.
- Exact conservation, epoch isolation, Sybil-splitting, replay, reorg,
  unavailable-beacon, duplicate-command, rounding, overflow, and long-run tests.
- Published immutable rules hash and migration policy; no operator discretion
  over an already-open epoch.
- Responsible-play controls and neutral results. Animation intensity must never
  imply a near miss or disguise a loss as a win.

