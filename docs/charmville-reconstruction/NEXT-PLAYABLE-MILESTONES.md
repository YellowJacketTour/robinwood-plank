# Next connected playable milestones

Planning checkpoint: 2026-09-12. This is an implementation and acceptance sequence, not a claim of completed features. Read `VERIFIED-PROGRESS.md` for the current evidence. No completion percentages are inferred from source files, compilation or catalogs.

The target is one account-owned world, not separate farming, creature and social demos. Continue in the retained browser playtest. Use synthetic local accounts and simulated wallet presentation only: no seed phrases, private keys, transaction signing or real funds.

## Dependencies and parallel ownership

1. **Navigation and arrival** unblock a reliable first-hour journey.
2. **Burning Heart custody and art** can progress beside navigation; both must land before the family introduction can be accepted.
3. **Encounter authority and creature presentation** can progress together against one agreed action/state contract; shared combat waits for both.
4. **Creator preview and validation** can develop beside these features, initially consuming the actual shipped crop and companion assets. Publishing waits for a working adapter and rollback.

One owner integrates each shared contract before dependent adapters change. Keep independently reviewable commits; do not let parallel edits invent different item IDs, input meanings, coordinate spaces or settlement rules.

## 1. One coherent first hour

**Player outcome:** arrive at an actual private homestead, learn movement and interaction, inherit a first crop, tend it, choose a companion, give a harvested charm, and travel into the shared meadow. Returning home preserves everything earned.

**Build:**

- Author distinct home exterior/interior and public meadow geography, with explicit exits, admitted spawn points and walkable collision. Region labels alone do not constitute separate maps.
- Persist a resumable tutorial state machine. Every step names the committed accomplishment that advances it; narrative acknowledgement is separate from economic entitlement.
- Present one menu contract across Party, Equipment, Satchel, Map and social giving: selection, details, contextual action, feedback and return. Preserve focus and stop world input while navigating; multiplayer itself remains live.
- Give tools real directional anticipation/contact/recovery and visible soil demarcation. Teach one context action without concealing advanced equipment controls.
- Make failures actionable: no connection, blocked travel, unavailable item, loading and interrupted action must leave the player able to retry or return.

**Acceptance:** finish from a fresh synthetic account without developer commands or quest-selection screens. Reload after inheritance, planting and travel; resume at the correct step with no duplicate grant. Walk home → public meadow → permitted friend's home → home with safe arrivals. Denied visitors cannot mutate private beds. Verify keyboard, touch and gamepad focus/back behavior independently. Record the actual journey in the retained browser; an introduction screenshot is not movement evidence.

## 2. Burning Heart from family crop to social gift

**Depends on:** persisted crop identity exists for Oran; new item support, supply rules and artwork remain required. `BURNING-HEART-CATALOG-CONTRACT.md` contains historical pre-migration descriptions; migration 129 supersedes those identity gaps, not the missing Heart implementation.

**Build:**

- Define the live `burning-heart` ledger capability and its separate discovery binding to `emoji:2764-fe0f-200d-1f525`. Keep seeds, harvested goods, discovery records and health containers distinct.
- Specify and version initial seed entitlement, growth duration, yield and renewal source before issuance. These are explicit balance decisions, not values inferred from emoji rarity.
- Author seed, sprout, growth, bloom, ripe, pickup and gift art with consistent anchors and source provenance. Preserve Oran healing, beds and pending actions.
- Commit gifting as one authorized sender debit and recipient credit with a replay-safe receipt. Show the same balance in Satchel and social composition. Animate success only after settlement; reusable expression is separate from transferring goods.

**Acceptance:** two local identities plant, harvest, gift and reconnect with conserved balances. Repeated requests, concurrent spend, insufficient inventory and disconnect after commit cannot duplicate or lose units. Repeat the existing Oran lifecycle and heal action. Confirm social activity cannot mint Heart or Grain through reciprocal gifting. Record both economic evidence and visible four-direction crop/tool acceptance.

## 3. One shared creature expedition

**Player outcome:** a six-member test party follows through terrain; two players and their companions engage one wild creature; either player can enter staged command presentation without resetting its state; one valid capture or defeat settles once.

**Build:**

- Make region authority own target identity, HP, statuses, action timing, resource consumption and encounter revision. Native local hit effects must not masquerade as committed multiplayer damage.
- Bind world and staged views to that same encounter. Presentation coordinates are separate from world ground position, floor and visual elevation.
- Implement one complete move family and one capture-ball type before broadening the catalog. Require directional origins, contact windows, target eligibility, collision clipping, interruption and recovery.
- Carry all six individually selected followers through obstacles and warps. Formation and attack/defend/follow commands need clear selection scope and acknowledged state. Missing species animation bindings remain explicit gaps.
- Define competing-party rights before enabling contention: contribution eligibility, capture reservation/expiry, support attribution and defeat allocation. Unpartied observers receive no automatic personal copy; eligible party members each receive their allocated outcome, which may contain money, items, both or neither. Companions are not additional players for loot.

**Acceptance:** two independently authenticated clients see the same HP/status revision and capture owner after reconnect. World → staged → world cannot heal or clone a target. Duplicate contacts and capture retries settle once. Test solo, friendly party and competing parties; PvP remains unavailable until explicit opt-in rules exist. Capture adds exactly one owned instance and updates discovery. Verify followers, projectiles, wall impacts, canopy overlap and interrupted attacks in actual motion, not just service tests.

## 4. Creator packs that improve the real game

**Depends on:** an actual renderer adapter and accepted reference scenes. The existing schema/validator does not import or publish content.

**Build:**

- Extend the versioned contract where needed for body/tool/shield composition, attachment sockets, sound and projection. Do not reinterpret existing frame fields silently.
- Build a preview using the same renderer as gameplay: all directions, supported poses, ground/foreground layers, collision overlays and bright/dark backgrounds.
- Add reviewable immutable revisions, provenance and rights records, dependency hashes, resource limits, publish permissions and rollback. Isolate unsupported executable content.
- Let themes alter approved frames, palette and decorative presentation while keeping controls legible, selection visible, hostile telegraphs readable and custody/rarity truthful.

**Acceptance:** replace one crop pack and one interface theme in preview, reject malformed/missing assets clearly, publish an approved revision, reconnect, then roll back presentation without rolling back inventory or encounter state. A second creator can propose changes without silently overwriting the first. No default fallback should display an unrelated atlas tile.

## Expansion after the connected loop

Carry the same authority, identity, animation and navigation contracts into profession → crafting → market chains; breeding and livestock; civic construction and utilities; raids and factions; shipping and space travel. Each addition must specify acquisition, transformation, consumption, ownership, multiplayer rights and artwork before it is counted as playable. Larger populations require measured region simulation, interest management and recovery evidence, not a promise of unlimited players or zero latency.

## Evidence required to close a milestone

Record changed paths, visible player outcome, focused correctness checks, known limitations and exact runtime/content revision. Use the same retained pilot instance for primary observations; multiplayer proof still requires an independent client identity. Run focused checks after meaningful integration, then repository release checks before shipping. Code correctness, art acceptance, navigation, shared state and device performance are separate gates; passing one does not close the others.
