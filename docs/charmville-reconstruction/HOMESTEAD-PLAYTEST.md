# Native homestead playtest — 2026-09-09

Play: http://localhost:3021/charmville/tutorial/

This is the first verified authored farming loop and two-player guest presence inside the preserved Zelda runtime. It is not the completed Charmville MMORPG. The original reference adventure remains at http://localhost:3021/charmville/ .

## What to do

1. Click **Enter the world**. Start in Autumn Town without the original story introduction.
2. At the starting clearing, press **D** (or **E**) once to till, again to plant, and again to water. Stay near the starting plot for those actions.
3. Wait about five seconds of game time, then press **D** again to harvest. The native HUD records one crop and 10 prototype farming XP.
4. After that first harvest, guest presence becomes visible. Open the same tutorial in another browser window, complete its first harvest, and move the two characters independently. Both clients draw the other's source sprite in the same scene. A maximum of 16 guest connections is currently allowed.
5. Press **C** (or **T**) to toggle the native aura effect; walk while it is active. The effect is also replicated to the other guest. This is a procedural gold effect, not a completed Super Saiyan character transformation or imported DBZ animation set.

Keyboard: arrows move; Z attacks/holds/releases sword charge; X uses the selected item; Enter opens native inventory. The tutorial keeps the endgame equipment preset. Native sword/shield artwork has not been replaced or certified for all requested subtleties.

Touch: existing direction/action controls plus Interact and Aura. Display provides a size slider, Fit and fullscreen; two-finger pinch handling is implemented over the canvas. Portrait touch controls sit below the game. Zoom changes display size, not game time or movement speed. High-resolution displays enlarge source pixels; this does not invent higher-resolution artwork.

Standard gamepad adapter: D-pad/left stick move; South/A/Cross sword; East/B/Circle item; West/X/Square interact; North/Y/Triangle aura; Start inventory; LB/RB item selection. Controller menu remaps the four action buttons and changes the stick dead zone. The adapter emits the native default keyboard bindings and prevents SDL from also consuming the same hardware. Changing keyboard bindings inside the native engine requires corresponding adapter changes. Physical-controller compatibility and device pinch behavior are not certified.

## Verified evidence

Two isolated Chromium contexts completed the farming loop, toggled their auras, and exchanged guest sprite updates. The latest repeat observed 355 and 161 outgoing messages, with 32 incoming peer messages on each client, zero page errors, and joined/aura flags active. Screenshots show both characters in the native scene and the crop/XP HUD. Guest sprites are scene-filtered and expire when updates cease; connection loss is labeled offline and the script retries its connection.

Synthetic standard-gamepad tests verified sword key-down/key-up, rejection of stick drift, and release of held movement on disconnect. Browser tests exercised the zoom slider, 3840×2160 layout, fullscreen entry/exit and a 390×844 touch layout. These tests do not substitute for physical controllers, phones or a full gameplay regression.

## Important correction to the earlier engine diagnosis

The earlier derived quests were gzip-compressed and served without `Content-Encoding: gzip`. The original acquired `.qst.gz` paths contain already-decoded quest bytes. Sending compressed bytes directly to the engine caused the misleading **Invalid quest file** result.

After correcting the payload, a quest compiled/assigned by native **3.0.0-prerelease.212+2026-08-16** runs in the hosted browser player and its WebSocket script works. The earlier native-219 output instead reports **Version not supported**. Therefore use native 212 for this player. The separately downloaded web compiler still rejected declarations accepted by native 212; it is not the authoring compiler for this build.

## Rebuild and run

Restore `zquest-native-212` and `charmville-native-homestead` into the sibling `charmville-references` directory, alongside the original runtime/quest collections.

```text
node scripts/charmville/build-homestead.mjs
node scripts/charmville/serve-reference-runtime.mjs
node scripts/charmville/serve-homestead-world.mjs
```

Run the two servers in separate terminals. Both bind loopback only. The template quest's script buffer includes `CharmvilleHomestead.zh`; the build copies the versioned `Homestead.zs` into the native compiler include directory, compiles a separate output quest, writes correct local content metadata and publishes decoded bytes. Original Hero of Dreams source files are not overwritten.

Verification commands:

```text
node scripts/charmville/verify-homestead.mjs <evidence-directory>
node scripts/charmville/verify-display-controller.mjs <evidence-directory>
```

## Still required for the actual vision

- PlankSpace authentication, durable player/land/inventory records, authoritative farming/crafting/XP and replay-safe transactions. Current progress resets in native test mode; guest messages are untrusted presentation data.
- A richly scripted original arrival, NPC dialogue, property assignment and cohesive farm art. Current crop visuals reuse existing scene combos and do not reproduce FarmVille's complete growth artwork or tool animations.
- Exact sword/hand/shield action-frame review and corrections; complete held bow draw/release, bomb warning cadence, audiovisual feedback and animation transitions.
- Actual Super Saiyan form art, transformation sequence, energy rules, beam collision/damage and source-derived DBZ effects. The current gold aura is a prototype.
- Pokémon live entities, persistent creature identity/HP/status, capture, followers and battle-mode transitions. None are implemented in this native playtest.
- RuneScape-quality skill/gear systems, satchel, Grained Exchange, charm reactions and verified financial settlement. The crop/XP counters do not connect to these systems.
- Authoritative movement/combat, collision between players, reconnect identity, cross-device access, scaling and deployed multiplayer hosting. Guest presence is not secure MMO authority.

Continue from this working native script and transport. Do not repeat the obsolete claim that no browser network messages have been observed, and do not claim the above missing systems are complete.

## Repository checks

Lint and typecheck passed; production build passed. Market tests: 1,326 passed, 50 skipped, zero failures. The full contract run reported 211 passed and one failure in existing PlankCrash S-12 (expected settlement amount above zero). Its focused rerun passed. No contract code was modified; the full suite must not be reported as an unqualified clean pass.
