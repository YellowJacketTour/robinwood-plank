# Player experience checkpoint

## Latest playable additions
Native Homestead: harvest grants one berry and one cutting. On the next growing crop, D/E consumes one cutting at action contact to fertilize once; the next harvest grants two berries. The cutting is consumed, never duplicated by repeated interaction. Each harvest grants 10 Farming XP; every three harvests raises the prototype Farming level. Level is informational and grants no hidden production multiplier. All counters remain temporary native guest state, not the authenticated Satchel.

Tall crop art draws behind the hero when the hero's feet are below the crop root, and in front when above. This is a local hero depth rule, not a complete shared entity sorter. Solid resource collision, remote action replication and authored tool/body frames remain outstanding.

Display: browser fullscreen hides the header and offers Menu/Exit fullscreen controls. Fullscreen zoom is capped to fit the display. Optional whole-pixel scaling avoids fractional pixel sizes when space permits. Touch layout and small-screen downscaling remain available.

## Larger world camera finding
The collected ZQuest source src/zc/maps.cpp calculate_viewport fixes viewport.w=256 and viewport.h=176 (+56 in extended-height mode). Scrolling regions can connect screens, but do not expose a larger desktop field of view. Rendering more land simultaneously needs a tested engine/render/input/collision/HUD revision and a rebuilt WASM runtime. CSS resizing cannot achieve it. No wider camera or new region was shipped here.

## Binding product decisions from the user
Charmdex is the fullscreen-accessible pocket PlankSpace: feed, Lumberyard, Pine posts, Satchel, discovery, skills, map, friends and Grained Exchange. One stable account identity must own characters and inventory, with separately verified wallets, passkeys and OAuth credentials. Do not equate connecting a wallet with authorization to merge accounts. None of these new identity capabilities are claimed complete by this native checkpoint.

The economy is simulated, with real resource accounting and player-driven prices. Real-money Grain purchases must transfer existing, disclosed supply rather than mint extra currency. Production budgets, sinks, recipes, skills, effort and time define scarcity; ordinary materials should have useful crafting/compost/building outlets. NPC buying must have a finite budget. Monetization must not bypass those rules. Market prices, supply measurements, estimates and executable quotes must remain distinguishable. Offers eventually transfer assets atomically and once. External cash settlement is not part of this implementation.

## Next end-to-end milestone
Authenticated home region and resource entities → native action contact validated by server → durable Satchel award/consumption → visible shared state → recipe or player trade. Keep all native guest testing clearly separate until this chain works. Then extend the same model to woodcutting, mining, fishing, creatures, construction and public events. Pokémon encounter HP/status handoff and capture are still unimplemented. The current berry sprites alone do not constitute Pokémon gameplay.

## Verification
Native compile; two harvests with single fertilizer consumption and expected berries/cuttings; source stage screenshots; fullscreen enter/exit/header restoration, menu access, whole-pixel scale, 4K layout, 390px touch layout and synthetic gamepad regressions. Physical controllers and real mobile pinch gestures are not device-tested.
