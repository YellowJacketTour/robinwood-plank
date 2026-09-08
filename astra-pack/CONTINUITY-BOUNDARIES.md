# Continuity boundaries

Locked for review, 2026-09-07. This document takes precedence over earlier continuity proposals.
One home: pine, Charmville, satchel, WoodAmp, many keys, and a human-owned outbound caster.

## Draft merge, ledger serialization, device-local secrets

| Object | Authority and recovery |
|---|---|
| Pine prose, unaccepted destination chips, composer variants | Encrypted draft sync and version history. CRDT-style text merging may preserve compatible edits; conflicting revisions remain available. |
| Upload bytes and media | Encrypted, resumable, integrity-checked chunks addressed by content hash. |
| WoodAmp track, position, volume | Restore preferences and playback position; not a ledger. Respect no-autoplay and local output choices. |
| Charmville layout drafts | Keep both conflict copies; owner chooses. Applying a layout requires server validation against current occupancy/revision. |
| Intent/delivery status | Mirror authoritative queued / sent / blocked / caster-offline status. Never fork a delivery to resolve a sync conflict. |
| grain, Stalk faces, seeds, Rings, stamp inventory | Server ledger only. Devices may refresh read-only views; never merge or upload balance snapshots. |
| Plant, harvest, stamp | Online request with a live primary session. Server serializes, checks ownership/state, and records one result. No offline action queue or optimistic replay. |
| Primary wallet role | Postgres wallet links and explicit signed rotation. Resume cannot promote a connected handset wallet. |
| Caster cookies, WalletConnect sessions, OAuth refresh tokens | Stay on the device that established them. No continuity upload, encrypted cookie relay, credential migration, or shared cookie jar. |

Draft synchronization is not an economy event stream. Two devices planting the same plot cause
one accepted server transaction and one rejected stale/conflicting request; never merge the plots.
Offline UI may show the last known garden, but disables economy actions and explains reconnection.
Layout drafts contain decorative placement proposals only, never crop timers, inventory, or harvest results.

## Intent identity and one stamp

`intent_id` is a client UUID created once and stable across retries. Acceptance verifies the immutable
signed payload and burns exactly one stamp in the same server transaction that records the intent.
This is one stamp per accepted intent, not one stamp per destination. Destination delivery ids are
subordinate to the same intent. A retry uses the SAME intent_id and does not burn or publish again
where successful delivery has already been established. Different content under the same id rejects.
Adding a destination after acceptance requires a new reviewed intent, not mutation of the old one.

Failure after acceptance does not refund the stamp. Cancel before acceptance does not burn it.
Confirmed destinations do not retry. Ambiguous external submission becomes needs-check and must be
reconciled before any retry: a website may not support our idempotency key. Never claim a click alone
proves delivery or promise exactly-once remote publishing without evidence from that platform.

## Same desk, separate machines

Phone composes and queues a draft; online authenticated acceptance can queue a signed intent.
Desktop PlankCaster flushes accepted work using its own logged-in partitions. caster-offline is explicit.
A future phone-native caster signs into its own partitions; desktop cookies are never beamed to it.
Encrypted draft and accepted-intent transport may cross devices; execution credentials never do.

Resume restores profile id, then refreshes plankspace_wallet_links and validates/re-attaches that
profile's primary session. An injected or AppKit-connected phone account is a candidate to link,
not automatic primary. Expired auth retains drafts but blocks ledger writes and intent acceptance.

## Required regression cases

Offline harvest/plant/stamp cannot enter an action outbox. Two-device same-plot planting rejects one.
Conflict resolution cannot edit balances, primary roles, accepted payloads, or delivery identities.
Duplicate acceptance burns one stamp across any number of destinations, retries, and devices.
Sync export contains no cookies, WC pairing/session material, OAuth tokens, or raw login credentials.
Resume with a different injected wallet preserves the profile and requires explicit linking/rotation.
WoodAmp restoration never creates rewards or starts playback without the required user gesture.
