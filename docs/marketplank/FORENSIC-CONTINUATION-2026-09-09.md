# PlankCrash forensic continuation — 2026-09-09

**Status: further hardening completed, with a reproduced economic risk still open. Mainnet is not approved.** This addendum supersedes the previous package's source fingerprint and test counts. It does not supersede the previous documented limitations.

## Four demonstrated configuration failures repaired

Four new negative-control tests failed against the preceding source because all four bad deployments were accepted. They pass against the hardened candidate:

| Accepted input before repair | Consequence | Repair |
|---|---|---|
| Rake step = uint256 maximum | Rate-quote arithmetic overflows and normal settlement cannot calculate a fee | Bound step to 1–10,000 basis points in both crash implementations |
| Refund timeout = uint256 maximum | Timeout/deadline and abandoned-multiplier arithmetic cannot complete | Bound nonzero timeout to 30 days in both implementations; production deployment keeps its tighter 1–24 hour constraint |
| Lottery oddsOneIn > 10^18 | The fixed-point flat hit threshold becomes zero for every round | Reject a ceiling above the probability scale |
| Bank game address has no code | Whitelist does not identify an executable game | Reject codeless game addresses at construction |

These are immutable configuration hazards, not evidence that an ordinary caller could edit the parameters of a correctly deployed contract. Code-presence checks do not prove that a contract is honest, immutable internally, or compatible with the expected interface. Deployment identity review remains necessary.

## Reproduced economic attack: selective relay during total honest-relayer absence

A test now demonstrates the previously documented refund/availability tradeoff concretely. A player in a funded 2x round can settle a favorable result by relaying its public entropy. In an unfavorable round, if **every honest relayer is absent until the refund timeout**, the player can withhold that relay and recover the losing stake. The mock selects representative externally observable outcomes; the attacker is not assumed able to forge a production drand signature or control the actual randomness.

The two representative outcomes used 0.001 ETH stakes. The favorable round credited 0.002 ETH. The unfavorable, unrelayed round refunded 0.001 ETH. Aggregate receipts were 0.003 ETH against 0.002 ETH staked, before gas and capital-lock costs. Under ordinary settlement the losing stake would not return. This is a demonstrated strategic option against historical funded subsidies, not a claim that every target, funding amount, gas price or honest-relayer configuration yields a profitable attack.

Let stake be s, probability of a winning outcome p, and gross winning payout R. Ordinary expected net is pR − s. With selective relay and a full losing-stake refund it becomes pR + (1−p)s − s = p(R−s). The option adds (1−p)s before costs. For a fair R=s/p, that added value is positive whenever 0<p<1. A capped payout may reduce R, and gas/capital costs matter, but those effects do not eliminate the demonstrated funded case.

A related boundary remains after the abandoned-round deadline: the fallback can refund even with entropy already on chain. A normal functioning permissionless settler can prevent that condition by settling earlier; prolonged censorship or complete operational absence violates that availability assumption.

This is consistent with general randomness integration guidance warning against discarding unfavorable outcomes. The cited guidance concerns Chainlink VRF; PlankCrash uses drand, so it is a security principle comparison rather than a claim of Chainlink integration. [Chainlink randomness security considerations](https://docs.chain.link/vrf/v2-5/security).

## Implemented containment

Every timeout refund in **PlankGuardedCrash** now automatically:

1. Freezes new admission.
2. Clears any previously scheduled reopening.
3. Emits a recovery-freeze event identifying the refunded round.
4. Leaves claims and withdrawals available.
5. Requires the usual governance authorization and immutable delay to reopen.

Public callers cannot bypass that freeze by restarting rounds or requesting reopening. The regression verifies both the refund option and the containment. A timeout is now an incident requiring recovery review, not an unattended way to repeat favorable settlements and refunded losses indefinitely.

**Containment does not remove the first refund option.** It also does not make governance permissionless or guarantee availability of the governance key. The experimental scalable implementation receives the arithmetic parameter fixes but is not silently promoted to the guarded production selection.

The remaining release decision is substantive: preserve fallback refunds under an explicit, independently reviewed relay-availability assumption, or redesign terminal recovery so outcome-dependent cancellation is impossible. Removing refunds without an alternative can strand stakes during a permanent dependency failure. Claiming both unconditional refunds and unconditional inability to discard externally known losses would conceal the conflict. No cosmetic counter, longer timeout, additional browser animation, or passing test count proves both simultaneously.

## Stateful stress sequence and what it actually checked

A new deterministic 48-round sequence mixes four players, varied stakes and targets, normal settlement, seven actual lottery failures/retries, six guardian freezes/reopenings, payout exits and routed rake. Unlike a vacuous monotonicity assertion at zero principal, this test executes the vault routing leg every round and requires protected principal to increase each time.

It completed 101 nonzero crash payout exits. Final protected principal was 522,465,930,000,000 wei in that fixture. Every completed step checked the crash, lottery and router against their accounted balances. Late funding did not alter a queued draw's committed quote. Reopening did not extend the previously expired acceptance deadline. Deferred lottery processing could not consume a newer round's board, and users exited before dependency recovery rather than only after a convenient reset.

This is one reproducible stateful seed and sequence, not exhaustive fuzzing over all EVM executions. Other regression suites cover different seeds, math boundaries, gas starvation, coalition patterns and callback behavior. The test demonstrating the unresolved relay option is explicitly named as audit evidence: its success means the risk was reproduced, not prevented.

## Release posture

The previous reviewer package is no longer the final source for this continuation. The updated package contains the changed source, exact snapshot, negative-control log, successful constructor tests, stateful sequence, explicit attack reproduction, scanner output and release-gate result. No external audit result was fabricated or substituted with this internal report. Nothing has been committed, pushed, deployed to mainnet or sent to the auditor.

The condition requested by the user—no angle of compromise or profitable adversarial strategy under every possible execution—has **not** been established. In particular, this pass found a concrete remaining exception and contains it instead of claiming it away. Independent resolution of the recovery model and production relay evidence remain required.


## Final verification for this continuation

The final repository run passed 277 contract tests with one pending, and 1,598 application tests with 48 skipped. One of those contract tests intentionally demonstrates the open relay/refund risk and checks containment; it must not be counted as evidence that the risk is eliminated. The pending and skipped tests remain visible in the logs. Scoped lint, TypeScript checking and production build passed. Mobile control checks passed on the newly deployed local guarded stack.

The current Slither scan analyzed 85 contract/interface definitions with 102 detectors and emitted 167 findings; all are preserved in the new raw JSON and triage CSV. Scanner findings have not all been independently cleared. The findings register now explicitly includes PC-RELAY-OPTION-01, and the production launch gate rejects the open blocking finding even before considering missing external evidence. The register and gate code are included in the source fingerprint, so a changed disposition requires a newly bound review.
