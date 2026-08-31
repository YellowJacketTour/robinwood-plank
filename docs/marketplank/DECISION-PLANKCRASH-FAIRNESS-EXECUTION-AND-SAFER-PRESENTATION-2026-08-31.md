# PlankCrash fairness, execution, and safer-presentation decision record

Date: 2026-08-31  
Status: implemented on `dev`; successor-contract behavior, not a mainnet deployment authorization

## Outcome

This pass converts the CroCrash/Rugged and broader crash-market research into four enforceable properties:

1. A private client never advances more than 2.5 seconds beyond its latest authoritative table heartbeat.
2. Every verified private settlement is retained in an append-only local evidence ledger. A conflicting proof for the same table and round is reported as equivocation and is never overwritten.
3. Chain actions distinguish intent, wallet signing, submission, block inclusion, game acceptance, rejection, and unknown status. “Clicked” is never presented as “locked.”
4. A public drand result permanently closes discretionary cash-outs. Revealing the already-public result on-chain cannot reopen a perfect-information lock window.

## The public-randomness boundary

The existing Drand contract targets a beacon result roughly 60 seconds after round lock but allows a maximum effective flight of roughly 180 seconds. Before this correction, a player could read the revealed crash point and, when it lay after the reveal, lock at the last known-safe block. Blocking only the due-but-unrelayed interval was insufficient because `revealEntropy()` reopened manual `cashOut()`.

`PlankCrashDrand.cashOut()` and `cashOutFor()` now accept a lock only while the target beacon round is genuinely not due and entropy is not revealed. Pre-boundary locks settle normally. This is the conservative correct behavior for the existing protocol.

The tradeoff is explicit: a public beacon cannot both disclose the eventual crash point and preserve uninformed discretionary play afterward. A successor seeking a longer live window must choose one of these architectures and receive a separate audit:

- delayed retrospective settlement, where all lock intents are ordered before the future randomness and the animation is explicitly provisional;
- threshold-encrypted or TEE-held randomness with a separately analyzed trust/slashing model;
- repeated future-beacon checkpoints with precommitted acceptance rules, not a single early public terminal value.

No interface animation can solve this cryptographic ordering problem.

## Execution presentation

The UI lifecycle is:

`intent -> signing -> submitted -> included -> accepted`

with explicit `rejected` and `unknown` branches. A transaction hash is retained from submission onward and a block number from inclusion onward. The UI does not call a sequencer receipt finality; “included” is the strongest claim made without an additional finality proof.

Robinhood Chain exposes WebSocket RPC and Arbitrum-style sequencing, but a fast sequencer promise and L1 finality are different guarantees. See [Robinhood Chain connection endpoints](https://docs.robinhood.com/chain/connecting/), the [Arbitrum Nitro whitepaper](https://docs.arbitrum.io/nitro-whitepaper.pdf), and the [Offchain Labs sequencer-liveness review](https://docs.arbitrum.io/assets/files/2025-03-offchain-sequencer-liveness-securityreview-298b2cd6810968ed840dff94df1e0c0e.pdf).

## Presentation and consumer protection

Claimed payout is not synonymous with profit in a parimutuel pool. Result cards now display `payout - stake` as net. Win-associated sound, haptics, particles, and glow occur only when net is strictly positive. Account-rank changes are disclosed neutrally and do not tell players to increase stakes.

These choices track the UK Gambling Commission’s current requirements that rules and likelihood be available before commitment, random mapping not mislead players, products not encourage increased stakes or loss chasing, and returns at or below stake not be celebrated: [RTS 3](https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/rts-3-rules-game-descriptions-and-the-likelihood-of-winning), [RTS 7](https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/rts-7-generation-of-random-outcomes), and [RTS 14](https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/rts-14-responsible-product-design). These are design baselines, not a claim that the product is licensed in any jurisdiction.

Production autoplay remains a legal/product gate. The private simulator may retain automation for testing, but it must not silently become a real-value default; current UK rules require individual commitment to each game cycle ([RTS 8](https://www.gamblingcommission.gov.uk/manual/remote-gambling-and-software-technical-standards/rts-8-autoplay-functionality)).

## CroCrash/Rugged adoption boundary

Adopted concepts: persistent sessions, verifiable histories, clear mode separation, durable results, sharing without exposing an invite, and immediate local feedback backed by later authority.

Rejected as direct copies: a house-banked fixed multiplier, opaque server authority, wager-to-unlock pressure, and a literal Rugged/Mines ladder. PlankCrash remains a bounded parimutuel shared pool plus separately funded Powerboard.

## Dependency reachability

Safe overrides pin `ws >= 8.21.0` and `tmp >= 0.2.6`, eliminating the reported fragment-based WebSocket memory exhaustion and temporary-path traversal versions. Remaining high audit findings are currently in:

- nested OpenZeppelin 3.x/4.x packages pulled through the development-only Chainlink contract package; the reported Governor/proxy/Base64/Merkle modules are not imported by PlankCrash contracts;
- the legacy Solana v1/SPL dependency tree used by Marketplank, outside the PlankCrash runtime. npm proposes incompatible downgrades and therefore is not an acceptable automatic remedy.

These are not declared harmless: they require separate dependency-lane migrations and regression suites. They are not justification for `npm audit fix --force`.

## Mainnet gates still requiring external assurance

- independent smart-contract audit and property/fuzz review of the revised acceptance boundary;
- jurisdiction, age/access, AML, sanctions, responsible-play, lottery, and disclosure review;
- real Robinhood testnet writes measuring inclusion, reorg, sequencer outage, reconnect, and duplicate-submission behavior;
- documented incident/void/refund policy and operational key/relayer runbooks;
- independent math/game testing against the published rules before real value.

