# Burning Heart: catalog identity and integration boundary

Checkpoint: 2026-09-12. This document records the requested family-inherited first crop and social gift as a **planned gameplay definition**. This checkpoint adds documentation only. It does not grant seeds, grow hearts, transfer gifts, change Oran Berry behavior, or implement family history.

## Identity foundation already present

The pinned Unicode discovery catalog already contains `emoji:2764-fe0f-200d-1f525`, glyph ❤️‍🔥, named “heart on fire,” under Smileys & Emotion / heart. Its gameplay and art statuses are both `unmapped`. See `public/charmville/catalog/emoji-catalog.json:1856` and its generator, `scripts/charmville/build-emoji-catalog.mjs`. Preserve this sequence identity and source metadata; do not hand-edit generated Unicode data to imply playable coverage.

The proposed authored Charmville definition is `burning-heart`, display name **Burning Heart**, linked to that Unicode entry as its expression representation. This proposed ID is not currently a valid ledger face. A Unicode entry, source-art identifier, seed balance and harvested item are distinct concepts. A future registry should connect them explicitly rather than renaming Oran Berry or equating every heart glyph with a commodity.

The requested opening gives Burning Heart seeds through an inherited family story, then teaches planting, care, harvest and giving the harvested charm to another person. “Family-inherited” describes the authored opening; it does not assert a real user's ancestry or establish a working player-family system. Growth durations, seed allotment, yield, renewal policy and gift treatment remain unspecified. Do not manufacture economic numbers from the emoji.

## Existing integration points

| Concern | Current source and behavior | Work required for Burning Heart |
| --- | --- | --- |
| Discovery | `public/charmville/catalog/emoji-catalog.json:1856` already has the exact sequence; generator marks entries unmapped | Add a reviewed authored-definition binding separately from generated Unicode source data |
| Asset identity | `lib/charmville/content.ts` resolves the immutable manifest; `lib/charmville/content-manifest.json` references existing crop and face assets | Author and verify seed, sprout, growth, bloom, ripe and harvested art with provenance; publish through existing content tooling |
| Imported reference charms | `public/charmville/library/charms.json` is a namespaced testnet reference snapshot | Do not turn its source records into account balances or silently alias them to Burning Heart |
| Native farm authority | `lib/charmville/native-resources.ts:6` hardcodes `oran-berry`; one-time seed grant, validated timed actions and harvest settle against profile inventory | Persist a crop definition on each bed/action and resolve it server-side; keep existing Oran beds, grants and pending actions compatible |
| Storage limits | `deploy/inmotion/postgres/migrations/126_charmville_native_resources.sql:1` enumerates permitted seed/stack/offer IDs; native beds contain no crop identity | Add an append-only migration with explicit compatibility/backfill rules before any new live item can be written |
| Inventory view | `lib/charmville/inventory.ts` projects `charmville_seeds` and `charmville_stacks` into gameplay/satchel compartments | Reuse the same profile ledger; a social gift must never create a parallel inventory |
| Existing social action | `lib/charmville/store.ts:140` debits one Stalk for a post stamp, with a receipt and stamp row at lines 191–194 | Define direct gifting separately: recipient, authorization, atomic debit/credit, replay behavior and receipt; a post stamp is not a recipient inventory credit |
| Reputation | `lib/charmville/reputation.ts:2` enumerates seven legacy faces; `reputation-store.ts` reads accepted stamp history | Decide explicitly whether gifting affects reputation; never derive accepted reaction history from inventory ownership |
| Exchange | `lib/charmville/exchange.ts:6` enumerates eight tradable faces including Oran | Enable only after valid ledger support and reviewed rules; giftability does not automatically imply market eligibility |
| Health | `lib/charmville/creature-vitals.ts` consumes `oran-berry` for healing | Preserve this item and effect; Burning Heart is not an Oran alias or replacement |

Historical garden constraints in `deploy/inmotion/postgres/migrations/116_charmville_soil.sql` and the Stalk/Splinter branch of `lib/charmville/store.ts` are additional integration constraints, not a reason to resurrect the retired garden presentation. The product remains one world and one inventory.

## Next bounded implementation

First define a reviewed authored catalog contract that distinguishes discovery, planned definitions and live capabilities. Bind Burning Heart to the existing Unicode identity, with explicit unavailable gameplay/art status until consumers actually support it. Avoid an unreferenced module whose exported constants look like working crop support.

Then migrate native resource identity and add the server-owned family opening entitlement using the existing profile, transaction and replay conventions. Specify a source budget and renewal rule before granting or harvesting any new supply. Existing Oran entitlement must not become a second automatic Burning Heart grant by accident. No Grain issuance is part of this concept.

Implement gifting as a single committed transfer of existing harvested units with recipient checks and a durable receipt. A failed or replayed gift must neither duplicate the recipient credit nor lose the sender debit. Keep the same balance visible in the world and social context after reconnecting. Gift animation and social copy should follow that committed outcome.

## Acceptance evidence still required

Use two authenticated accounts: complete the family opening once, reconnect without receiving another grant, plant and harvest a Burning Heart from a bed with persisted definition identity, send it to the other account, and verify matching durable balances after reconnecting both accounts. Exercise replay and insufficient balance, concurrent gift/spend, changed bed revision, and existing Oran plant/harvest/heal compatibility. Confirm the catalog accurately distinguishes the enabled item from other unmapped emoji. Review actual crop-stage art and gift presentation in the unified world.

Verification for this checkpoint was limited to inspecting the referenced source, confirming the exact Unicode catalog entry and storage/action constraints, and checking documentation whitespace. No live Burning Heart behavior was tested or claimed.
