# Native starter followers

The authenticated account party preference is projected into the local Homestead reference runtime. It does not authorize inventory, rewards, battle damage, or other players' creatures. Native movement and harvests remain temporary; this is not a shared creature simulation.

## Source artwork

Emerald's local source has battle sprites and icons for these starters, not suitable walking sheets. Walking artwork is explicitly from PMDCollab/SpriteCollab commit `db1928346e452e1a36b8ecff62f7e4d195504763`, not Emerald. The byte-exact walking sheets, offsets, shadows, animation XML, per-asset credits, repository license and README are preserved under `public/charmville/creatures/followers/`. Its manifest records every original URL, SHA-256 and byte count. All three asset credit files name CHUNSOFT. Repository submission licensing must not be mistaken for independent ownership of official game artwork.

| Emerald species ID | Source folder | Frame dimensions | Walk timing |
| --- | --- | --- | --- |
| 277 Treecko | sprite/0252 | 32 × 32 | 6,10,6,10 |
| 280 Torchic | sprite/0255 | 24 × 32 | 8,8,8,8 |
| 283 Mudkip | sprite/0258 | 32 × 40 | 4,6,4,6,6,4 |

These source rows are S, SE, E, NE, N, NW, W, SW. Native four-direction movement selects rows 0,2,4,6. Sprites retain original dimensions; no battle front sprite is passed off as walking art. Source offset/shadow sheets are preserved but are not yet rendered separately.

## Bridge and movement

`follower-bridge.js` accepts `{type:'charmville:follower', speciesId:0|277|280|283}` only from the actual parent window at localhost:3017 or 127.0.0.1:3017. Zero clears the projection. There are no credentials in this message. The bridge queues until Emscripten FS exists and writes `FS.cwd()/Files/Homestead/charmville/follower.txt`; ZScript's sandboxed file API reads `/charmville/follower.txt` relative to that quest directory. This differs from the bitmap API's root asset paths. The bridge does not sync this preference to IDB.

The follower uses a 64-sample history of actual hero positions, drawing 28 movement samples behind. History accumulates while the follower is off. Teleports over 24 pixels or screen changes reset history. Idle selects frame zero. Rendering sorts before/after the hero by foot position, without adding an attacking or solid entity. Full map object depth sorting, slopes, mounts, diagonal locomotion and network follower replication are not implemented.

## Native image decode correction

Allegro's `third_party/al_loadpng/loadpng.c` expands any PNG tRNS chunk to alpha, even for indexed PNGs. The engine's `mask_colorfill` works on byte-indexed pixels. The previous compiled PNG included tRNS, producing corrupted narrow pale sprites when consumed by this byte renderer. `indexed-sprite.mjs` now emits palette PNGs without tRNS: native index zero supplies transparency. Opaque black retains a distinct nonzero index. Original source PNGs are unchanged. Unit tests assert the inflated native indices and absence of tRNS, preserve opaque RGB, and reject partial alpha or palette overflow.

Runtime palette matching uses the main palette plus valid current level slots. Diagnostic inspection confirmed this quest exposes legacy 0–63 channels, so source RGB division by four is intentional. Quest palette approximation is not exact original RGB reproduction. Palette remapping on later palette-changing warps remains a follow-up.

## Verification

Candidate compiled before publication. Actual account verification (`verify-account-follower.mjs`) proves account selection, persisted following state, correct scoped FS write, native selection and draw telemetry, and turning the follower off. The first full Treecko screenshot after the decoder correction visibly restored its green head, body and tail; earlier telemetry-only passes missed corrupted artwork. A synthetic iframe fixture was discarded because its loading setup failed; it is not claimed as successful coverage. Parent runs the three-species account and native farm regressions for the final checkpoint.

Commands: `node --test scripts/charmville/indexed-sprite.test.mjs`; `node scripts/charmville/stage-action-sprites.mjs`; `node scripts/charmville/build-homestead.mjs --candidate`; then publish with the same command without `--candidate`. `acquire-follower-sprites.mjs` reacquires the bounded pinned reference files if the sibling asset vault is missing.
