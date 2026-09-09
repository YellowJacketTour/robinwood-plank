# Native action settlement contract

## Verified existing boundary

The current garden and exchange use authenticated profile IDs, ordered profile locks, transaction receipts and exact integer balances. Garden harvests validate plot revision and maturity; Grain rewards transfer from a finite reserve. Exchange offers reserve existing charms or Grain, settle transfers, and refund remaining escrow on cancellation. The current native quest's coordinates, crops and reward counters are not authoritative inputs to either system.

The focused PostgreSQL garden and exchange tests passed: lifecycle, concurrent harvest, exhausted-reserve rollback, helper permission revocation, offer partial fills, competing fills, cancellation and replay. This inspection did not identify a demonstrated conservation bug requiring a speculative economic change.

## Command input

A future native action request should contain only `requestId`, `action`, `regionRevision`, `entityId` or `cellId`, and `targetRevision`. Tool selection may identify an owned equipped instance. Reject fields such as awarded quantity, damage, success probability, client completion timestamp or wallet balance. Never import accumulated quest rewards as an account deposit.

The shell retains the authenticated session. A native frame can submit an intention through an origin/source-validated bridge; it must not receive a reusable account bearer token. The bridge does not make the intention trustworthy: the server still validates it.

## Required authoritative state before wiring rewards

Region admission is implemented, but server-known player coordinates, walkable geometry and timed action state must exist before native gathering can settle. A valid home lease alone cannot prove that a character is beside a crop. The server needs a movement sequence, action phase, contact tick, equipped tool, resource cycle and applicable permission. Until then, cosmetic native animation cannot award durable goods.

At action start, validate session/profile, region admission, target existence, range, tool capability, resource revision and cooldown. Store an action ID and planned contact tick; reserve any consumed inputs in the same transaction. A rejected action leaves no reservation or reward. It is acceptable to acknowledge an animation start immediately, but that acknowledgement is not a harvest receipt.

At contact, recheck current permission, action cancellation, target cycle/revision, range and relevant resource conditions. A revoked helper must not finish a newly unauthorized action. Settlement consumes reserved inputs, changes the resource, transfers any finite Grain allocation and creates the receipt atomically. The successful contact emits an authoritative world event. Animation recovery can continue without another debit or yield.

## Lock and replay discipline

Choose and document one lock order for the new action service: affected profiles in ascending order, then region/action/resource records in a stable order, followed by economy rows and reserve. Existing `requireWorldHome` locks presence then home; it must be incorporated consistently, not called after acquiring conflicting resource locks from another path. Review this order against existing garden, home-permission and exchange transactions before connecting them.

A request retry returns the saved result if the normalized payload matches. A changed payload with the same request ID fails. A cancellation before contact releases the defined reservation; after committed contact it cannot undo an already issued harvest. The client keeps the request ID when the response is lost. Reconnect reads actual state and receipts rather than rerunning the animation to infer what happened.

## Inventory and exchange handoff

One harvest creates one lot/stack increment tied to a cycle receipt. The gameplay inventory and Satchel are views of authoritative records, not independently writable copies. A later sell offer reserves the available quantity through the existing exchange command. The visual pickup event and inventory refresh never mint a second copy. Likewise, equipping a creature, following, opening a panel or reacting visually cannot generate resources.

Grain conservation includes player balances, reserve and open buy escrow. Charm accounting includes available stacks, open sell escrow and declared consumed quantities. New resource minting must have an explicit production receipt and resource cycle; it is not constrained by the Grain supply equation, but must still obey its own production budget.

## Acceptance tests before enabling native rewards

Test two players targeting one resource; duplicate contact events; a lost response followed by retry; cancellation before and after contact; disconnected clients; permission revocation between windup and contact; wrong-region and impossible-range requests; stale equipment; expired leases; reserve exhaustion; and immediate resale of a valid harvest. Verify both the resource state and every balance/escrow total after each case. Renderer tests separately verify direction, impact timing, layers and tool attachment. Passing one group does not substitute for the other.
