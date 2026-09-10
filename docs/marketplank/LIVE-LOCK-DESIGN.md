# Live locking: protocol candidate and release boundary

Status: research kernel with adversarial policy tests; not deployed, not connected to wagers, not an independent audit. The current public contract commits targets before future randomness becomes public. Its flight is explicitly a replay. The private alpha's server-authoritative live locking is a different trust model.

## What a player should receive

One pre-locked target remains effective after disconnect. A live-lock tap submits an exact round, pulse, nonce, target and deadline. It shows **Locking…**, then the accepted multiplier only after verified inclusion. A missed deadline cannot silently buy the next round or accept a different multiplier. “Locked” means the target is fixed, not that the pool can necessarily pay the full nominal multiplier. Final proceeds remain bounded by the independently funded capped-survivor allocation.

The current implementation now has round-bound direct and session wagers. A delayed transaction for round R reverts after R ends. Legacy unconstrained entrypoints remain for compatibility and explicitly do not provide that guarantee; the public UI must never fall back to them.

## Proposed survival pulses

Do not publish a single final crash seed while accepting live decisions. Instead use independently domain-separated future beacon pulses. At a verified surviving multiplier a, sample a fresh uniform U in [0,1) and define the conditional crash C=a/U, with the zero sample representing the bounded tail. For the next milestone b>a:

    Pr(C >= b | survived a) = a/b
    Pr(survive a0 -> a1 -> ... -> an) = a0/an

Thus pulse boundaries need not change the ideal 1/x survival law. A pre-locked target inside a failed pulse still succeeds when it is below that pulse's conditional crash. It must not be rounded upward to the next milestone. The research kernel uses 256-bit integer entropy; each threshold differs from the ideal probability by at most one sample out of 2^256. Domain separation must bind chain, contract, game round, pulse and policy version.

Manual locks may use only a verified surviving value. Exponential scenery can interpolate, but an interpolated, unverified value cannot be offered as guaranteed. A continuous rising headline paired with a lower lock price is not WYSIWYG. Therefore the user-facing live multiplier must pause at the verified value while a pulse is pending. This is a substantial experience tradeoff, not something animation can solve. A 3-second beacon is not a 60-Hz cashout oracle.

## Inclusion before entropy is the hard requirement

An operator timestamp, browser timestamp, RPC acknowledgement, transaction hash or sequencer promise is not proof that the decision was irrevocable before randomness became known. Even a valid BLS beacon signature proves authenticity, not that no adversary learned it early. The security assumptions must explicitly bound early beacon leakage and chain reorganization/backdating.

The conservative policy requires a verified canonical inclusion anchor, finalization before the next entropy publication, and an additional configured security margin. A late relayer cannot reopen the lock window after the beacon has published. If the target chain cannot provide this in the desired time, this mode stays disabled. Ordinary L2 confirmations must not be labelled L1 finality. On Ethereum L1, 12-second block production already makes subsecond canonical acceptance infeasible; finality is slower still.

An accelerated receipt service could acknowledge a tap quickly, but censorship remains possible. Bonding can compensate only objectively provable violations of signed receipts and only within escrowed coverage. It cannot prove receipt of a packet the service refuses to acknowledge. Such a service adds an explicitly disclosed trust and exposure model. It is not an “unbeatable” substitute for consensus.

## Adversarial cases and required handling

* Entropy known but not relayed: close by the scheduled beacon cutoff, not availability in the local beacon contract.
* Delayed signature, replay, changed account/chain: bind all identifiers and nonce; reject without consuming stake or allowance.
* Sequencer backdating or reorganization: verified finality anchor required; a timestamp-only rule is insufficient.
* A disconnected browser: committed auto target executes from contract/protocol state, never a client timer.
* Manual/auto race: the earliest valid lower target wins under a deterministic ordering; no post-crash amendment. Preserve the original auto ceiling.
* Failed pulse crossing an auto target: compare the exact target against conditional crash, rather than losing all targets within that pulse.
* Pulse outage: freeze progression and lock acceptance; use a precommitted deterministic timeout rule. Never let the operator select refund versus unfavorable settlement after learning randomness.
* Sybil splitting: aggregate stake governs allocations; account count and ranking do not grant reserve rights. Dynamic target changes need a new partition-invariance proof and bounded index updates.
* Unbounded round length: finite maximum target, pulse count and per-round exposure; preserve all old payout obligations across next rounds.
* Concurrent receipts: idempotent state transitions and permissionless recovery, with signatures verified independently from transport acknowledgements.

## Implementation boundary

`lib/casino/live-lock-policy.ts` is an executable math/policy model, not an inclusion-proof verifier. Its `anchorVerified` input is an assumed result of a future verifier, not a feature provided by this model. Do not wire this boolean to a browser or arbitrary server response. The tests cover rejection boundaries and the conditional survival law; they do not establish end-to-end protocol security.

Still required: a selected chain and documented timestamp/finality bounds; verified pulse contracts; bounded mutable target indexing; intent signature and inclusion-proof verification; timeout economics; pre-lock/manual ordering; liquidity and Sybil analysis for dynamic allocation; real-network latency and outage evidence; independent protocol and contract reviews. No live-lock mainnet deployment is authorized by a passing model test.

## Primary sources

* [drand protocol specification](https://docs.drand.love/docs/specification/): scheduled rounds, beacon construction and cryptographic assumptions.
* [Ethereum blocks](https://ethereum.org/developers/docs/blocks/): block production and timestamp semantics.
* [Ethereum transactions](https://ethereum.org/developers/docs/transactions/): signing, inclusion and successful execution are distinct steps.

The pulse architecture and policy above are engineering inferences from these primitives, not claims that those sources endorse PlankCrash or establish its safety.
