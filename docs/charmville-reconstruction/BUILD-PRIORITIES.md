# Build priorities: one connected Charmville

Audit date: 2026-09-12. This is a dependency-led execution map of the user's full vision, based on current source reads and existing checkpoint records. It is not release certification. No tests or live play were performed for this audit, and no completion percentages are inferred. Other workers are changing code concurrently; their recorded integration evidence supersedes this snapshot.

## Product decision

The priority is a playable, account-owned continuous journey: family homestead → cultivated Burning Heart → companion → public expedition → useful loot/craft → exchange/social gift → friends' homes. Every subsequent dungeon, city, faction, farm, space route and creator world extends those same identity, action, custody and presentation rules. The retired garden, a source quest launcher, a streaming preview and a thousand catalog cards cannot each stand in for that journey.

The target remains [USER-INTENT](USER-INTENT.md) and [WORLD-MASTER-SPEC](WORLD-MASTER-SPEC.md). Working region names are replaceable. Stable content IDs and ownership semantics are not casual naming choices. The user explicitly wants the inherited Burning Heart to make ordinary love/like expression abundant through cultivation; it is distinct from health containers, currency, seed inventory and discovery metadata.

## Current evidence that changes the priority

- `lib/charmville/tutorial.ts` persists one `completed` presentation preference. This is not an accomplishment-based tutorial with resumable inheritance, planting, harvest, friendship and expedition steps.
- `lib/charmville/native-world.ts` registers two physical maps, d4/s62 and d4/s63. `native-atlas.ts` assembles their logical atlas. Neither proves a continuous authored home/town/world camera. Account region admission and physical geography are separate concerns.
- `lib/charmville/native-crops.ts` permits only `oran-berry`, currently with a 30-second growth time, one produce and one returned seed. A registry entry for every emoji has not been implemented. These test-oriented quantities are not an accepted full economic balance.
- `lib/charmville/inventory.ts` currently projects seeds into gameplay, faces into Satchel and Grain into currency. Complete tools, equipment, physical materials, unique gear, social expressions and recipe conversions need a richer definition/custody contract before this UI distinction is sufficient.
- `lib/charmville/test-party.ts` can provision diagnostic companions only for an uncustomized starter account. Its refusal to overwrite a customized party protects ownership; testing six members requires a suitable synthetic identity, not bypassing that check.
- `lib/charmville/beam-domain.ts` explicitly calls itself unwired and emits no damage or native animation. A domain primitive is not a playable Kamehameha or transformation.
- `lib/charmville/native-actor.ts` currently returns at most 16 peers. Socket checkpoint evidence describes bounded local transport, not population-scale regional simulation.
- `scripts/charmville/gameplay-video.mjs` mounts a local canvas-video monitor; the runtime server allowlist includes its modules. The monitor explicitly does not broadcast. Spectator policy storage is separate from a running media transport. Actual profile footage and theatres remain integration work.

Historical test/visual findings are preserved in [ACTIVE-CHANNELS](ACTIVE-CHANNELS.md), [VERIFIED-PROGRESS](VERIFIED-PROGRESS.md) and [REQUIREMENT-COVERAGE-AUDIT](REQUIREMENT-COVERAGE-AUDIT.md). A historic pass is not a fresh acceptance of the current working tree.

## Dependency matrix and parallel work boundaries

Priority means integration order, not deletion of later scope. Each row must pass code correctness, visible experience and applicable multiplayer gates separately.

| Priority / channel | Concrete next integrated build | Existing starting point | Dependency and acceptance |
|---|---|---|---|
| P0: Arrival and first hour | Durable tutorial accomplishments driven by committed actions; authored family home/interior and public clearing; no guest quest intro | `tutorial.ts`, `home-access-store.ts`, `native-actor.ts`, `FIRST-PLAYER-WORLD-CONTRACT.md` | Fresh account immediately controls the hero, inherits once, plants and returns after reload at the right narrative step. Skipping speech never grants or erases rewards. Safe spawn cannot visibly teleport after opening. |
| P0: World continuity | One stable world coordinate/topology contract for ground, elevation, instances, chunk placement and border arrivals; then native camera adapter | `native-world.ts`, `native-atlas.ts`, `native-movement-client.ts`, `PERSISTENT-WORLD-CONTINUITY.md` | Walk home → public → authorized friend's home → home; crops stay fixed in world space while camera moves; followers/peers cross with correct anchors. Verify actual motion and reconnect. Do not equate two source screens with complete world unification. |
| P0: Common action authority | Shared action ID, start/contact/recovery/cancel state and idempotent settlement for tools, weapons and creatures | `native-action-domain.ts`, `native-resources.ts`, `native-contact-observer.ts`, settlement contracts | One action produces one authorized effect despite retries or lost acknowledgments. Wrong range, wrong tool, changed permissions and interrupted actions do not issue rewards. World, battle and social adapters consume receipts, not client-earned values. |
| P0: Burning Heart and custody | Versioned seed entitlement, production/renewal bounds, staged crop art and atomic social gift | Oran registry/migration 129, inventory/store, `BURNING-HEART-CATALOG-CONTRACT.md` | Two accounts cultivate, transfer and reload with exact conservation. Gift is sender debit plus recipient credit; repeat reactions cannot mint. A reusable visual reaction is explicitly distinguished from spending/transferring a charm. Preserve Oran use/healing. |
| P0: Party and hybrid combat | Six independent followers; explicit selection/formation/command scope; one target HP/status/capture identity across action and staged views | `companions.ts`, `creature-roster.ts`, `encounters.ts`, `turn-battle.ts`, `capture.ts`, bridges | Solo and two-client party observe the same target revision. Switching views cannot reset health/status or duplicate capture. Six creatures visibly follow through turns/occlusion/travel. One complete directional move and ball precede wider move catalog. |
| P0: Visual/menu/input continuity | One authored Charmdex shell and interaction grammar for Party, gear, inventory, Satchel, map, quests, market, friends and social | Existing world panels, runtime shell, source UI references, `PARTY-AND-UNIFIED-MENU.md` | Each view has illustrated background/frame, legible selected state, contextual actions, clear empty/loading/error states and predictable back/focus. Verify keyboard hold, real touch and gamepad; fullscreen/resizing/zoom preserve target selection and input. No competing browser-like navigation layers. |
| P1: Professions and domestic breadth | Forestry/mining/fishing → cooking/smithing/carpentry → useful tool/building/market output; crop/soil suitability, compost, orchards | `native-resources.ts`, `content.ts`, farming and action-art contracts | Every stage is a saved, visible directional action with tool contact and depletion/regrowth. Skill gates affect actual equipment or recipes. Construction updates authoritative collision. Owner/helper/visitor rights stay separate. |
| P1: Loot, economy and progression | Definition/family/variant/stack/unique-instance model; eligible party loot; exact recipes, supply budgets and ledger reconciliation | `exchange.ts`, `inventory.ts`, `defeat-experience.ts`, `FINITE-GRAIN-RESERVE.md` | Unpartied bystanders do not each receive personal copies; eligible party members each receive a resolved allocation, which can contain money/items/both/neither. Companions do not multiply player entitlements. Every issuance/destruction has a budget/reason; money trades transfer existing supply. |
| P1: Social identity and communication | In-game feed, Pine/Lumberyard, gift/reaction, intentional posting, voice note/playback and party chat; safe account linking | account modules, existing PlankSpace composer, `VOICE-ATTACHMENTS.md` | Same account/inventory everywhere; posts/reactions have clear confirmation and committed feedback; menu viewing does not issue assets. Wallet features remain simulated for current pilot. Microphone access and broadcasting are explicit user actions, never implied by public profile status. |
| P1: Real footage and spectators | Local source verification → authenticated publisher/viewer transport → profile player → shared theatre | `gameplay-capture.mjs`, `gameplay-video.mjs`, spectator policy/store, `LIVE-GAMEPLAY-STREAMING.md` | Independent viewer sees actual current gameplay video, not a coordinate map. Private/allowlist changes revoke active viewing; theatre never widens source permissions. No desktop/mic fallback. Measure capture overhead and end-to-end latency; local preview is only source acceptance. |
| P1: Multiplayer release and scale | Regional simulation owner, spatial subscriptions, sequence/durable recovery, overload controls and externally reachable synthetic playtest | world socket client/gateway and region projection | Two independent players first; then measured device/network/load tiers. Report p95/p99 tick, latency, bandwidth and reconnect behavior. A transport choice or consensus proposal cannot replace anti-cheat authority, identity checks and measured recovery. |
| P2: Livestock and creature depth | Husbandry, grazing, habitats, feed/produce, breeding, evolutions, care, storage/clinic and work behaviors | species stats/growth, creature policy/vitals/rest, habitat contracts | Same owned creature throughout forms/assignments. Offspring consumes bounded time/feed/capacity and issuance budget. Species lore drives behavior/art only where actual directional sets exist; missing frames remain authoring tasks. |
| P2: Cooperative combat scale | Raid threat/support, buffs/debuffs, telegraphs, joint staged scenes, contested capture and faction/PvP policy | battle assist, raid/hybrid/multiplayer contracts | Solo, allies, competing parties and explicitly enabled PvP are separate policies. Support counts transparently. Capture reservation expires safely. Neutral homes remain safe; friendly fire never appears by accident. Rewards settle once per eligible player/encounter. |
| P2: Civilization and industry | Public works, roads/utilities, storage/logistics, contracts, guilds, civic ecology and disasters | world master spec, travel/civic design | Contributions escrow under disclosed terms; permissioned completed structures change navigation/utilities. Common goods retain demand through real uses. Disaster visuals correspond to recoverable shared state, not arbitrary asset deletion. |
| P2: Advanced markets and amusement | Real order book/volume/supply definitions; funded pools and simulation-only derivatives; explicit Game Corner economy | bounded exchange and finite Grain reserve | Partial fill/cancel/retry conserve escrow. Purchases never mint Grain. Pools hold funded reserves; derivative obligations have defined collateral. Amusement budget is explicit, separate and nonredeemable until a complete model is accepted. |
| P2: Travel, space and continuing endgame | Mounts/boats/passengers, sea/sky/space regions, unusual 2D/3D events, exploration and horizontal mastery | `WORLD-MASTER-SPEC.md`, `TRAVEL-GRAPH.md` | Routes have authored destination geometry, admission rules, safe return, passenger failure/reconnect and discovery records. Camera/art transitions preserve world identity. Infinite content is an extensible publishing contract, not a finished finite catalog claim. |
| P1 foundation / P2 publishing: Creators | Same-renderer pack preview, action/frame metadata, curated themes, versioned registry/review/rollback, collaborative proposals | pack validator/schema, `BUILDER-PACK-CONTRACT.md` | Replace an actual crop and theme, review all directions/layers, reject broken dependencies, publish immutable version, reconnect, roll art back without rolling custody back. Untrusted art/scripts cannot change authority or mint rewards. |

## Parallel execution plan

Keep a single integrator for world/action identity contracts. Independent workers can own: (1) tutorial/world readiness and exact geography evidence; (2) economy definition/custody changes; (3) animation/UI/creator coverage on agreed definitions; (4) media and spectator lifecycle. Creature authority becomes a separately owned integration once action and encounter contracts are settled. With fewer available workers, queue bounded tasks rather than pretending every channel is executing continuously.

For each task, establish an exclusive file set, input contract, receipt/state outputs and one observable player result. Do not let two workers redefine facing, screen coordinates, item IDs, loot eligibility or account identity independently. Prefer one complete visible chain over many disconnected endpoints. Preserve working native source fidelity while adapters improve; do not rewrite the renderer without comparing actual reference animation, map continuity, device cost and authoring support.

Immediate integration queue:

1. Verify retained pilot loads the current runtime; record runtime/content revision and actual held movement, open/back focus and border return. Fix observed blocking failures before adding another panel.
2. Implement tutorial accomplishment storage and derive progression from accepted action receipts; separate presentation preference from grants. This provides a real first-hour backbone for all later features.
3. Add Burning Heart definition and finite renewal policy beside Oran, then gift settlement and crop/gift artwork. This is the smallest complete proof of the user's social-game economy thesis.
4. Use a fresh synthetic test account for six unique companions; verify independent toggles, spacing, formation and map return. Bind one wild creature to the same HP/status record in both combat views and settle capture/loot exactly once.
5. Finish the canonical menu states on these real flows, with persistent game context and no dead controls. Validate action art north/south/east/west, contact, cancellation, occlusion, damage and screen transition.
6. In parallel with these player-critical changes, validate local game video and implement authenticated media publication/active revocation. Profile streaming should expose the actual improving game without displacing game continuity work.

## Progress reporting that remains meaningful

Each channel reports **specified → connected code → focused correctness checks → visible solo acceptance → independent multiplayer acceptance → device/performance acceptance → release**. These are evidence states, not seven equally sized percentages. A code module can be complete at its bounded purpose while the product feature is still unaccepted. Record changed paths, exact runtime/content revision, devices/accounts, actual observed outcome and remaining defects.

The historical 113-item work queue is a scope index, not current truth. Its generator can overwrite nuanced evidence with generic queued states; do not regenerate it to fabricate progress. New requests for Burning Heart, real footage, continuous worlds and full six-party action/staged combat must remain explicit acceptance rows even when old bars omit them.

Before shipping, run the repository's required lint, type, test and build gates. During development use focused checks after meaningful integrations and live observations of the same retained primary instance; multiplayer correctness still requires an independent identity/client. No existing assertion of Nintendo quality, broad device performance, unlimited population or zero latency is accepted without corresponding evidence.

## Follow-up: precise first-hour persistence implementation

This follow-up inspected `first-steps.tsx`, `tutorial.ts`, `tutorial-bridge.ts`, `native-resources.ts`, `native-actor.ts`, `world-presence.ts`, `companions.ts`, exchange/use/capture service writes and migrations 104, 109, 114, 124 and 128. Repository README, architecture and contribution rules were read before proposing storage changes. This is a proposal only; no service, UI or migration was edited here.

### Current journal errors

`FirstSteps` fetches companion setup and derives its next instruction from current location and current Oran balance. Buying an Oran can look like a completed harvest; using or selling the last berry makes the player appear to need their first harvest again. Home/public dots are temporary location indicators, not durable visit accomplishments. At home without berries the text teaches cultivation but its primary button says “Visit the meadow.” Its refresh key includes whether inventory is non-null, not each inventory revision, and the companion fetch also polls every 30 seconds. The existing `completed` tutorial preference only records whether narration was dismissed.

`companions.ts` reports `homeClaimed` by yard-row existence, but `nativeResources` can also create that yard row during resource access. Where the story requires an explicit claim, the stronger historical proof is the unique `charmville_receipts` claim with matching `profile_id` and `actor_profile_id`. A yard row alone establishes account storage, not necessarily that narrative action.

### Smallest coherent change

Keep `/api/charmville/tutorial` and its boolean bridge backward compatible. Add a separate authenticated read-only journey projection endpoint and a new `journey-progress` service; its output should include a versioned list of accomplished keys, proof kind, current objective and explicit availability. Do not accept client-submitted accomplishment IDs. First ship projections for facts already durably proven, then add a small monotonic milestone table for facts without retained history. This avoids changing working reward paths merely to draw a checklist.

Suggested milestone table: primary key `(profile_id, milestone_key)`, `definition_version`, `evidence_kind`, `evidence_id`, nullable `occurred_at`, `recorded_at`. Keep `occurred_at` null where a historical source has no trustworthy commit timestamp; `contact_at` on native actions is scheduled time, not actual commit time. An evidence locator can include profile ID plus request UUID for compound source keys. Each trusted action writer inserts its milestone with `ON CONFLICT DO NOTHING` inside its existing transaction, after successful settlement and before COMMIT. The milestone writer has no reward code. If a future step grants an item, that grant needs its own versioned unique entitlement and ledger receipt; replaying narration or reading progress never issues it.

| Stable key | Existing proof or required hook | Semantics / exclusions |
|---|---|---|
| `journey.home.claimed` | `charmville_receipts` where action `claim`, actor and owner equal current profile | Do not infer from yard storage alone. Preserve legacy legitimate claims; do not replay the grant. |
| `journey.partner.chosen` | `charmville_companions` owner record | Starter choice is durable; current following flag is a preference, not proof of visible walking. |
| `journey.oran.supplies.received` | `charmville_native_seed_grants` | Proof of the existing Oran seed grant only. Never label it inherited Burning Heart. |
| `journey.home.soil.tilled` | Committed `charmville_native_actions`, kind `till`, region `home:<profile>` | Pending, cancelled, public and someone else's actions do not qualify. |
| `journey.home.oran.planted` | Same source, kind `plant`, `crop_id='oran-berry'` | Current seed ownership or crop stage does not prove this account planted. |
| `journey.home.oran.watered` | Same source, kind `water`, own-home region/crop | A helper's separate water receipt must not be attributed to owner instruction completion unless the objective is explicitly cooperative. |
| `journey.home.oran.harvested` | Same source, kind `harvest`, own-home region/crop, committed yield | Balance is never proof; consuming/selling does not undo this accomplishment. |
| `journey.partner.cared` | `charmville_creature_use_receipts` with positive healed result for current actor; alternatively a separately defined completed-rest key | Do not label a no-op or purchased berry “care.” Item use and resting are different lessons if both matter. |
| `journey.home.entered` / `journey.meadow.entered` / `journey.friend-home.entered` | New trusted admission milestone hook after `nativeActor` persists validated spawn in active region | Presence selection alone precedes native placement. Server admission proves accepted state, not that the player saw the scene; visual load evidence remains a separate acceptance gate. Friend home requires another owner and valid visit permission. |
| `journey.wild.captured` | `charmville_capture_events`, actor matches, `captured=true`, durable event ID | A failed ball, catalog discovery, fixture roster or owned starter is not capture proof. |
| `journey.exchange.traded` | `charmville_exchange_receipts` action `fill`, quantity positive; join offer to credit its owner as counterparty where appropriate | Creating/cancelling an offer is not a trade. Offer-owner and filler can each receive the non-economic milestone without duplicating settlement. |
| `journey.heart.inherited` / `journey.heart.harvested` / `journey.heart.gifted` | Not available yet: future versioned inheritance entitlement, committed Heart crop action and actual sender/recipient transfer receipt | Legacy `stamp` receipt spends Stalk but does not prove recipient Heart custody. Leave these unimplemented rather than silently crediting an unrelated primitive. |

Avoid forcing a rigid global step order onto facts: players may choose a partner before farming. Store monotonic facts independently and select the next available objective by a versioned tutorial definition. Optional trade, public/social exploration and combat should remain independently skippable activities; required grants cannot depend on performing a market transaction. Replaying the story changes presentation preferences only.

For current source history, a read projection can use indexed `EXISTS` queries on profile-owned receipts/actions. If durable materialization is added, backfill only source-proven facts with their evidence locators and make migration replay harmless. Never infer past home visits from today's presence or current actor position. Never add a supposedly completed motion/tutorial action just because account setup succeeds. If receipt pruning is later introduced, preserve materialized proof before pruning.

UI integration should consume the single journey snapshot, show accomplished steps permanently, and expose a contextual next action that matches its instruction (e.g. focus the active bed, open Party, enter home). Refresh after accepted resource/companion/travel/use/capture/exchange receipts and on reconnect; retain a bounded fallback refresh if needed, not a second independent collection of conflicting polling-derived progress. Deferred Burning Heart steps must say unavailable during this transition and must not block the working Oran loop.

Focused acceptance: harvest then consume/sell remains complete; a purchased berry does not complete harvest; failed/cancelled actions do not count; foreign-home help is correctly attributed; narrative replay grants nothing; concurrent/retried commit gives one milestone and one existing economic receipt; account change cannot leak prior progress; a reload resumes the objective; real safe placement and narrated objective agree in the retained browser. These checks establish progression semantics, not finished authored maps or animation quality.

### Query recipes for the next implementation batch

All `$1` values below must be the profile ID returned by server authentication, never a client-selected profile. These are read-only recipes, not executed migrations or test evidence. UI should display both “First harvest completed” from these facts and “0 Oran Berries currently owned” from inventory when both are true.

```sql
-- Explicit home claim, distinct from a yard row created by another service.
SELECT id::text AS evidence_id, created_at AS occurred_at
FROM charmville_receipts
WHERE profile_id=$1 AND actor_profile_id=$1 AND action='claim'
LIMIT 1;

-- Monotonic own-home farming facts; no current stack/bed-state inference.
SELECT kind, crop_id, request_id::text AS evidence_id
FROM charmville_native_actions
WHERE profile_id=$1 AND region_id='home:' || $1::text
  AND status='committed'
  AND kind IN ('till','plant','water','harvest');

SELECT id::text AS evidence_id, created_at AS occurred_at
FROM charmville_companions WHERE owner_profile_id=$1;

SELECT profile_id::text AS evidence_id, created_at AS occurred_at
FROM charmville_native_seed_grants WHERE profile_id=$1;

SELECT event_id::text AS evidence_id, created_at AS occurred_at
FROM charmville_capture_events
WHERE actor_profile_id=$1 AND captured=true
ORDER BY id LIMIT 1;

-- One completed fill can acknowledge both legitimate trading counterparties.
SELECT r.actor_profile_id::text || ':' || r.request_id::text AS evidence_id,
       r.created_at AS occurred_at
FROM charmville_exchange_receipts r
JOIN charmville_offers o ON o.id=r.offer_id
WHERE r.action='fill' AND r.quantity>0
  AND (r.actor_profile_id=$1 OR o.owner_profile_id=$1)
ORDER BY r.created_at, r.request_id LIMIT 1;
```

For a bounded first pass, replace the farming result list with separate `EXISTS` clauses or grouped booleans; do not send complete receipt history to the browser. Retrieve an evidence locator only when materializing a missing fact. `creature_use_receipts.result` currently carries `healed`; validate its JSON type/value in trusted decoding before accepting positive care rather than blindly casting arbitrary JSON text in SQL.

Recommended next append-only migration (choose the next unused migration number at implementation time) creates the milestone table described above with a profile foreign key, nonempty bounded key/evidence fields, integer definition version, `recorded_at DEFAULT clock_timestamp()` and unique profile/key. Do not rename/drop migration 128 or change the meaning of its boolean. Add a partial index on `(profile_id, kind, crop_id, region_id)` for committed native actions only if query plans justify it; the existing primary key already leads with profile ID. No migration should credit inventory, revise historical timestamps, fabricate visits or equate old Oran grants with Heart inheritance. Transactional writer hooks and conservative backfill can then ship with the new read projection while the old runtime remains schema-compatible.
