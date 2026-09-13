# Transformation art registration audit

Read-only art/source audit, 2026-09-12. No gameplay or asset changes made. The gold hair atlas was opened visually, and its alpha bounds were measured with Pillow. Runtime pose registration remains unverified.

## Confirmed source and direction mapping

Source: sibling `charmville-references/universal-lpc/spritesheets/hair/spiked2/male/gold.png`, 832 × 1344 RGBA pixels, 13 columns × 21 rows of 64-pixel cells. It is hair only, with transparent surrounding cells, not a replacement Link body. The visible spiked silhouette differs by facing. The game draws each cell at 32 × 32: the actual visible hair is roughly 11 × 9–11 game pixels, not 32 pixels wide.

`universal-lpc/index.html:73935` onward declares the regular atlas layout:

| Pose | Zero-based rows | Populated columns | Direction order |
|---|---|---|---|
| Spellcast | 0–3 | 0–6 | north, west, south, east |
| Thrust | 4–7 | 0–7 | north, west, south, east |
| Walk | 8–11 | 0–8 | north, west, south, east |
| Slash | 12–15 | 0–5 | north, west, south, east |
| Shoot | 16–19 | 0–12 | north, west, south, east |
| Hurt/fall | 20 | 0–5 | single supplied orientation |

The current `Homestead.zs` row mapping up→8, left→9, down→10, right→11 is correct for this atlas. Do not use `sources/custom-animations.js` custom-row labels as regular PNG row indexes; those are another mapping.

**Confirmed timing mismatch:** the LPC generator's `sources/chargen.js:26` walks through columns 1–8. Homestead instead uses `Floor(ticks/8)%8`, i.e. 0–7. It includes the idle column and omits the last walk column. Its global clock also does not synchronize to the native hero's animation phase. Correct LPC indexing alone would not guarantee synchronization to Link.

## Actual bounds and present attachment

For walk column zero, alpha bounds (right/bottom exclusive) are:

| Row | Bounds inside 64-pixel cell |
|---|---|
| 8 north | (21,12)–(43,34) |
| 9 west | (21,12)–(42,33) |
| 10 south | (21,12)–(43,29) |
| 11 east | (21,12)–(42,33) |

Other walk columns shift vertically by one source pixel at selected phases. At half size that is a half destination pixel, subject to the renderer's sampling; do not assume a clean one-pixel bob.

Current destination origin is `(Hero.X-8, Hero.Y-Hero.Z-Hero.FakeZ+47)` under `DRAW_ORIGIN_SCREEN`, layer 6. Thus the nontransparent hair begins approximately at `(Hero.X+2.5, visualHeroY+53)` before integer rasterization. The +47 is an atlas-placement term in screen coordinates, not a universal native head socket. Its correctness depends on the playfield offset and native pose. The alpha-box horizontal center falls near Hero.X+8, but this does not establish the skull attachment point or cap coverage.

## Native pose differences the overlay ignores

`zquest-classic/src/zc/hero.cpp`, `HeroClass::draw`, uses quest-specific tile selection through `herotile`, animation style, tile extension, flipping and per-action offsets. In particular:

- Slash drawing changes x/y offsets and chooses slash tiles according to attack clock (around 2899–2941).
- Swimming and floating use distinct sprite selections; jumping has separate frame selection (around 3134–3380).
- Holding items uses landhold1/landhold2 sprites (around 3449–3453), with separately positioned held items.
- Casting is handled separately from the ordinary walk/attack selection.
- Dungeon positioning can change y offset by two pixels (around 2810 and 3442).
- Native rendering has under/over-player primitive hooks (2784 onward), unlike a generic layer-6 overlay.

The current hair uses idle walk column zero for **every non-walking action**, including casting, hurt, carrying and attacking. It does not bind to native tile, flip, animation clock, draw offset, visibility or a skull socket. Subtracting Z and FakeZ fixes one positional input; it does not fix those pose differences. Hair can remain visible when the native body uses a different visibility treatment, and fixed layer 6 does not express all canopy/body/shield occlusion.

## Available versus compatible

The local atlas contains cast, thrust, slash, shoot and hurt hair poses. They are available **for the matching LPC body choreography**. None has been established as a drop-in match to the quest's native Link frames. There are no explicit swimming, carrying or native Link spell poses in this 21-row sheet. Reusing a nearby row would conceal missing registration rather than solve it.

A complete transformation needs a compatible body/head costume or native-frame-specific head replacement. It must also resolve the existing cap silhouette; placing new hair over the cap is not proven to remove it. No claim of a complete Super Saiyan costume is justified by this overlay.

## Required next implementation and acceptance

1. Capture native tile/CSet/flip/direction/action and visual offsets for each used idle, walking, sword, charge, cast, lift, carry, throw, swimming, hurt and jump frame. Preserve ground coordinates separately.
2. Author a pose registration table with explicit head socket, replacement/mask strategy, and foreground/background parts. Unsupported frames remain explicit gaps.
3. Synchronize cosmetic frame selection to the actual native animation frame or action phase; do not use wall-clock walk cycling.
4. Use actor-relative draw ordering where supported by the shipped runtime, verified against its actual version. Do not assume the reference engine's latest hooks exist in the deployed WASM.
5. Review all four directions against tree canopy, water, walls, raised terrain and screen transitions at native integer scale, then fullscreen and mobile. Confirm cap coverage, no detached hair, no false ground movement, no shield overlap errors, and matching flicker/invisibility.

This audit establishes atlas layout and specific source mismatches. It does not establish final registration coordinates, visual quality, or multiplayer synchronization.
