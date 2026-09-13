# Charmville frontier build method

Working brief for Astra, Grok, Opus and other capable coding/art agents. Updated 2026-09-09. Repository: `robinwood-plank-charmville-slice-1`. This is an execution method and design roadmap, not a claim that the whole universe is released.

## Product and test entry

Open [the local playable garden](http://localhost:3017/charmville/play), choose **Start playing**, then **Claim your lot**. This creates an isolated local test identity with owner controls. The existing `/u/charmville_showcase` profile is a visitor view; opening somebody else's garden does not authorize harvesting it. Do not solve disabled owner controls by removing session validation.

The link requires this machine's running development server and isolated database. It is not a public deployment URL. Normal account play remains on `/u/[handle]`, embedded in the PlankSpace board. `/search` exposes reputation search. Keep the game and social identity together.

The visual target is the user-approved woodland garden: readable chibi character, living crop faces, cream and honey carved controls, pale sage foliage, mossy seed cottage, layered botanical edges, warm fixtures, and an inviting world beyond the fence. The target is an interactive game frame, not a painted background hiding unusable controls. A beautiful screenshot cannot substitute for walking, planting, gathering, recovery or ownership.

## First read and source map

Read `AGENTS.md` and `DESIGN.md`. Before changing persistence, marketplace, wallets or deployment, also read `README.md`, `ARCHITECTURE.md` and `CONTRIBUTING.md`. Before writing framework code read the relevant installed Next documentation under `node_modules/next/dist/docs/`. Inspect `git status --short`, current branch, active work ownership and existing local changes. Never reset another agent's work.

| Responsibility | Actual files |
| --- | --- |
| Local playable entry and isolated session | `app/charmville/play/page.tsx`, `playtest.tsx`; `app/api/charmville/local-playtest/route.ts`; `lib/charmville/local-playtest-policy.ts`, `local-playtest-client.ts` |
| Board integration and authenticated actions | `integrations/plankspace-app/app/u/[handle]/page.tsx`; `integrations/plankspace-app/app/charmville/porch.tsx`, `porch.module.css` |
| Scene, controls, coordinates and character | `integrations/plankspace-app/app/charmville/scene.tsx`, `scene.module.css`, `groundskeeper.tsx`, `isometric.ts`, `garden-ground.tsx`, `crop-art.tsx`, `game-icons.tsx`; `lib/charmville/navigation.ts` |
| Layout and interrupted draft recovery | `lib/charmville/layout.ts`, `layout-draft.ts`; porch/scene integration |
| Authoritative yard mutation | `app/api/charmville/[handle]/route.ts`; `lib/charmville/store.ts`; `lib/postgres.ts` |
| Persistent soil/layout schema | `deploy/inmotion/postgres/migrations/104_charmville_soil.sql`, `105_charmville_layout.sql`; preceding PlankSpace migrations provide identities/sessions/posts |
| Reputation | `lib/charmville/reputation.ts`, `reputation-store.ts`, `reputation-search.ts`, `reputation-query.ts`; `app/api/charmville/reputation/route.ts`; board `reputation-search.tsx` and `reputation-filter.tsx` |
| Content runtime | `lib/charmville/content.ts`, generated `content-manifest.json`; `scripts/charmville/pack-cache.mjs`; `public/images/charmville/cache/` |
| Original crops/charms | `scripts/charmville/render_crops.py`, `render_charms.py`, `pack-crops.mjs`; `public/images/charmville/original/`, `charms/` |
| Animated sourced character | `scripts/charmville/render_sourced_character.py`, `pack-character.mjs`; `public/images/charmville/quaternius-farmer/` |
| Original environment workshop | `scripts/charmville/render_workshop.py`; `public/images/charmville/workshop/manifest.json`, `README.md`, `.blend`, `.glb` and PNG assets |
| Checks and screenshots | `test/market/charmville-*.test.ts`; `scripts/charmville/verify-browser.mjs`, `verify-local-entry.mjs`, `verify-layout-draft.mjs`, `verify-reputation-search.mjs`, `measure-frame-timing.mjs` |

The integration directory is source imported by the root application, not a separate application with its own package.json. Run commands from the repository root.

## Architecture that survives more than one renderer

PostgreSQL and authenticated server receipts determine crop outcomes, inventories, spending, stamps and ownership. The existing mutation parser accepts claim, plant, resolve, stamp, tend and layout actions. Keep server timestamps, transactional updates, authorization, idempotency and retry receipts intact. A walking animation must not itself grant a harvest; accepted server state grants it and the character presents it.

The revisioned cache carries stable IDs and presentation. `pack-cache.mjs` hashes assets and definitions, publishes immutable revisions and updates `cache.idx`/`index.json`; the bundled renderer pins `content-manifest.json`. Schema 1 is JSON. Do not call it a proprietary binary cache. Preserve old revisions and validate their hashes. Read `CHARMVILLE-CONTENT-CACHE.md` before editing this contract.

Blender is the editable workshop. PNG atlases are the current small-download renderer format. Workshop GLB files are available for a future WebGL viewer; their presence does not mean the existing renderer consumes glTF. The workshop manifest also contains SHA-256 fingerprints for its 18 asset artifacts. Procedural Blender surface detail is not baked into GLB textures yet.

Introduce a Three.js renderer inside the same board only with a measured need and an equivalent input/state contract. It must read the same IDs and snapshots. Prove no regression in mobile startup, accessibility, frame pacing or authenticated gameplay before switching. An Unreal cinematic or desktop viewer can follow the same content contract later. Neither engine owns the economy. A future server tick, delta protocol, capability handshake and land-value simulation need explicit design and tests; they are not implemented merely by naming them.

## Reproducible art production

The approved image inspected for this pass is:

`C:/Users/k1rby/.codex/generated_images/01a08368-6db2-7fc3-998d-87b3c4637e17/exec-85f406e5-68bb-4eed-9069-3a7f87912478.png`

It is 1536 by 1024. Copy the reference into the ignored `.dream-loop/concept.png` working area when starting an iteration. If that local reference is unavailable to another model, transfer the image with the handoff; do not invent a different target from its filename.

1. Capture the current live frame and record viewport, route, crop state, character position, selected tool and cache revision. Compare at the same aspect ratio and scene state.
2. Write the dominant gaps with measurable changes: character occupies too few pixels; roof lacks silhouette; controls need carved inset depth; bed borders obscure seedlings; foliage has noisy frequency. Fix composition and color before microscopic ornament.
3. Search real creator asset libraries continuously. Consult `CHARMVILLE-ASSET-SOURCES-2026-09-09.md` for checked Quaternius, Kenney, Milady/Remilia VRM and Bobo GLB evidence. Record source URL, creator, exact archive, license text, embedded permissions, format, dimensions/mesh count, rig, animation clips and hash. Distinguish free preview, free subset and paid editable source.
4. Import compatible meshes into Blender and art-direct them: face proportions, silhouette, wardrobe, botanical shapes, materials, custom detail and lighting. Preserve sourced license files. A pack dump is not finished Charmville art. Original assets can be authored directly; preserve named meshes and repeatable scripts.
5. Render transparent, aligned frames. Verify facing from actual movement direction, idle foot placement, turn continuity, pickup contact and alpha fringes. Do not reverse a sprite blindly to hide an incorrectly mapped animation. Keep shadow and foot anchors stable across frames.
6. Repack, integrate and inspect the live browser again. Never declare completion based only on an offline render.

Rebuild the original workshop on this machine:

```powershell
& ../charmville-references/tooling/blender-4.5.9-windows-x64/blender.exe --background --threads 6 --python scripts/charmville/render_workshop.py -- --root public/images/charmville/workshop
node scripts/charmville/pack-cache.mjs
```

Only assets registered by the cache packer enter the published cache. Verify its definitions rather than assuming a newly created directory was discovered automatically. See `scripts/charmville/README.md` for the crop, portrait, boardwalk and character build commands.

Workshop scenery uses a 256 by 192 logical frame, 2:1 orthographic projection, 3.65 world-unit camera width, and ground anchor `[128,132.444]`. Use the 768 by 576 `@3x.png` at the same logical dimensions for zoom and high-density screens. At displayed width W, height is `0.75W`, left is `groundX - 0.5W` and top is `groundY - W*132.444/256`. Sort depth using the ground anchor. The cottage has actual shingles, timber, sage door, brass fixtures, lantern and windowbox; tree models have branches and individual curved leaves. Inspect them at actual in-game size. Turf is a separate quiet 512-square clover material, not an overlay on old noisy grass.

## Multi-model work without integration chaos

One lead owns scope, state contracts, integration and release evidence. Delegate bounded independent file sets. A useful division is: gameplay/input owner, art/workshop owner, content/protocol owner, and independent browser/art reviewer. Adjust to actual available agents; do not claim that naming Grok or Opus invokes those services automatically.

Each assignment must include goal, current evidence, owned paths, forbidden paths, shared interfaces, expected artifact and acceptance checks. Example:

> Own `render_workshop.py` and new workshop assets only. Match the approved cottage/tree palette and camera. Preserve editable Blender source, export transparent PNG plus GLB and a hashed manifest. Do not edit scene, UI, movement or economy. Inspect renders and report anchor, scale, limitations and exact integration paths.

Do not let two workers edit the same scene file. Interface changes go to the lead before implementation. The lead integrates completed artifacts sequentially, runs focused checks, then requests an independent screenshot review. The reviewer reports findings and suggested edits; it does not silently rewrite another owner's files. Send a handoff with changed paths, commands actually run, failures, screenshot paths, current server URL and outstanding uncertainties.

## Playability and visual gates

Test the complete player journey: enter an owned garden, claim, understand tools, walk to a reachable point, select a bed, gather, see accepted inventory, plant, revisit growth, open satchel, place a charm on a post, reload, and recover after an interrupted request. Also test the visitor and expired-session states. Owner-only actions must stay protected; visitor feedback must explain the next available action clearly.

Input acceptance includes mouse target walking; WASD/arrows with text fields protected; touch targets at least 44 CSS pixels; thumb controls without accidental page gestures; tablet rotation; gamepad stick/D-pad and action binding; controller disconnect and focus loss; reduced-motion behavior. Automated gamepad injection validates code paths, not compatibility with every physical controller. Record real-device results separately. Autonomous roaming must stop for deliberate player input, follow walkable space, face its velocity, and never fabricate server actions.

Review the frame against the approved image in order: (1) camera/composition and major scale, (2) light/color/contrast, (3) material identity and depth, (4) fine detail and interaction feedback. A frame missing the main composition cannot score above 3/10; wrong overall light/color caps it at 5; crude dominant materials cap it at 7. Require at least 8/10 plus acceptable measured performance before calling a visual loop complete. Keep the score, blocking directives and follow-up evidence. If repeated tuning stalls, change the asset or composition strategy rather than moving sliders indefinitely.

At 390px phone width, 768px tablet width and desktop, capture all primary tools, satchel, owner/visitor state, loading/error feedback and keyboard focus. Record frame timing during walking and camera movement, not only idle. Set a concrete device target before optimizing; do not equate a powerful desktop result with all phones. Maintain an accessible DOM action path even if rendering later moves to WebGL.

## Local verification and release

Use the existing isolated development configuration. The local entry policy requires development mode, `CHARMVILLE_LOCAL_PLAYTEST=1`, and matching test/PG configuration for localhost PostgreSQL port 55417, user `charmville`, database `postgres`. Do not copy database passwords into documentation or loosen this policy to make a test green. Start with `npm run dev -- --port 3017` only if the port is not already serving the intended checkout.

With the local app and migrated test database running, execute the relevant checks sequentially so fixtures and browser resources remain attributable:

```powershell
npx tsx --test test/market/charmville-navigation.test.ts test/market/charmville-isometric.test.ts test/market/charmville-content-cache.test.ts test/market/charmville-local-playtest.test.ts
node scripts/charmville/verify-local-entry.mjs
node scripts/charmville/verify-browser.mjs
node scripts/charmville/verify-layout-draft.mjs
node scripts/charmville/verify-reputation-search.mjs
```

Database scripts require `CHARMVILLE_TEST_DATABASE_URL`; `CHARMVILLE_TEST_BASE_URL` defaults to localhost:3017. They deliberately reject remote hosts. Review current script output for screenshot destinations. Add meaningful regression coverage for actual behavior changes; avoid tests that only echo implementation constants.

Before shipping, repository rules require `npm run lint:inmotion`, `npx tsc --noEmit`, `npm test` and `npm run build`. Report failures and skips explicitly; an old passing count is not current evidence. Preserve immutable cache history and publish assets before activating clients. Follow the repository release branch rules: master deploys; never push there as a casual development save. A release report contains the actual link, tested behavior, date/commit, remaining limitations and any device coverage gaps. Do not label this a completed galactic game because farm tests pass.

## Unified universe design — future work, not shipped economy

Charms are expressive social objects: emoji/sticker art, face identity, layers, effects, rarity presentation and provenance tied to a player's PlankSpace satchel. The long-term design connects gameplay earnings, the Grained Exchange and player-to-player offers. Existing rendered charm portraits are not yet the full layered SVG/animated sticker system or that complete exchange.

Design the sticker format as data: stable charm ID, sanitized base SVG or raster layer, optional frame/foil/particle layers, effect timing, reduced-motion fallback, thumbnail, text alternative and provenance references. Render the same identity on posts, satchel, listings and inspection views. Never execute arbitrary uploaded SVG scripts or remote references. Visual variants must not counterfeit authoritative quantity or ownership.

| Progression design | Feeling and content | Systems required before release |
| --- | --- | --- |
| Humble garden | Six beds, a seed cottage, expressive crops, first charms | Reliable existing farm loop, clear ownership, approachable controls |
| Settler hamlet | Forest crafts, neighbors, small workshops, varied feminine/masculine wardrobe | Craft definitions, visit/presence protocol, progression saves and accessible customization |
| Living town | Streets, markets, civic gardens, worker routines | Server-backed trade/escrow, production queues, constrained worker simulation and tested land rules |
| Cypherpunk port | Pastel machinery, neon trims, shipping guilds, industrial gardens | Logistics, resource sinks, auditable orders and cross-device continuity |
| Orbital nursery | Greenhouses among stars, cute ships, small colonies | Region streaming, travel rules, colony persistence and compatible client content revisions |
| Multiplanetary commons | Many worlds, federated settlements, galactic cooperation and rivalry | Durable simulation partitions, economy controls, abuse resistance, infrastructure and performance evidence |

These are cohesive chapters, not unrelated art packs. Carry the same rounded readable silhouettes, eyes, expressive faces, material family and charm identity from primitive farmer to space settler. Milady/Remilia fashion and memetic vocabulary can inform expressive identity; specific imported art must retain its applicable permission. Do not assume Pepe, Bobo, Mog or Wojak files are all unrestricted because they are common online.

Current code contains a local owner playtest, board garden, server-backed yard actions, layout persistence, reputation search, cache foundation and original/sourced editable art. Controls and visual integration are under active iteration; verify the current build. Full live multiplayer presence, autonomous economic peons, the complete Grained Exchange, layered sticker pipeline, universal device certification, caster continuity and galactic simulation remain work to design, implement and prove.
