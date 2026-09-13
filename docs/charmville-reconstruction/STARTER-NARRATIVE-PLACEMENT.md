# Starter narrative and placement

2026-09-13 source audit. This document does not select an unviewed map or claim new story content is implemented. The immediate goal is a welcoming, legible first session in the existing art style. A remaster is not a prerequisite for public play.

## Current hard constraints

`scripts/charmville/zquest/Homestead.zs` couples the starter clearing to dmap 4, source screen 63. Its three bed anchors are source-local x=24/56/88, y=88. The native hero placement is x=16,y=72 facing down, plus the loaded region's screen-63 offset. Bed feet sit at y=104; crop drawing changes layers against the hero's feet. These are spatial contracts, not freely movable decoration.

The clearing copies source combo 105 into columns 1–6, rows 4–6 across applicable meadow layers. It waits for temporary layer pointers before marking the clearing ready. A replacement map must have explicitly reviewed ground, tree canopy, obstruction and collision layers; combo 105 is not a universal soil tile. Root's visual review must select the actual welcoming location before these anchors change.

Native placement currently happens after a position observation is written. `position-observer.js` now conceals standalone joined-world arrival until it observes the authored source-local x=16,y=72 placement. Changing the spawn requires changing this observer contract or, preferably, replacing it with an explicit run-bound native placement receipt. Embedded account play still requires an authoritative correction acknowledgment. Never expose the earlier source-quest spawn while preparing the starter scene.

Account placement and peers currently admit only dmap 4 screens 62/63. `lib/charmville/native-topology.ts` records that subset. Server resources still use the meadow geometry and three beds. Moving the story to an attractive unrelated screen without updating geometry, admission, resource anchors and reciprocal travel would recreate visual/server disagreement.

## What the opening currently says

The native opening is two pages: “Welcome to the meadow! / Start small. Grow together.” followed by “Till, plant, water, harvest.” Account mode then says “Harvest Oran into your satchel”; local mode says “First crop opens guest play.” Movement and A/B are suppressed while these pages are active. E, Extra3 or the browser's context/sequence/expected-page request advances them. Browser tutorial completion is presentation completion, not proof of a harvest or authority to unlock home visitors.

There are no mother/father scenes in this inspected narrative. Existing Oran crops must not be relabeled Burning Hearts while retaining Oran custody or yield. The local guest-play promise must not be presented as an authenticated multiplayer unlock.

## Approved direction: a gift that grows

The first important object should be a Burning Heart seed handed down from the player's mother and father. The first crop teaches that ordinary affection can be abundant through care: grow Burning Hearts, collect them into the account satchel, then use one as a love reaction. More demanding charms can later embody greater time, difficulty or creativity. This does not promise fixed market value or limitless issuance.

Suggested concise dialogue, pending actual character art and placement review:

- Parent: “These seeds came from our first garden. Now they're yours.”
- Parent: “Give them a little water. See what grows.”
- After harvest: “A little love, grown by you.”
- Social introduction: “Share a heart with someone you care about.”

Use two short lines at a time, a clearly identified speaker and one Continue/Back convention. Do not cover the planting space with the dialogue. Character portraits must use inspected, appropriate artwork; a text speaker label is preferable to unrelated sprites pretending to be family.

## Concrete staging

1. **Arrival:** show a calm loading state until the native placement and, in account mode, admission agree. Reveal the player beside a clearly bounded soil bed. Keep hostile encounters and combat effects out of the first interaction lane through explicit encounter scheduling, not by hiding dangerous entities under art.
2. **Family gift:** show the parent interaction and inventory receipt only after an idempotent server grant commits. Returning accounts see the acknowledged result rather than receiving another grant. Guest visitors cannot claim the owner's starter allocation.
3. **One complete growing cycle:** point to one available bed, face it, till, plant, water and harvest. Each action retains anticipation, tool contact, result and recovery. The selected bed and visible soil/crop stages must match the committed resource state. Keep the other beds available rather than making one invisible mandatory hotspot.
4. **Satchel:** open the existing illustrated item view on the actual new charm, with count and intended use. Clearly distinguish carried equipment, produce and social charm custody. No duplicate balance merely because the same identity appears in different menus.
5. **First social use:** offer a player-chosen recipient or post. Explicit confirmation performs the real reaction transaction; cancelling keeps the charm. Do not auto-post or consume a charm merely for finishing dialogue.
6. **Explore together:** show the visible exit toward the reviewed public route and a separate friend-visit option. Explain access only when needed. A friend can arrive without resetting the owner's tutorial, crop timers or story state. Failed admission leaves the player safely at the original location.

## Fail-safe onboarding

Every stage needs a persisted, versioned checkpoint tied to the account. Replay should resume the next unfinished action; animation interruption must not duplicate grants or erase committed yields. Tutorial page completion alone must not stand in for gameplay progress.

Loading failure offers retry without manipulating coordinates. Reload before gift acknowledgment queries the original receipt. Inventory-full or unavailable-bed states provide a concrete alternative. Lost connection stops account actions and preserves the last confirmed state; never silently continue into local inventory. An expired visit grant returns an actionable access message without stranding progression.

Keyboard, touch and controller must share one Interact/Confirm and one Back/Cancel contract. Do not require typing or wallet signing to finish this opening. Maintain readable text, stable focus and a return-to-play action. A skipped introduction must not skip server eligibility or grant validation.

## Safe next implementation

First add an explicit native `arrival-ready` receipt containing the current action-run generation and confirmed source placement, emitted only after clearing/placement succeeds. Update the observer to consume that receipt instead of matching exact coordinates. Verify stale receipts cannot reveal a new run and account acknowledgment remains mandatory. This is a small reliability improvement that does not select a new map, alter economic authority or require new art.

Then implement Burning Heart as a distinct server crop/charm identity with a one-time starter receipt and transactionally consistent growth, harvest and reaction use. Only after that chain works should the introductory copy change from Oran to Burning Heart. Root's visual map review determines the location and art; geometry and anchor changes must travel together.

Acceptance: a fresh account arrives once, receives one gift, visibly completes one crop cycle, sees exactly the committed satchel yield, can cancel or confirm one social use, and reaches the public route or a permitted friend's home. Reload and lost responses at every checkpoint preserve that result. A returning account and a visiting friend must not restart or duplicate it.
