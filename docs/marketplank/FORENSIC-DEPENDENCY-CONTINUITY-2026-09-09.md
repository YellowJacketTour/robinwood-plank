# Dependency and launch-continuity forensic pass

2026-09-09. This extends the original-result-only recovery candidate. It is not an independent audit or mainnet clearance.

## Security corrections

**PC-ORACLE-OUTAGE-05:** a long-unobserved pool could produce an average dominated by an obsolete price, while update() labelled it fresh. The end-to-end regression holds the old rate for an extended outage, changes the market rate, updates the oracle and attempts a discounted buyback. Before the fix the spend succeeds. After the fix it fails without moving ETH. The oracle discards the obsolete observation and requires a new complete bounded window. Once primed, it rejects the bad execution rate and permits a correctly priced burn.

**PC-ZERO-OUTPUT-FLOOR-06:** integer rounding could produce a zero amountOutMin. The engine now rejects that case before transferring ETH or calling the router. This is conservative dust protection, not a claim of a demonstrated large-value drain through one-wei inputs.

**PC-ORACLE-EPOCH-07:** the oracle now measures observation age with a full-width timestamp and bounds configured intervals to the accumulator's supported range. A whole uint32 epoch can no longer appear to be a short recent interval. The long-clock test uses an isolated snapshot and restores it. Ordinary V2 accumulator wrap behavior remains supported.

These changes do not eliminate the general economics of manipulating a thin market for a full observation window, adverse execution within the allowed slippage band, compromised external assets or network failure. Canonical dependency validation and independent review remain necessary. Protected crash principal and player payout math were not changed in this pass.

## Launch and lottery continuity

The scene previously hid the entire pad/tower at progress 0.1 and also pushed it downward. Both actions are removed. The structure stays fixed in world coordinates and eventually leaves the camera view through real ascent and frustum clipping.

Each betting/sealed phase now resets flight motion, speed effects, shake and camera field of view to a fixed launch pose. The camera allows initial platform clearance, then follows the craft. Follow framing was visually refined so the avatar does not cover the multiplier readout. Read-only telemetry supports reproducible measurements without providing a gameplay control.

The browser test plays three on-chain local rounds and requires mixing, chute, rolling, orienting and presented gumball phases, ascent, crash finale, verified draw data and repeated launch-camera equality. The machine art and prize collection were rendered and inspected, not inferred from state assertions. Separate no-wager visual samples check the fixed tower and readable avatar at four ascent heights. The final source loop (release-gumball-loop) completed rounds 17, 18 and 19 with three verified draws and all animation phases; those draws rolled over. The earlier hardened-gumball-loop completed rounds 6, 7 and 8 and collected a winning prize. Its later camera-follow refinement did not change lottery logic. Both proofs and the final ascent screenshots accompany this report.

## Evidence and scope

- Full contract suite: 283 passed, one pending. Do not count the pending case as executed.
- Application suite: 1,599 passed, 48 skipped. It was rerun for the final visual changes.
- Required lint, type checks and production build passed before this handoff.
- Focused oracle/burn suite: 19 passed. The pre-fix negative control fails because the bad-priced burn succeeds, establishing that the regression detects the defect.
- Fresh Slither scan completed on the current forced compiler unit: 169 detector flags (19 high, 46 medium, 41 low, 63 informational). All are retained in raw output and CSV for independent review. These are detector classifications, not 169 confirmed exploits or 169 cleared findings. No claim that every flag has been independently cleared is made.
- In touched burn paths, Slither flags the intended bounded caller bounty and state updates after external token/router calls. The code uses nonReentrant, a fixed route/recipient, a balance-delta output check, and the new nonzero floor. Those controls support the tested paths; they do not certify arbitrary substitute routers or tokens.
- Only local chain 31337 was redeployed. No mainnet transaction, production-key access, push, or public deployment occurred. The local node was not reset.

## Release boundary

The original selective-refund regression remains closed through non-cancellable commitments. Permanent absence of the original beacon result still leaves unsettled stakes pending. PC-ORIGINAL-RESULT-LIVENESS-04 remains a blocking review item, along with outstanding independent review and production-readiness evidence. The current source-bound launch gate remains failed. Tests and this internal pass do not establish an unbreakable platform.

## Primary reference

Uniswap's [oracle integration guide](https://developers.uniswap.org/docs/protocols/v2/guides/building-an-oracle) distinguishes fixed-window examples without a maximum interval from freshness-sensitive designs and documents the accumulator's timestamp range. This pass adds a maximum accepted observation age for the buyback use case; it does not claim that every fixed-window oracle is defective.
