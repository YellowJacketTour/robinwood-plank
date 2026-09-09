Latest audit (2026-09-09): [ANIMATION-AND-INTEGRATION-AUDIT.md](ANIMATION-AND-INTEGRATION-AUDIT.md) records native animation evidence and new source acquisitions. The actual browser editor is version 212 and rejects the `websocket` type with T047. Native version 219 compiles the probe, but its saved quest is rejected by this browser player. No network frames or combined farming/creature/skills gameplay have been demonstrated. First integration gate: use a matched editor/compiler/player build, then verify one authoritative planted plot and harvested inventory/XP transaction in the native world. The existing adventure remains an unmodified source quest in nonpersistent test mode.

# Executable foundation investigation — 2026-09-09 continuation

## Verified results

The original ZQuest native Windows x64 release `3.0.0-prerelease.219+2026-09-08` has been acquired in sibling `charmville-references/zquest-native-tools`. Its original distribution ZIP and SHA-256 source lock are preserved in the supplementary private release described in the handoff. This is an official distributed binary, not a locally compiled engine.

`verify-zquest-authoring.mjs` invokes the engine's own `-export-strings` and `-import-strings` commands against Hero of Dreams. It keeps the original quest intact and imports only into a separate copy. Export → import → export produced identical bytes: **2,065 dialogue slots, 42 field columns, 353,603 bytes**, SHA-256 `82f95a69fb17a121b08a680c21d44bb06fa8507124fe942598210994b4719461`.

Fields retain message links, text, font, window position/dimensions, sound, portrait, margins, draw layer and scrolling settings. This gives us a practical authored-dialogue preservation/adaptation pipeline. It does not prove a resaved quest's entire gameplay is identical; the engine performs version-compatibility migrations on load/save.

The source's `src/zq/commands.cpp` additionally implements native tile, enemy, individual NPC, door-set and combo import/export. Those commands were source-inspected, not all exercised. It also has `-quick-assign`/`-smart-assign`, which compile a quest's **existing embedded script buffer**. They do not by themselves import an arbitrary new source script.

The engine has a native ZScript `websocket` class and a browser implementation (`src/zc/websocket_pool_web.cpp`). `scripts/charmville/zquest/WorldLink.zs` was compiled successfully by the preserved `zscript.exe`; the output contains actual WebSocket instructions. It reads hero X/Y/HP and proposes a sequence-tagged pose message for a local test endpoint. **It is not yet assigned to a quest or runtime-verified.** No server has been started on port 3022; do not claim synchronization from this compiler check.

Run the checks from the application checkout:

```powershell
node scripts/charmville/verify-zquest-authoring.mjs <new-output-directory>
node scripts/charmville/compile-zquest-probe.mjs <output-directory>
```

Both use the restored sibling native tool distribution. Neither modifies the archived quest. The authoring check overwrites its own named output files; choose a dedicated output directory, never an original source directory.

## Decision and next executable gate

Retain ZQuest as the immediate browser adventure/reference foundation because it already runs the praised content, its native editing/compiling tools work, and its script transport is explicit. Do not replace its movement/dialogue with a generic canvas to create an illusion of integration. Before promoting it to the unified gameplay client, attach a minimal script to a disposable authored quest through a supported editor/build workflow, confirm actual browser WebSocket messages, then prove validated shared-state round trips. Preserve original quest copies and engine behavior throughout.

Keep Solarus/ZSDX as a serious alternate/reference for action/entity APIs. The acquired Solarus Online README documents useful entity replication but also client-owned mob simulation, incomplete equipment sync, save-system gaps, and limited hero actions. It is not ready-made economic authority. Do not equate it with an already secure MMO stack.

The shared system must own creature identity/HP/status, capture/ownership, property permissions, inventory, quest rewards and market transactions on the server. Pose reports from a source runtime are untrusted. A completed local quest event is not an authority to mint or settle. The script probe intentionally changes no inventory/HP and treats replies only as acknowledgements until schemas, permissions, transactions and replay protection exist.

For the eventual bridge: preserve source input/camera/action semantics; register explicit world entity IDs and revisions; distinguish presentation events from validated actions; project one server-owned creature into action/staged battle/follower modes; use idempotent transitions; leave other players' world simulation live during a staged encounter. Implement the examples in CREATURE-AND-QUEST-CONTRACT.md before declaring the bridge integrated.

## Source references

- ZScript introduction: https://docs.zquestclassic.com/zscript/lang/introduction
- Script definitions: https://docs.zquestclassic.com/zscript/lang/scripts
- Compiler directives: https://docs.zquestclassic.com/zscript/lang/compiler_directives
- Release source: https://github.com/ZQuestClassic/ZQuestClassic/releases/tag/3.0.0-prerelease.219%2B2026-09-08
- Acquired source: `zquest-classic/resources/include/bindings/websocket.zh`, `tests/scripts/misc/websocket.zs`, `src/zq/commands.cpp`, `src/core/qst_ffscript.cpp`.
- Acquired comparison: `solarus-online/README.md` explicitly lists its implemented and missing features.
