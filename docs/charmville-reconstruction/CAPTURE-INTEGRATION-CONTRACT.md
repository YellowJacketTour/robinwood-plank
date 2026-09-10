# Poochyena capture integration contract

Primary reference: local `../charmville-references/pokeemerald`, commit `5eff78649e7170a877b961ef0b3da13b81a16038`. File hashes are recorded in `capture-source-provenance.json`. No new assets were copied and no capture issuance was added by this audit.


## Current implementation checkpoint

Migration123 and `/api/charmville/world/capture` add a finite once-only three-ball supply for trusted local sandbox profiles. Capture uses server randomness and replayable receipts. A failed throw consumes one ball and allows wild Tackle retaliation. Success transfers the encounter UUID, level, HP and combat IVs to owned storage without overwriting the six party slots. The captured encounter becomes terminal and leaves native presentation. Status-bearing captures and other ball types remain unsupported. This paragraph supersedes implementation-status statements in the original audit below; the source analysis remains applicable.

PostgreSQL checks cover failure/retaliation, replay and concurrent duplicate success, ownership transfer, stored creature assignment and individual following, plus terminal encounter rejection. The full acceptance list below is still a release gate, not a claim that every case or capture animation has passed.
## Exact source behavior

`src/battle_script_commands.c` contains the ball bonuses (line 841) and capture calculation (lines 9987–10048). Preserve integer division at each operation: `a = floor(floor(catchRate * multiplier / 10) * (3*maxHP - 2*HP) / (3*maxHP))`. Sleep/freeze doubles `a`; poison/burn/paralysis/toxic multiplies by 15 then divides by 10. These are two separate source conditionals; valid status modeling should prevent impossible combinations. Ordinary Poké Ball multiplier is 10, Great 15, Ultra 20. Poochyena catchRate is 255 (`src/data/pokemon/species_info.h:7889`). Full-health, no-status, ordinary-ball `a` is therefore 85, not a guaranteed capture.

When `a > 254`, capture succeeds. Otherwise the source computes `b = floor(1048560 / floor(sqrt(floor(sqrt(floor(16711680/a))))))` using the engine integer square root, then performs up to four independent 16-bit comparisons `Random() < b`. All four passing means success. `include/battle_controllers.h` distinguishes 0, 1, 2, 3 failed shakes and success=4; this is three visible shakes plus resolution, not four visible shakes. Implement an explicit zero-odds guard instead of division by zero. Use server randomness and store its outcome once; do not expose a predictable generator or reroll retried requests. Special balls, Safari, trainer blocking and scripted catches need their own source rules and should remain unavailable initially.

## Current domain and required atomic operation

`lib/charmville/encounters.ts` currently holds one persistent level-2 Poochyena (source species 286) per region, authoritative HP/maxHP/statuses, controller lease, revision and world/turn mode. Its only commands are claim, enter-turn, return-world and release. Mode switching does not damage or capture. The placement is authored, not a claim about Emerald habitat. Current receipts retain payload hashes but not a replayable random capture result; capture must persist the full result.

Proposed request: `{requestId, encounterId, revision, actorEpoch, action:'capture', ballItemId}`. Never accept catch odds, damage, species, HP, owner, slot assignment or random rolls from the client. In one transaction: authenticate; validate current presence/home rights/map/range; lock encounter and require an unexpired controller lease; lock the account inventory and roster in a documented common lock order; reject a resolved/fainted encounter; debit exactly one permitted ball; calculate and persist the single outcome; on success create exactly one owned creature from the encounter identity and stats, mark the encounter captured, and assign a free party slot if permitted. Failed attempts consume the ball and retain encounter HP/status; reject invalid requests without spending. Return the stored result on duplicate identical requests; reject changed payloads using the same ID.

Existing `creature-roster.ts` locks `charmville_creature_rosters`, validates six slots, enforces owned UUIDs and prevents a creature occupying multiple slots. Integrate with these entities, not legacy one-starter `companions.ts`. Add a unique encounter-to-acquired-creature constraint and a durable capture receipt. Preserve species, level, HP IV, current HP and valid statuses rather than regenerating a fresh starter. Species constraints and acquisition-kind constraints must be checked before enabling Poochyena; existing starter-only assumptions may require migrations. If six slots are full, either reject before spending until storage is implemented, or atomically retain the owned entity in an explicit storage destination. Do not silently overwrite a party member or claim a clinic/storage feature exists.

## Ball supply and presentation

There is currently no identified capture-ball issuance/debit path in this encounter service. Before enabling throws, define one inventory item with a stable ID, finite recorded issuance (e.g. a once-per-account onboarding grant with a unique grant receipt) or a conserved crafting recipe. Grant creation and redemption must be idempotent. Balls are inventory consumables; a ball-shaped reaction charm must not automatically become a usable capture item. Paid access must not mint unbudgeted gameplay supply.

Exact graphics entry points are `src/data/graphics/pokeballs.h` and `graphics/balls/poke.png`; animation sequences/callbacks are in `src/pokeball.c` and throw motion in `src/battle_anim_throw.c`. Inventory/icon imagery is a separate role. Bind throw, opening, absorption, fall, shake count and release/success to the persisted receipt; replay visuals must never repeat settlement. Existing battle-front creature art is appropriate for the encounter close-up, not a substitute for overworld walking art. Source availability is provenance, not a rights grant.

Required tests before release: fixed integer formula vectors; 0/full/low HP and statuses; all shake outcomes; insufficient balls; duplicate/lost-response retry; two simultaneous captures; full party/storage policy; lease expiry, travel and revoked home access; failed capture preserving health; successful capture producing exactly one UUID and one ball debit. Then verify the actual browser receipt drives source animation and the resulting owned creature appears in the existing roster.

## Implemented arithmetic only

The isolated ordinary-ball/no-status arithmetic is implemented in lib/charmville/capture-math.ts. Fixed integer vectors and all four strict comparison outcomes are tested. It does not issue balls, run capture requests or create creatures; the atomic service and visual sequence above remain unimplemented.
