# Charmville: context-free recovery and continuation

Recovery opening updated: 2026-09-12. This directory is the durable handoff; chat history is not required.

## Read this before changing anything

Charmville is the user's intended flagship living world for PlankSpace, not a small farming widget. The user has repeatedly rejected the present garden and sparse 3D frontier as far below the desired art and gameplay quality. Do not interpret existing screenshots, passing tests, the existence of a route, or earlier optimistic status reports as acceptance. Do not replace the vision with an easy miniature demo.

The immediate reason for this handoff is an account transition. The user asked to commit the complete current work to GitHub, preserve all acquired assets/repos/plans, and supply a one-shot prompt that can survive additional development. Always read the latest `CURRENT-STATE.md`, `NEXT-STEPS.md`, archive manifests and Git history. Those supersede the dated snapshot in a copied prompt. Update them whenever work changes, especially before ending a turn. A model or account change is not a reason to restart the project.

## Where the work lives

- Application: https://github.com/YellowJacketTour/robinwood-plank
- Work branch: `feat/charmville-slice-1`. Continue here unless the user changes branch policy. `master` is production deployment; do not push it for a development backup.
- Private reference vault: https://github.com/YellowJacketTour/charmville-reconstruction-vault
- Reference release: `checkpoint-2026-09-09`. Read its manifest and release status before assuming upload completion.
- Existing Windows checkout: `C:\Users\k1rby\OneDrive\Desktop\SpacePoker\robinwood-plank-charmville-slice-1`
- Existing source collection: sibling `charmville-references`.
- Existing local backup archives: sibling `charmville-backup-archives`.
- Previous chat output documents: `C:\Users\k1rby\Documents\Codex\2026-09-09\hel\outputs`; durable copies are under this directory and the private vault.

The main repository is public. Third-party source snapshots and the large editable asset collection are in the private vault's release assets, not stuffed into the app's public web folder. The application has its own existing history and infrastructure. Preserve it.

## Required reading order

1. This document, `CURRENT-STATE.md`, `REQUIREMENT-COVERAGE-AUDIT.md`, `NEXT-STEPS.md`, `CONTINUE-PROMPT.md`; then the latest dated `FEATURE-PROGRESS.md` checkpoint and Git history.
2. `../CHARMVILLE-FULL-PRODUCT-VISION-2026-09-09.md` — full cross-product vision.
3. `../CHARMVILLE-RECONSTRUCTION-BLUEPRINT-2026-09-09.md` — source fidelity, binding choices, architecture, behavior contracts, staged acceptance.
4. `../CHARMVILLE-EXISTING-GAME-FOUNDATION-AUDIT-2026-09-09.md` and the research documents copied into `research/`.
5. `USER-INTENT.md` — direct requirements and precise interpretation.
   Also read `CREATURE-AND-QUEST-CONTRACT.md`: shared creature HP/status across action/staged battles, following/evolution, reusable authored quests, and properties connected to world regions.
6. Repo root `AGENTS.md`, `DESIGN.md`, `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`; relevant shipped Next documentation before Next changes.
7. `source-evidence/source-lock.json`, individual manifests, and vault `archive-manifest.json`.
8. `ENGINE-INTEGRATION.md` for the subsequent native authoring roundtrip and compiled-but-not-attached network probe. Do not repeat that investigation or assume compilation equals runtime integration.

Historical documents describe successive experiments; this directory explicitly records superseded choices. The default target is rich top-down/oblique adventure artwork, not diamond-isometric minimalist 3D scenery.

## Restoring on this computer

Do not reclone or overwrite an existing dirty directory. Inspect `git status`, branch, remote, ongoing servers and the manifests first. Files survive independently of an account login unless the user separately removes them. Do not assume either that a subscription change erases local files or that it preserves chat access.

With an existing checkout, fetch the work branch and compare it without discarding local changes. With no checkout:

```powershell
git clone --branch feat/charmville-slice-1 https://github.com/YellowJacketTour/robinwood-plank.git robinwood-plank-charmville-slice-1
git clone https://github.com/YellowJacketTour/charmville-reconstruction-vault.git
```

The private clone requires GitHub authentication as an authorized account. Never ask the user to paste tokens into chat. Authenticate through their usual GitHub tooling.

Download release assets into a new directory using `gh release download checkpoint-2026-09-09 --repo YellowJacketTour/charmville-reconstruction-vault --dir <new-archive-directory>`. Verify each byte length and SHA-256 against the committed `archive-manifest.json` before extracting. Use `scripts/charmville/restore-reference-archives.mjs` with an empty destination; it validates hashes and archive paths. Extracted top-level directories belong inside sibling `charmville-references`. These archives preserve downloaded editable art and Git/LFS data as acquired. Missing upstream dependencies remain missing; restoration cannot invent them.

Archive exclusions: `.env*`, `node_modules`, `.next`, and `__pycache__`. Do not expect production credentials, wallet private keys, browser cookies, authenticated sessions, or database records in this backup. The toolchain archive includes acquired Blender resources; Node dependencies reinstall from the app lockfile. Saved games in browser storage are browser state, not source archives.

## Running locally

Use the repository's supported Node version and installed dependency lock. Inspect running services first. The current unified entry is `http://localhost:3017/charmville/world?panel=play`, with native runtime on port 3021 and local authenticated socket gateway on port 3023. The standalone garden is retired; do not restore `/charmville/frontier` or the old garden as the product.

For an isolated local test profile use `/charmville/play`, the development-only account launcher. It requires the existing isolated PostgreSQL configuration and local-playtest environment guards. Read `lib/charmville/local-playtest-policy.ts` and `scripts/charmville/README.md`; preserve host/environment checks and never expose synthetic credentials through a public tunnel. Local test login survives navigation into the world. This is not production account provisioning.

Native and socket startup commands are `node scripts/charmville/serve-reference-runtime.mjs` and `node scripts/charmville/serve-world-socket.mjs`. The native server uses the restored sibling reference collection and authored Homestead quest. Use the integrated world launcher rather than manually opening the original Hero of Dreams introduction. Native source-quest links and endgame equipment laboratories remain diagnostics, not the ordinary first-player experience. Consult current scripts for their exact environment requirements; do not print secret environment values.

Current local integration includes authenticated movement, bounded peers, Oran settlement and companion encounter/capture systems. It still lacks the complete distinct-map tutorial-to-public-world MMO experience. Read the coverage audit before choosing work; do not repeat the original unauthenticated transport prototype.

`http://localhost:3021/create/` is the upstream quest editor, not a custom Charmville editor. Editor boot has only had a basic check. Protected authored quests may not expose unrestricted editing; do not promise that every downloaded quest is an editable tileset. Preserve original copies and author credits.

`acquire-zquest-runtime.mjs` can redownload the latest official hosted runtime. For exact recovery, restore archived bytes instead: redownloading is not revision-pinned. Its adaptations preserve original HTML, disable the service worker/analytics loader, and load data before the engine to fix the initialization race. MIDI instruments come from the acquired source tree. Hosted binary/source revision equivalence remains unverified. After the initial backup, the local server was adapted to serve three preserved quest snapshots and their index from `/reference-data/`. The wrapper is adapted in transit; archived WASM/quest bytes remain unchanged. Fresh startup, quest opening and repeat startup passed with external network blocked. The archived `zquest-quest-snapshots` directory is now required alongside the runtime.

The newer `/charmville/catalog` route exposes 435 original item definitions (377 Emerald slots including unused/default entries and 58 Solarus DX item scripts). `index-reference-items.mjs` derives it from the acquired sources. It connects item IDs, source callbacks, source PNGs/palettes, sprite-frame anchors, revisions and hashes. This is an inspection/reconstruction catalog, not an implemented gameplay inventory; runtime palette substitutions are recorded separately from original PNG previews.

## How to continue without losing fidelity

The user wants source behavior, not vaguely matching colors. Preserve original sprite anchors, directional frame order, movement/acceleration, attack timing, collision, item rules, audio cues, camera, maps, warps and save behavior as a named profile. Do not globally replace one game's movement with another's and call it faithful. Capture reference behavior and compare before adding systems.

The architecture needs one authoritative account/inventory/economy with explicit adapters to game profiles. Running an upstream single-player engine in a tab is a reference milestone, not MMO integration. Never let a browser save, localStorage counter or unsigned client event mint scarce charms or settle trades. Do not attach an untrusted imported runtime directly to PlankSpace auth credentials.

The first integrated acceptance loop is: enter a rich woodland; move and collide correctly; cut grass/use a sword; till, plant, water and harvest; earn a skill progression; acquire an item in a real unified inventory; enter/exit a portal; encounter and capture a creature; another authenticated player sees the durable outcome; a bounded social reaction and exchange action use the same item identity without duplication. Deliver and verify this vertical slice before claiming the civilization simulator is established.

## Verification and backups

Before shipping, run the repository-mandated lint, typecheck, tests and build. Use real browser observations for artwork and controls; code tests alone do not show artistic acceptance. Keep a status matrix distinguishing located, acquired, reproducible, running, behavior-verified, adapted, integrated and reconstructed.

Commit explicit paths, preserve unrelated work, and push the work branch. Update `CURRENT-STATE.md` with exact changes, verified links, failures and next task. Add source acquisitions to version/hash manifests and append a new private release/checkpoint; never silently replace an old checksummed archive. Keep the continuation prompt pointing to the latest committed state so it remains useful after further work.


Historical audit (2026-09-09; superseded by subsequent checkpoints): [ANIMATION-AND-INTEGRATION-AUDIT.md](ANIMATION-AND-INTEGRATION-AUDIT.md) records native animation evidence and new source acquisitions. The actual browser editor is version 212 and rejects the `websocket` type with T047. Native version 219 compiles the probe, but its saved quest is rejected by this browser player. No network frames or combined farming/creature/skills gameplay have been demonstrated. First integration gate: use a matched editor/compiler/player build, then verify one authoritative planted plot and harvested inventory/XP transaction in the native world. The existing adventure remains an unmodified source quest in nonpersistent test mode.
