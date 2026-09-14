# Burning Heart: minimal complete vertical slice

Original dependency plan, grounded in release 69a86aae. The local development implementation is now exercised end to end; see the September 13 acceptance update below. Production activation and full narrative remain pending. Keep private admission and the accepted Oran release operational throughout.

## Outcome

A player explicitly receives the family's first Burning Heart seeds once, plants a clearly identified Heart bed, waters and harvests it, sees the owned Burning Heart in the Satchel, and deliberately pins one on a permitted post from Social. The world, inventory and post use the same identity and coherent artwork. Oran retains its name, balances, care utility and historical receipts.

## Ordered implementation matrix

| Dependency | Exact surface | Required implementation |
|---|---|---|
| 1. Database identities | New append-only migration in deploy/inmotion/postgres/migrations; existing constraints originate in 126_charmville_native_resources.sql, 141_charmville_native_crop_identity.sql and 143_charmville_oran_social.sql | Add burning-heart to relevant seeds/stacks/resource/action/stamp constraints. Determine new migration number from current merged dev. Never edit historical migrations, Oran defaults, action payload hashes or stored results. |
| 2. Family entitlement | lib/charmville/native-resources.ts and new entitlement storage | Existing native_seed_grants is profile-keyed and issues three Oran seeds. Create a separate unique profile/version family entitlement, atomically issuing Heart seeds only when inserted. Never clear/reuse the Oran grant. Choose explicit initial quantity and version before implementation. |
| 3. Crop rules | lib/charmville/native-crops.ts | Replace single-crop resolver with a supported registry. Define Heart seedFace/produceFace burning-heart, growth duration, yield and returned seed quantity. Retain existing Oran default. Balance values require explicit review rather than invented market-price guarantees. |
| 4. Bed and balance selection | lib/charmville/native-resources.ts | Resolve balances and allowed actions by each bed's crop; current default-only aggregate cannot safely drive multiple crops. Deliberate crop selection requires empty eligible bed and expected revision. No changing planted or pending-action identity. |
| 5. Native protocol and art | scripts/charmville/resource-bridge.js; actual native quest source/build inputs used by the accepted package | Current file protocol carries stage/phase, not crop identity. Version it and carry stable crop identity; add distinct seed/sprout/growing/ripe art with existing world anchors and layer rules. Locate and pin native source revision before assigning source edits. Rebuild quest rather than renaming an Oran sprite. |
| 6. Tutorial | lib/charmville/journey-progress.ts; scripts/charmville/tutorial-bridge.js | Current milestone queries explicitly name Oran. Add versioned Heart opening milestones and family dialogue only after actual reward exists. Preserve old progress and returning location. Skipping dialogue does not issue or repeat rewards. |
| 7. Inventory presentation | lib/charmville/item-display.ts; app/charmville/world/world.tsx; new public/charmville/items/burning-heart.png | Canonical name/icon through supported presentation lookup replaces Oran-only icon branch. Supply reviewed art provenance and readable selected/disabled states. No fake owned catalogue entries. |
| 8. Social consumption | lib/charmville/social.ts; app/charmville/world/social-panel.tsx; social-charm-basket.tsx | Replace hardcoded Oran validation/debit/counts with strict supported registry, parameterized identity, per-item count and exact receipt identity. Confirm Pin 1 Burning Heart; receipt updates quantity. No automatic tutorial posting. |
| 9. Package/release | scripts/charmville/private-runtime-manifest.mjs and adapter/bridge pins; new native package | Add art and rebuilt bridge/quest, inventory hashes and local mirror equivalence. Repeat relevant browser acceptance before promotion. Never mutate the accepted immutable runtime folder. |

Seeds and produce may share the stable face ID because they occupy distinct existing seed/stack tables; their quantities and uses remain separate. Exchange support is deliberately subsequent: lib/charmville/exchange.ts has its own explicit allowlist and settlement must be extended before claiming Heart tradability.

## Mixed-version safety

Deploy additive schema first while old Oran clients continue unchanged. Do not globally change DEFAULT_NATIVE_CROP_ID or automatically convert existing beds. New protocol clients must advertise supported schema/crops before Heart action availability. An older bridge must never interpret a Heart phase as an Oran bed: deny unsupported-region rendering/actions with a clear update requirement, or retain Oran-only experience until refreshed. Unknown crop identities fail closed server-side.

Keep pending action's crop and resource revision fixed. An action created before rollout must replay its original stored result; do not rehash old requests under a new payload shape. Negotiate API response changes so old Social clients still receive their supported Oran fields while newer clients use item-specific counts. Retire compatibility only after a deliberate supported-version transition. Separate additive migration rollback from content activation: disabling Heart availability must preserve all earned custody.

## Acceptance gates

- Concurrent/retried family acceptance produces one entitlement and the configured seed quantity exactly once; failure rolls back both. Existing Oran grant/balances are unchanged.
- Fresh and returning players preserve location/progress; scene skip/reload cannot repeat entitlement.
- Plant consumes the correct seed; watering and harvest use authoritative time and fixed crop identity. Reload each stage. Harvest retries issue one produce/seed result.
- Every native stage has distinct reviewed Heart art, stable bed anchoring, directional contact and correct occlusion. Old clients cannot display or mutate it incorrectly.
- Satchel quantity and icon match receipt-backed ownership. No new unit is created by displaying art.
- Explicit pin on an authorized synthetic post consumes one Heart once, retains post identity during refresh, survives reload and handles uncertain retry with the same request ID. Insufficient stock, invisible post and revoked admission lose nothing.
- Oran cultivation, care and pins remain operational. Private runtime anonymous/revoked access still fails.
- Only after focused transactional and visible acceptance: new immutable package and normal release checks. This does not complete the full opening narrative, shared town or overall game.


## September 13 local acceptance update

Synthetic account26, same browser tab22 on localhost3018, candidate `alpha01-heart-native` (inventory `f0b2d40005cb475017f662f713d599a52a922a4a48dd50a210858bbd49b3def7`):

1. Claimed home, chose Treecko, enabled following, completed the two-page native introduction.
2. Explicitly accepted the family gift in Journey; displayed receipt showed3 Heart seeds. No inventory was inserted to fake this result.
3. Inspected the distinct original Heart SVG in Satchel. The initial stale opening balance was fixed by refreshing authoritative inventory before opening Satchel; the final live check showed three Heart seeds and zero spent Hearts correctly.
4. Native E tilled, planted Heart and watered. Server bed0 changed to `burning-heart`; Heart seeds3→2, Oran seeds stayed3.
5. Observed planted, flowering and ripe native art with a stable soil anchor. Intermediate sprout/bud code is compiled but not every frame/direction has visual acceptance.
6. Native E harvested: Heart seeds returned to3, Heart produce0→1, bed returned to prepared stage.
7. Opened in-game Social, chose Heart and explicitly confirmed a pin on the synthetic friend's post. Basket1→0; post Heart count0→1; Oran remained distinct.
8. Returned to the still-running native world. Seed selector changed to Oran without spending a seed. Journey showed First harvest complete even with zero Heart stock, based on the committed receipt.

Local-only flags control family, nativev2 and socialv2. Production remains on the existing release. Migration147/148 applied only to the isolated acceptance database. New art is original code-native/SVG work; it does not claim to be a recovered Nintendo asset. The exact whole-frame timing, all directions, touch/gamepad selection, reload-at-every-contact, anonymous/revocation regression and release promotion remain required. Parent characters/cinematics, girl hero coverage, Kakariko, Exchange eligibility and full MMO scale are not completed by this slice.

9. Traveled to the public meadow; committed first-harvest progress remained complete after spending the Heart. Family Open Satchel refreshed successfully. Focused contract tests, TypeScript and lint checks passed; these do not substitute for remaining release gates.

