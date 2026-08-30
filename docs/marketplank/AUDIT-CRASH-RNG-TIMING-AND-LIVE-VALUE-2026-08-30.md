# Crash RNG, timing, and live-value audit

Date: 2026-08-30

## Verdict

The private multiplayer alpha had two material mismatches and one critical information leak. They are corrected in this change:

1. Its crash point was uniform from 1x to 100x. That is not a crash-game tail and could never exercise enormous outcomes.
2. The exact committed crash deadline (`crashAt`) was serialized to every participant while the round was live. Hiding only `crashBps` and the reveal did not help; the timestamp disclosed the answer in another unit.
3. Arbitrary 1.5x/2.5x/5x color tiers could be interpreted as recommendations despite having no economic authority.

The alpha now uses the production contract's inverse-survival species, supports a real 10,000x maximum, combines it with an exponential display curve, withholds the deadline until settlement, lets a blind server long-poll keeper settle without disclosing a due bit, and labels the live `x` as a claim-weight factor rather than a fixed payout.

## Crash-point distribution

For uniform `U` discretized into 10,000 buckets, the mapping is:

`M_bps = 100,000,000 / (10,000 - U)` for `U > 0`, otherwise `10,000`.

Approximately, `P(M >= x) = 1/x`. This produces the characteristic heavy tail:

| threshold | approximate reach probability |
| --- | ---: |
| 2x | 50% |
| 10x | 10% |
| 100x | 1% |
| 1,000x | 0.1% |
| 10,000x | 0.01% |

Rake is accounted separately in the parimutuel pool. It is not hidden by distorting the crash random variable. The laboratory uses deterministic SHA-256 rejection sampling before the 10,000-bucket map, eliminating modulo bias even though the direct 256-bit bias would already be negligible.

## Time curve and absence of a privileged moment

The alpha displays:

`x(t) = exp(0.22 t)`.

Combining this curve with `P(M >= x) = 1/x` gives:

`P(T >= t) = exp(-0.22 t)`.

Therefore the crash time has a constant hazard rate in the ideal continuous model. Merely surviving longer does not create a special clock-time window that the presentation can reveal. Representative milestones are about 3.15 seconds to 2x, 10.47 seconds to 10x, 20.93 seconds to 100x, and 41.87 seconds to 10,000x.

This does **not** make every lock strategy economically identical in Plank's parimutuel system: other participants' final valid weights still determine allocation. It does mean the animation curve itself does not contain a hidden clock-time sweet spot.

## Randomness and information boundary

- The private alpha commits `SHA-256(reveal)` before flight and reveals the 256-bit value only after settlement.
- The raw reveal, crash point, deadline, internal `due` state, and lottery derivative stay server-side during flight.
- A seat's requested auto-lock target is visible only to that seat until settlement. Bot launch events disclose population counts/presets, never their stakes or planned targets.
- The updates endpoint performs blind settlement after the stored deadline. It returns only the ordinary settled snapshot after the transaction succeeds.
- Visual particles, camera shake, and scenery use non-economic randomness and cannot affect or predict settlement.

The principal mainnet design uses `PlankCrashDrand`, whose beacon verifies threshold BLS output before deriving an outcome. Public randomness must be unpredictable before its pulse and auditable afterward; NIST's randomness-beacon reference identifies unpredictability, timestamping, signatures, and hash chaining as central properties: <https://csrc.nist.gov/pubs/ir/8213/ipd>. Full-entropy output is only useful here when it is also unavailable before commitment; NIST IR 8427 emphasizes unpredictability as the security property: <https://csrc.nist.gov/pubs/ir/8427/final>.

## What the displayed x means

During flight, `x` is the continuously drawn estimate of the server-clock claim-weight factor. It is **not** the current cash value of the bet and is never described as `stake × x`.

When a lock request reaches the server:

1. The server verifies that its hidden deadline has not passed.
2. It computes the factor from its own `started_at` and current server time.
3. It atomically stores `accepted_target_bps` once.
4. Every subsequent snapshot shows that exact accepted factor.

Final payout is exact only after settlement:

`player payout = distributable pool × player valid weight / total valid winning weight`.

The UI may show the accepted factor, stake, exact final payout, and exact net. It must not call the live factor “winnings,” fabricate a fixed cash value, publish the hidden deadline, or present threshold colors as strategic advice. A provisional “if closed now” payout was deliberately not added because it changes as other locks become valid and can itself become an intervention signal.

## Mainnet limitation requiring a successor-contract decision

The current deployment scripts default `maxElapsedBlocks` to 1,800 while the quadratic contract curve is `10,000 + 40e + floor(e²/5)` bps. At that cap the economically reachable maximum is about **73x**, not an enormous multiplier. Raw entropy can derive up to 10,000x, but values beyond the cap settle at the cap; the uncapped value is informational only.

That is honest and solvent, but it does not satisfy an “enormous live total” product promise. Simply raising the block cap would make rounds last many minutes and would expose chain block-time variability. The compatible successor should use a fixed-point exponential curve tied to an explicitly measured/maintained time oracle or timestamp policy, retain the inverse-survival mapping, and cap around 10,000x in roughly 42 seconds. This is a contract/economic migration requiring independent audit and cannot be truthfully fixed by changing only frontend animation or a deploy-script number.

## Acceptance invariants

- No running response contains `reveal`, `crashBps`, `crashAt`, `due`, or any reversible equivalent.
- `commitment == SHA-256(reveal)` after settlement.
- A lock at or after the hidden deadline is rejected regardless of what the client displays.
- Accepted lock factors are immutable and server-computed.
- The live clock is monotonic across delayed and reordered snapshots.
- At settlement the displayed crash factor equals the committed derived factor.
- Total payouts never exceed the distributable pool.
- The UI never equates the claim-weight factor with guaranteed cash value.
