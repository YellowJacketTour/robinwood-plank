# Funded rewards are not a universal non-farming guarantee

September 9, 2026. Applies to the current capped-survivor rule, not the older CCS-2L settlement formula.

The product intentionally permits actual target-multiplier payouts when player funding plus precommitted underwriting can afford them. Protected principal is excluded. This is a bounded subsidy; it is not proof that every strategy has negative expectation.

## Reproduced consequence

`test/contracts/PlankIterativeFunding.test.ts` deploys the actual numbered-lottery and capped crash stack, funds the spendable reserve and lottery, and observes a full 1.01x payout to the sole round owner. Under the uniform 10,000-residue crash model, 9,900 residues survive 1.01x. Its expected crash return is 0.9999 times stake. Adding the actual funded lottery quote and numbered hit probability produces positive combined expectation before gas in this fixture. Hash modulo deviations are negligible relative to the demonstrated margin.

There is no need to forge a wallet, bypass access control or predict entropy. An ordinary player can take the strategy; a coalition can do it too. Therefore a blanket claim that the current funded game is never profitable to farm is false. Passing legacy CCS-2L rake-cap tests must not be used as evidence for that claim about the current capped rule.

This does not itself demonstrate access to protected principal or insolvency. The underwriting is escrowed, payouts are capped, unused funds return, and physical ETH accounting remains conserved in the fixture. Spendable reserve depletion is a separate economic/product risk from principal theft.

## What each paid round actually contributes

The default router allocates 69% of net rake to community, with the configured lottery share removed; the remaining vault leg is split into protected principal and spendable buffer. New tiny- and large-stake integration tests verify positive contributions to both portions across winning and losing rounds, and conservation after withdrawals. Delivery is through permissionless flush/claim calls: it is not automatically guaranteed to arrive before the immediately next round starts.

The guarantee is a positive funded contribution at the tested/configured minimum stake. It is not a guarantee that the total next pot, next seed or spendable reserve increases. Arbitrary one-wei configurations and zero allocation settings do not have the same strict-growth guarantee because of integer rounding.

## Required release decision

Choose and independently review the intended policy:

1. **Deliberately subsidized play:** permit positive expected player returns while rewards are funded. Specify the acceptable depletion rate and replenishment assumptions; disclose that spendable rewards fluctuate. Identity/rank limits are not a Sybil-proof budget control.
2. **Contribution-bounded underwriting:** bound aggregate reward spend against actual paid activity, including combined lottery expectation. This reduces farming opportunities but changes the promise of full target multipliers on a quiet, heavily funded table.

Do not silently switch between these policies or market both contradictory promises. This pass preserves the previously authorized true-multiplier capped rule. No deployment approval or mainnet release follows from these tests; independent contract and economic review must bind the exact rule and configuration.

Reproduce with `npx hardhat test test/contracts/PlankIterativeFunding.test.ts` and `npx tsx scripts/research/plankcrash-subsidy-envelope.ts`.

## Minimum target for lottery eligibility

A precommitted minimum target can define a higher-variance participation tier. It is not, alone, an expected-cost safeguard: a fully funded 2x target has 5,000 surviving residues out of 10,000, hence 1x expected crash return before lottery value is added.

If introduced, use only eligible stake in ticket weighting and only its conservatively attributed net rake in the lottery hit budget. Applying a whole-round hit budget to a small qualifying cohort would let a tiny qualifying bet capture odds funded by excluded players. Missing eligible stake must mean no draw, with funds carried forward; it must never create a zero-denominator fallback winner. Eligibility should be fixed before entropy, including whether a crashed qualifying seat retains its ticket. The suggested second-chance design retains it.

The existing linear ticket selection and scalable cumulative ticket index both include all stakes. Both contracts, their round commitments, settlement event data and personal-odds display would require a coordinated versioned change. This pass does not silently introduce a threshold or change current lottery eligibility.
