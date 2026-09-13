# Burning Heart implementation plan

2026-09-12 — source audit and proposed implementation, not implemented gameplay. This supersedes the older catalog contract's statement that beds have no crop identity: migration 129 and `native-crops.ts` now persist Oran identity, but still reject Burning Heart. No balances, migrations, code or artwork were changed for this plan.

## Player outcome and identity

The player receives an inherited seed packet in their own homestead, plants a visibly different heart flower, waters it, harvests Burning Hearts, and gives one to a friend. Both players see the same committed quantity in game and on PlankSpace after reconnect. Replaying the family introduction cannot issue another packet.

Keep `burning-heart` as an authored commodity ID, connected to discovery ID `emoji:2764-fe0f-200d-1f525` (❤️‍🔥). Seed and harvested charm use separate existing balance tables. A crop is a production process; its flower sprite, held pickup, Satchel icon, social SVG and animated sticker are representations of the same authored identity, not additional balances. The commodity is fungible initially; transfer receipts establish provenance at transaction level, not individually serialized heart ownership. Future unique crafted relics need instance custody separately.

## Exact source changes

| File | Required change and boundary |
| --- | --- |
| `lib/charmville/native-crops.ts` | Add a versioned Burning Heart definition with explicit seed/produce IDs, duration, yield, capability and art binding. Keep `DEFAULT_NATIVE_CROP_ID` Oran for backward compatibility; changing the global default would misdirect the existing automatic seed grant. |
| `lib/charmville/native-resources.ts` | Add explicit crop selection when planting a stage-1 bed; validate against unlocked crop definitions. Include crop selection in the begin fingerprint and pending action. At contact, revalidate bed revision, selected crop, entitlement and seed balance; atomically set crop identity, debit seed, and commit. Preserve old Oran payload hashes and in-flight retries. Read balances by crop, not the current single `face`; allowed actions must use each selected crop's seeds. |
| New `lib/charmville/family-opening.ts` and authenticated route | Explicit story entitlement command, not a read-side grant. Validate own homestead and expected opening step. Atomically insert unique entitlement and add its fixed seed allotment. Replay returns original receipt. Completing `tutorialPreference` is user-editable and must never authorize supply. |
| `lib/charmville/native-resource-client.ts` | Projection currently drops `cropId`; retain a validated render identity per bed and crop-specific balances. Pass selected crop to begin only; quantities, duration and rewards remain server-owned. Preserve receipt reuse on uncertain commits. |
| `scripts/charmville/resource-bridge.js` | Extend the native file protocol with version/crop codes and per-crop counts. Preserve existing indices or explicitly negotiate protocol versions; never infer crop from current toolbar selection. |
| `scripts/charmville/zquest/Homestead.zs` | Replace hardcoded Oran status text and berry-only bitmap draw selection with validated crop render definitions. Keep soil anchored to its region; seed/sprout/leaf/bloom/ripe/harvest effects need individual art and direction-aware hand placement. Unknown crop support must fail closed rather than draw Oran. |
| `lib/charmville/content-manifest.json`, content publication tooling, `lib/charmville/content.ts` | Publish provenance-tracked, immutable seed packet, growth stages, pickup, static and animated expression assets. Do not mark generated Unicode catalog coverage playable merely because an asset exists. |
| New `lib/charmville/gifts.ts` and `app/api/charmville/gifts/route.ts` | Atomic existing-balance transfer, described below. Follow authenticated, bounded payload, same-origin and no-store conventions in world resource routes. No wallet signature or chain transaction. |
| `lib/charmville/inventory.ts` and Satchel consumers | Existing compartments are projections, which should remain true. Add authored name/art/action resolution and a Give action for giftable stacks. Do not create a second social wallet. |
| `app/charmville/world/first-steps.tsx` and saved progression readers | New milestones require explicit entitlement, committed Burning Heart action receipts and a committed outgoing gift. Existing Oran harvest must not satisfy the heart lesson. Allow tutorial replay without entitlement replay. |
| `lib/charmville/store.ts`, `lib/charmville/reputation.ts`, `lib/charmville/reputation-store.ts` | Existing post stamping burns Stalk and records a stamp; it is not a recipient transfer. Leave this historical behavior intact until a separately defined Burning Heart reaction command exists. Gift ownership alone must not mint reputation. |
| `lib/charmville/exchange.ts` | Add to exchange only at a separate readiness gate; giftability is not sufficient. Current fixed-price offers are not a live order book or AMM. No automatic Grain mint, redemption floor or guaranteed sale. |

## Schema work and deployment blockers

Add a new migration after the actual highest current migration; do not modify 104, 114 or 129. Validate constraint names from PostgreSQL before execution.

1. Extend `charmville_seeds.face_id` and `charmville_stacks.face_id` checks to include `burning-heart`. Preserve all existing values. Keep offers unchanged until exchange support exists.
2. Extend crop checks on `charmville_native_resources.crop_id` and `charmville_native_actions.crop_id`. Preserve Oran defaults and existing rows. Crop selection needs pending action identity distinct from the current empty bed identity: compare captured old bed revision, then apply selected identity at committed planting. The current strict `bed.crop_id === action.crop_id` check must be adjusted specifically for planting, not removed for growing/harvesting actions.
3. Add family entitlements keyed by `(profile_id, entitlement_id)` with definition revision, granted seed face/quantity, committed timestamp and immutable result. Do not reuse `charmville_native_seed_grants`: its one row per profile currently means three Oran seeds and is automatically inserted during resource reads.
4. Add gift receipts: UUID ID; authenticated sender and approved recipient profile FKs; request UUID; canonical payload SHA-256; face ID; positive bounded BIGINT quantity; timestamp; immutable JSON result; `UNIQUE(sender_profile_id, request_id)`; sender differs from recipient. This is an audit of changes to existing stacks, not a balance table.
5. A recipient stack references `charmville_yards`. For the first implementation require an existing game inventory account; give an actionable unavailable result before spending when absent. Do not invoke legacy garden claim or issue its starter goods as a side effect of receiving a gift. A later inventory-account split requires its own migration.

Important rolling-release limitation: additive columns/checks make the schema readable by old code, but old native resource code throws on a Burning Heart bed and old clients cannot render it. Keep heart planting disabled until all active writers/renderers have negotiated support; retain a deployment feature flag that blocks new issuance. An application rollback cannot erase live heart balances or convert beds to Oran. Ship an old-client upgrade gate/read-only view or a compatible previous release before enabling supply.

## Atomic gift transaction

Accept only request ID, recipient handle, `burning-heart` and a whole decimal quantity string. Reject extra fields, malformed handles, quantities outside 1–999, missing approved profiles and self-gifts. Resolve the recipient to immutable profile ID; canonicalize the receipt around that resolved ID, not display text. Require stable intended-recipient identity on retry so a renamed/reassigned handle cannot redirect a request.

Within one transaction: authenticate via `homeActor`; acquire both profile locks in ascending numeric ID order as `exchangeCommand` does; recheck both profiles' eligibility; check prior receipt/fingerprint; require inventory rows; debit with `UPDATE ... qty >= amount RETURNING`; credit with `INSERT ... ON CONFLICT ... qty + EXCLUDED.qty`; insert receipt; commit. A changed fingerprint for a used request ID is a conflict. Retry the same ID after uncertainty. An error rolls back both movements. Simultaneous gifts and exchange spends still use conditional stack updates so balances cannot become negative. Review cross-feature lock ordering before adding any pre-lock of stack rows.

Giving transfers custody: sender loses N and recipient receives N; global quantity changes by zero. It does not create Grain, XP, reputation or replacement seeds. The gift animation runs only after confirmed commit; notification delivery may retry but cannot reapply transfer. Add an outbox if durable notification delivery is needed. Block/allow-list delivery policy must be enforced server-side before debit; profile video permissions are unrelated to gifting permissions.

## Draft production decisions for the first playable release

These are recommended initial parameters for implementation and playtesting, not measurements or already accepted balancing facts.

| Parameter | Proposed decision | Reason |
| --- | --- | --- |
| Inherited packet | 3 seeds once per approved profile | Uses three existing beds; one entitlement independent of number of wallets or tutorial replays. |
| Normal watered growth | 5 minutes | First crop can mature while exploring and learning tools; no paid acceleration. |
| Tutorial crop | Same duration and yield | Avoids a hidden accelerated faucet or special crop exploit. |
| Harvest | 3 Burning Hearts plus exactly 1 replacement seed | Renewability without exponential seed growth. Three continuously tended beds produce at most 108 hearts/hour before action/travel time. This is an upper bound, not a target of real human play. |
| Unwatered state | No growth until first watering | Clear two-action cause/effect; no required repeated attendance. |
| Ripe state | No rot in opening release | Returning players keep their earned crop; supply still requires committed harvest/replant. |
| Fertilizer and soil tiers | Disabled for hearts initially | Need sink/input budgets and different art before multiplying production. |
| Gift | 1–999 existing hearts per committed transfer | Conserves supply; simple quantity UI. |
| Social reaction | Separate future explicit sink or escrow design | A transferable gift is not a sink. Never count it as supply removal. |
| Exchange | Locked until supply telemetry and reaction sink exist | Prevents presenting prices or liquidity that have not been established. |

Finite production rate does not imply finite lifetime supply. At this draft rate, perpetual harvesting grows total stock without bound unless hearts are consumed or permanently retired. Track daily issuance, unique active producers, transfer velocity, inventory age and consumptive use before changing duration/yield. Multi-account farming remains an economic threat even with one entitlement per profile; time gates alone are not cheat prevention. No monotonic increase in market price or guaranteed positive return can be promised.

## Acceptance gates

- Real two-account homestead-to-gift journey, reconnect both accounts, identical durable balances and receipt; mobile/gamepad navigation uses the same commands.
- Duplicate entitlement requests, introduction replay and additional linked wallets do not issue more seeds.
- Two harvest commits for one bed revision produce once; gift/market concurrent spends cannot overdraw; uncertain gift response retries once; changed request payload fails; reciprocal concurrent gifts do not deadlock.
- Old Oran grant, pending action replay, harvest and healing remain unchanged. An Oran crop cannot change species while growing.
- Each crop stage is visibly distinct, layered correctly behind/in front of actor feet, does not move during map travel, and displays the correct held pickup in all directions.
- Gift animation and Satchel count follow server outcome; denied recipients and failed requests never show completed delivery. The recipient sees existing custody, not an additional catalog grant.
- Record status per gate as implemented / tested / visually verified. This document alone satisfies none of the gameplay gates.
