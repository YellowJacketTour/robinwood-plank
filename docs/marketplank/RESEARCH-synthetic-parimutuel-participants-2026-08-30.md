# Synthetic participants for the private PlankCrash laboratory

Date: 2026-08-30
Status: implemented for simulation testing; not a mainnet participant design

## Non-negotiable conclusion

A bot population can make a one-human laboratory round economically nontrivial,
but it cannot **guarantee** that the human wins without either knowing/changing
the crash outcome or receiving a subsidy. Both would falsify the parimutuel
experiment. Plank therefore uses server-owned synthetic actors that:

1. have their own finite test-credit bankrolls;
2. commit stake and target before the crash reveal exists;
3. settle through the identical rake, PFSS, vault, lottery, and payout kernel;
4. receive no refill, priority, oracle, or special payout path;
5. expose their profile and CPU identity to every person at the table; and
6. produce replayable choices from a domain-separated deterministic seed.

This creates honest positive-multiplier human payouts when the human survives
and has a valid share of the survivor pool. It also preserves losing rounds,
ruin, concentration, rollover, and whale-impact scenarios.

## Evidence synthesized

- Kelly's log-growth criterion motivates proportional bankroll sizing rather
  than fixed wagers that silently create unlimited synthetic credit. It is a
  normative baseline, not a claim that this negative-rake game offers a positive
  expected edge: [Kelly (1956)](https://onlinelibrary.wiley.com/doi/abs/10.1002/j.1538-7305.1956.tb03809.x).
- Cumulative prospect theory supplies heterogeneous long-shot weighting and
  gain/loss asymmetry instead of pretending all testers maximize expected
  utility: [Tversky and Kahneman (1992)](https://doi.org/10.1007/BF00122574).
- Prior gains can increase risk-taking (house-money behavior), while prior
  losses can induce attempts to break even. Both are represented as explicit,
  bounded profiles rather than hidden adaptive manipulation:
  [Thaler and Johnson (1990)](https://pubsonline.informs.org/doi/10.1287/mnsc.36.6.643).
- Budget-constrained large bettors can change equilibrium outcomes for diffuse
  bettors in parimutuel games. A whale profile and population stress controls
  are therefore necessary, but whales stay visible and bankroll-limited:
  [Bayraktar and Munk (2016)](https://arxiv.org/abs/1605.03653).
- Experimental sequential parimutuel markets exhibit belief heterogeneity and
  favorite/long-shot effects, supporting distributions rather than one
  representative bot:
  [Koessler, Noussair, and Ziegelmeyer](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1021172).
- Current multiplayer engineering practice repeatedly emphasizes server
  authority, deterministic seeds, replay logs, and keeping presentation RNG
  separate from economic RNG. Practitioner discussions also flag desync and
  bot-score contamination when those boundaries are blurred:
  [Artifice discussion](https://news.ycombinator.com/item?id=47328876),
  [multiplayer deterministic simulation discussion](https://news.ycombinator.com/item?id=39493498),
  [lockstep/replay discussion](https://news.ycombinator.com/item?id=32054857).

## Implemented profile family

| Profile | Bankroll fraction | Target character | Historical response |
| --- | ---: | --- | --- |
| Cautious | 1–3.5% | early | none |
| Balanced | 2.5–8% | middle | none |
| Bold | 5–15% | later | none |
| Whale | 10–30% | early/middle | price-impact stress |
| House-money | 3–18% | middle/late | fraction rises after gains |
| Break-even | 3.5–20% | late | fraction rises below initial bankroll |
| Wildcard | 1–25% | full allowed range | broad exploration |

Targets are sampled in log space so wide multiplier ranges do not collapse into
an unrealistic concentration at the numerical high end. The mixed population is
25% cautious, 35% balanced, 15% bold, 5% whale, 8% house-money, 7% break-even,
and 5% wildcard. Every field can be overridden for selected individuals, a
selected batch, or the full population.

## Safety and audit invariants

- Population cap: 500 active bots per room; 100 added per command.
- Bot stake never exceeds its current bankroll and never falls below the table
  minimum when it participates.
- A bot below the minimum stake sits out; there is no automatic bailout.
- Disabled bots preserve their bankroll/history but do not commit.
- Removing a bot before launch refunds any pending laboratory seat; settled
  history remains intact.
- Host mutations are PIN/admin gated, origin checked, rate limited, idempotent,
  and appended to the room event stream.
- Invitees can inspect CPU identities, commitments, locks, payouts, and balances
  but cannot mutate the population.
- Qualified wagers accumulate linear, stake-weighted tickets in an isolated
  Powerboard epoch ledger, matching the current ratified ticket species. A hit
  uses domain-separated committed reveal entropy plus unbiased rejection
  sampling, credits the winner's actual bankroll, and exposes the identity and
  payout in the shared settlement story. Bots receive no lottery preference.
