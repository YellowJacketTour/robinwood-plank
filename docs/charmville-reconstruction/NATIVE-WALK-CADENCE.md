# Native walking cadence: source audit

Audited 2026-09-12. This document distinguishes engine source facts from the active quest configuration, which still needs a runtime diagnostic. Do not change server speed limits based solely on an engine default.

## Evidence and the unresolved configuration

Live follow-up: the runtime probe was compiled, then the embedded iframe source revision changed to force an actual fresh load (keyboard reload attempts had retained old runtime). Retained tab15 displayed `New 0 / New2 0 / LTTP 0 / Diagonal 0 / Step 150`. This selects legacy four-way, so the100ms/8px rate is appropriate; Step150 is inactive for this branch. Sustained relocation remains unresolved and must not be attributed to an assumed90px/s mode. Probe lives under Settings & help → Equipped adventure items.

Local engine checkout: `../charmville-references/zquest-classic`, commit `b9354acc0f4bbcfda3b390f98ff5032fbf0f6eb0`. The running native tool distribution is `../charmville-references/zquest-native-212/runtime`; checked-out source and deployed binary must not be assumed identical.

`scripts/charmville/build-homestead.mjs` copies `charmville-native-homestead/template.qst`, adds the current script, and smart-assigns it. It does not explicitly configure movement rules or the Hero step rate. The current Homestead script has no Hero step-rate override. Consequently, quest defaults alone are not evidence that this game walks at 1.5 pixels/frame.

An isolated `zeditor.exe -uncompress-qst` export succeeded to `work/native-walk-audit.qst`. Its apparent RULE section header did not structurally match the checked-out reader layout. An initial raw-byte interpretation was discarded: none of those rule values should be used as findings. The original/live quest was not modified.

## Source-backed movement branches

| Branch | Native behavior | Implication at a 60 Hz simulation |
|---|---|---|
| Legacy four-way | `lsteps={1,1,2,1,1,2,1,1}`, indexed by current axis coordinate modulo 8 | An aligned 8-pixel span takes 6 frames: 100 ms, 80 pixels/second |
| Legacy diagonal-enabled, cardinal travel | `z3step` alternates 1 and 2 pixels | Long-run 90 pixels/second; individual 8-pixel crossings vary with phase |
| Legacy diagonal-enabled, diagonal travel | 1 pixel on each moving axis per frame before slow modifiers | 60 pixels/second per axis, approximately 84.85 Euclidean pixels/second |
| New Hero Movement | `(steprate + tmp_step_boost)/100`; configured default `heroStep=150` | Default cardinal 90 pixels/second; 8 pixels approximately 88.89 ms on average |

References in `src/zc/hero.cpp`: `lsteps` line 91; branch macros lines 94–95; initialization lines 1975 and 2091; new movement calculation around 19658; `moveOld()` around 19824–20126; `moveOld2()` around 20127 onward. `src/core/initdata.h:72` defines the 150 default. `src/dialog/init_data.cpp:700` explicitly says Hero Step only applies with New Hero Movement enabled. The distributed `runtime/include/bindings/hero.zh:190–224` documents the same Steps/Step distinction.

The numbers above describe ordinary unobstructed ground travel, not every gameplay state. Charging, slow terrain, swimming, shield speed modifiers, temporary boosts, stun, attack states and collision can change or suppress displacement. Do not treat a generic maximum speed as proof of those mechanics being authoritative.

## Turning and apparent corrections

Legacy movement computes `xoff=x&7` and `yoff=y&7`. With grid lock active, a new perpendicular input can first continue or reverse along the old axis to reach an aligned coordinate, before beginning the requested turn. For example, `moveheroOld()` around lines 17696–17724 resolves a left input by moving up/down when the current Y offset is unaligned. `NO_GRIDLOCK` clears these offset tests when Disable Four-Way Gridlock or New Hero Movement 2 applies.

This is a native alignment operation, not permission for arbitrary network relocation. A client that treats the requested facing as proof of movement direction can reject this legitimate short adjustment. Conversely, accepting every adjacent cell at an immediate turn can create a speed loophole. Preserve the actual ordered path and its movement time, and validate against the active movement model.

Quantized cell changes are not uniformly timed even when physical movement is uniform: crossing into a cell after starting near its edge can happen almost immediately, followed by the next full span. Applying an unconditional full-cell delay to every observed cell crossing creates phase error. Arrival acknowledgments also must not force an old facing back over a more recent native turn.

## Required runtime proof

Read once after the quest initializes, using the actual supported distributed ZScript bindings:

```cpp
Hero->Step
Hero->TempStepBoost
Hero->Diagonal
Hero->Steps[0] // repeat through index 7
Game->FFRules[qr_NEW_HERO_MOVEMENT]
Game->FFRules[qr_NEW_HERO_MOVEMENT2]
Game->FFRules[qr_DISABLE_4WAY_GRIDLOCK]
Game->FFRules[qr_LTTPWALK]
```

The API is **FFRules**, not QuestRules. Bindings: `runtime/include/bindings/game.zh:620–624`, `hero.zh:190–224,367–370`, `qrs.zh`. Pair this configuration record with bounded frame-indexed X/Y/facing/action observations for a straight walk, a reversal and a perpendicular turn. Exclude scrolling and explicit authorized placement from normal walking samples. Configuration readout alone does not verify measured performance or remove every sync defect.

## Network implementation constraints

1. Keep authenticated identity, monotonic sequence, region epoch, trusted collision and speed validation. Do not trust client timestamps as an unlimited movement budget.
2. Separate native observation time, network dispatch time and acknowledgment time. RTT is transport overhead, not an extra segment of in-world walking time.
3. Preserve each observed path segment until accepted or explicitly invalidated. Coalescing to the final position must not erase corners or permit travel through blocked space.
4. If batching is introduced, validate every intermediate segment atomically against one bounded server-owned time budget. Do not grant each segment the whole elapsed interval or accumulate idle time without a cap.
5. Use correction only for a genuine authority disagreement, unknown world, invalid epoch or excess displacement. Pending acknowledgments are not by themselves a reason to teleport.
6. Followers should consume the accepted/local continuous trail, never interpolated screen-scroll coordinates or stale correction-facing snapshots. Clear the trail only on an actual discontinuity.
7. Slow frames, background-tab pauses, reconnect and border travel need explicit cases. Neither an engine frame counter nor a client wall clock alone establishes permission to catch up instantly after a pause.

Current conclusion: 100 ms per 8-pixel cardinal segment is correct for the legacy four-way branch, but may under-budget the alternate branches. Active quest configuration and a measured trace must decide the next rate change. This audit changes documentation only and does not claim live walking is fixed.
