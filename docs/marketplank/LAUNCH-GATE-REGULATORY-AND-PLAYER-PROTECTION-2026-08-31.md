# PlankCrash launch gate: regulation, testing, and player protection

Status: **engineering requirements and counsel intake, not legal advice or approval**.

PlankCrash combines paid wagering, a parimutuel crash round, and a funded lottery. Calling it a
"game", "community platform", or decentralized software does not remove gambling, lottery,
consumer-protection, sanctions, AML, tax, privacy, or advertising obligations. Mainnet value play
must remain disabled until qualified counsel has identified the operator, target territories,
licences, exclusions, and required controls in writing.

## Non-negotiable release gates

1. **Territory decision and legal opinion.** Record the operating entity, server/operator roles,
   offered territories, prohibited territories, token/value characterization, custody flows, and
   whether each crash and Powerboard mechanism is gaming, pool betting, lottery, sweepstakes, or
   another regulated product. A repository note or model review is not approval.
2. **Age, identity, and location enforcement.** Fail closed before deposits, free-play versions that
   advertise the value game, wagering, or claims where required. Wallet ownership is not age,
   identity, sanctions, source-of-funds, or geolocation proof.
3. **Truthful pre-commit disclosure.** Before every wager disclose the parimutuel payout rule,
   applicable rake and allocations, stake/min/max, economic payout cap, current pool, lottery-ticket
   weight, draw rule, jackpot funding/rollover, randomness source, interruption rule, and that the
   displayed multiplier is claim weight rather than a fixed stake-times-multiplier promise.
4. **No dark patterns.** No fake urgency, disguised purchases, misleading "positive-sum" language,
   hidden currency conversion, loss-chasing prompts, or celebration that misstates net loss. Show
   credits and fiat equivalent together, committed amount, paid amount, fees, and net result.
5. **Player controls.** Deposit/spend/loss limits, session time and net P&L, reality checks,
   time-out/self-exclusion, immediate limit reductions, cooling-off for increases, accessible account
   history, and support/escalation paths must exist before value play.
6. **Fairness and security certification.** Freeze source, compiler/settings, bytecode, parameters,
   ABIs, UI disclosure text, relayer, and deployment graph. Obtain independent contract and
   mathematics reviews; test RNG, payout/RTP, peer-to-peer fairness, interrupted play, recovery,
   collusion, persistence, and accounting against the intended jurisdictions and GLI-19/other
   applicable lab criteria.
7. **Operations evidence.** Incident drill, rollback/failover drill, key compromise and randomness
   outage drill, monitoring/SLOs, immutable accounting export, vulnerability disclosure/bug bounty,
   signed testnet canary, and owner-approved release record.

## Engineering acceptance matrix

| Area | Required evidence | Current posture |
| --- | --- | --- |
| Crash solvency/accounting | invariant/property tests plus independent math review | internal evidence only |
| Powerboard conservation/draw | stateful adversarial tests plus independent review | internal evidence only |
| Randomness | verified beacon signature, pinned chain identity, fail-closed freshness, migration drill | in progress |
| L2 ordering/timing | authoritative chain state, explicit finality/reorg policy, sequencer outage drill | in progress |
| Rules/odds | versioned pre-bet disclosure and exact settlement receipt | partial |
| Player protection | age/location controls, limits, reality checks, exclusion | not launch-ready |
| Security | frozen target, external audit, public disclosure channel/bounty | external gate |
| Licensing | written jurisdiction-specific counsel/operator approval | external gate |

## Primary standards informing this gate

- UK Gambling Commission Remote Gambling and Software Technical Standards: rules and likelihood of
  winning, RNG/result determination, progressive jackpots, interruption, collusion, limits, reality
  checks, and product design.
- UKGC licensing guidance: serving Great Britain remotely requires the applicable licence even when
  the business is based elsewhere; age verification precedes deposits, free play, and wagering for
  covered operators.
- GLI-19 v3.0: interactive-system controls, player interface/session information, RNG, fairness,
  payout/odds, peer-to-peer play, and persistence.
- FTC consumer-protection guidance and enforcement: odds, real cost, and material terms must be
  truthful and conspicuous; virtual-currency layers and manipulative interfaces cannot obscure spend
  or chances.

These sources are baselines, not a jurisdiction selection or substitute for counsel. The strictest
applicable requirement should be the engineering default; territory-specific differences belong in
policy/configuration only when counsel approves them.
