# Funded-cycle lottery release candidate

This describes PlankCycleLottery, selected by the local, testnet and gated production deployment scripts. It is a candidate for independent review, not a mainnet approval.

## What the player buys
Every accepted bet participates in its round's lottery in proportion to its stake. Splitting a stake into wallets does not create extra aggregate ticket weight. Numbered-ball odds are derived from a funded probability ceiling; rounding to a whole ball count can reduce that probability. The visible winner prize is the amount credited on a hit, not the gross accounting pool. The animated draw replays a recorded contract result; rigid-body physics never supplies financial randomness.

## Fees and retained value
At the candidate defaults, each 100 units of fresh lottery funding allocates 10 to an immediate founder fee, 9 to a draw-rollover fee provision, and 81 to the banked lottery pool. These percentages apply to lottery funding, not directly to a player's entire bet. Integer remainder carry makes splitting deposits unable to avoid the aggregate fees.

A draw recognizes only its previously committed rollover provision as founder revenue. Funded unsuccessful draws therefore earn revenue repeatedly as new provisions arrive. An unfunded repeated miss earns no additional fee: the same banked funds are never repeatedly debited. Post-snapshot provisions wait for the subsequent commitment. Fee recognition transfers value between accounting buckets without reducing the banked pool.

On a win, the gross committed board P is split into winner W and gross retained seed S. Retention in basis points is floor(M*F/(K+F)), where F is net fresh funding in the current cycle, M is the cap, and K the funding scale. The default cap is 20%; the contract bounds it to 25%. A separate 10% fee is taken from S; the remaining seed starts the next cycle. Winner + net seed + winning rollover fee equals P exactly. Late funding is preserved and starts the next cycle's funding progression; retained old seed is not counted again as fresh funding.

Production and testnet default K is 250,000 credits (0.25 ETH with 1 credit = 1e-6 ETH). Local preview K is 1,000 credits to exercise cycle progression at test scale. Retention depends on funding, not elapsed time, wallet count, or manufactured empty rounds. It can plateau at tiny integer amounts. Legacy carve constructor fields remain ABI metadata; funded-cycle overrides determine the actual carve.

## Odds budget
For round rake R, contribution fraction c, initial fee f, draw provision fraction d, and kappa k, the conservative contribution budget is:

C = floor(floor(floor(R*c)*(1-f))*(1-d)).

The hit ceiling is min(1/flatOdds, C/[k*(W+winningSeedFee)]). The numbered draw rounds odds conservatively. Both fees on fresh funding and the extra pool outflow on a winning retained seed are included. Existing founder earnings and protected crash principal never fund this probability budget.

## Guarantees and limits
Separate ledgers protect committed obligations. Fees do not make the game globally positive sum: they redistribute participants' funding. Historical crash subsidies can improve later players' outcomes only while spendable backing remains. Protected principal and spendable seed are distinct. Neither total future payouts nor every future prize can grow unconditionally after winners withdraw. Strategy tests bound conservation and specified attacks; they do not prove the contracts impossible to exploit.

## Operations
Round advancement is permissionless and can be performed by multiple independent gas-only keepers with distinct signers. The keeper re-reads chain state each tick, caps RPC requests at 15 seconds and receipt waits at 60 seconds, and emits tick/error-code logs. A timeout does not cancel a submitted transaction: monitor pending nonces and reconcile on-chain state before replacement. Run under a restart supervisor; keepers must not share a private key. Pin the drand chain hash and supply at least two relay URLs. Missing randomness follows the contract refund timeout, with refunds credited/claimed according to its rules. A browser animation does not constitute settlement or withdrawal.

Funded gas, RPC service, a live chain, and eventual transaction inclusion remain dependencies. No finite gas wallet guarantees eternal operation. Alert on stale round phase, heartbeat absence, pending transaction age, gas runway, failed deliveries and beacon unavailability; retain permissionless player recovery. Crash accounting and player pull balances remain authoritative across process restarts.

## Launch evidence still required
Independent contract audit and economic review bound to exact source/configuration; a real-beacon public-testnet soak and incident drill; configured gas funding and independent keeper supervision; production venue/oracle verification; and the release gate's required legal and bounty evidence. Passing local simulations does not replace these. Do not publish a promise of guaranteed payouts, guaranteed profit, or unattended operation forever.
