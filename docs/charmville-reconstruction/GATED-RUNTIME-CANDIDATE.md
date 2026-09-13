# Gated runtime candidate — September 13, 2026

The user authorizes gated-public PlankSpace play and continued local development. This checkpoint records actual assembly, not deployment or browser acceptance.

## Artifacts

- Input inventory: `work/private-runtime-manifest-20260913-r03.json` — 270 verified inputs, 219,089,782 bytes, no missing/hash issues.
- Self-contained input directory: sibling `charmville-private-input-package-20260913-r03`.
- Transformed candidate directory: sibling `charmville-private-candidate-20260913-r03`.
- Release ID: `alpha01-r03`; target account origin: `https://plank.love`.
- Candidate inventory SHA-256: `f5a039ca5d6db9ba3b9a19c27dd95cac266a2975accd7a387c35e09699bf7ff6`.
- 272 entries, 259 served allowlist entries. Marker is `charmville-runtime-candidate`, `readyToServe:false`; protected serving correctly rejects it.

The assembler copies verified inputs into a new directory, transforms reviewed HTML/main.js and 18 bridge/style sources, emits the joined-homestead metadata and MIDI manifest, and recalculates transformed hashes. Service worker/PWA manifest routes are excluded. Arbitrary quest, inventory and six-party fixture launch parameters are not accepted by the private adapter. Native filesystem paths remain distinct from relocated HTTP URLs.

## Active dependency lanes

1. **Runtime packaging:** transformed candidate exists. Next: authenticated browser loading, cold-cache request coverage, worker/MIDI/sprite checks, then reviewed serving-marker promotion. Do not change the marker merely to silence the gate.
2. **Account integration:** server-selected runtime prefix and cookie bootstrap are now connected to the retained iframe and origin-checked hooks. TypeScript passes. Validate authenticated browser opening, menu continuity and reconnect behavior before declaring accepted; pure bootstrap tests do not substitute for this.
3. **Session lifetime:** cookie-preserving renewal is implemented at `/charmville/runtime/session` and scheduled by the client before expiry. It does not replace the iframe on success. Original session/profile/admission revocation remains authoritative. Backend targeted checks pass; enabled private browser lifecycle and PostgreSQL acceptance remain outstanding.
4. **Release integration:** preserve the separate uncommitted dev merge and main dirty work. Refresh current dev, reconcile changes, then full repository shipping checks and feature→dev→master promotion. No production changes have run in this lane.
5. **Player journey:** retain the local successful prepare→plant→water→gather observation, but do not equate it with authenticated custody. Private acceptance must demonstrate account-backed harvest→Satchel→explicit social pin, reload and independent invited accounts. Continue family/title/home/town work after these dependencies.

Seven adapter/bridge tests pass. The actual candidate assembly succeeded. These do not establish production permissions, multiplayer capacity, long-session continuity, or browser loading acceptance. PostgreSQL acceptance remains outstanding.

## Isolated protected browser checkpoint

The local acceptance mirror now boots through the real authenticated account and protected runtime routes. This is a development-only acceptance environment at `http://localhost:3018`, release `alpha01-local`, using the isolated `charmville_acceptance_20260913` database and a synthetic approved profile. It uses no player wallet signature or assets. The production candidate remains `alpha01-r03` for `https://plank.love` and is not accepted or promoted by this checkpoint.

Evidence in the release integration `work/private-mirror.log`:

- `POST /api/charmville/runtime-session` returned **200**.
- `GET /charmville/runtime/alpha01-local/play` returned **200** with the approved Homestead launch parameters.
- Player script and worker requests for `zplayer.js`, plus `zplayer.data`, returned **200**.
- `reference-data/manifest.json` and `reference-data/quests/charmville/homestead-region/r01/Homestead.qst.gz` returned **200**.
- Sampled runtime bridges, HUD modules and menu artwork returned **200**; no protected runtime asset failure was observed in this bounded log review.
- The root agent confirmed the actual introduction rendered in the live browser canvas by screenshot observation. This is visible boot evidence, beyond unit tests or a policy-only fixture.

Movement, farming, authenticated harvest custody, social pinning, reload recovery, renewal and independent invited-player checks remain pending in this protected environment. The root agent is piloting those paths; record their results separately when observed. Encounter API 403/409/404 responses seen while the account changed locations are application responses and are not evidence of missing runtime files.

The local mirror deliberately differs in origin and release identity. Do not promote the production inventory or change its serving marker based solely on this local introduction. Promotion still requires reviewed acceptance evidence, asset inventory correspondence and the remaining release checks.

### Focused test harness correction

The release world-refresh suite now passes all five tests. Its VM harness extracted the real `load` callback but omitted its imported `requestWorldEntry` helper. Supplying that real dependency corrected the four failures without changing gameplay code or weakening assertions. Targeted ESLint also passed. This is not a claim that the full release suite passes; other full-suite issues remain with the root integration lane.

## Authenticated gameplay acceptance update

The root agent subsequently observed the following in the same local protected mirror, using the real account flow and synthetic test content:

- Cold start, home creation and starter creation completed.
- Prepare → plant → water → harvest completed, and the resulting account state persisted after reload.
- The Treecko follower sprite rendered in the game world.
- Menus and fullscreen transitions retained the same running engine through approximately seven minutes of observation.
- An explicit stamp on the test account's own synthetic post consumed Oran quantity 1 → 0 and produced exactly one receipt.
- An anonymous request for the protected zplayer asset returned HTTP 401.

These observations supersede the earlier pending list only for these specific paths. They do not establish independent invited-player behavior, population scale, all menu/gameplay features, or uninterrupted long-session operation. The subsequent acceptance record below completes renewal, revocation and candidate correspondence.

Release verification checkpoint: required lint, TypeScript and build checks passed on detached `deb9fa81`. The subsequent origin-helper and PostgreSQL 9.6 compatibility changes at `30671ddb` still require their CI rerun; the older passing build does not validate those newer changes. Use the integration branch's current migration numbering and merged dev history as authoritative. Do not blindly copy or renumber migrations from the older main working checkout.

## Accepted private runtime package

The root agent completed all eight required browser acceptance checks: cold start, movement, farming/harvest, reload persistence, explicit social pinning, timed ticket renewal, anonymous denial and revocation denial. The existing runtime cookie received HTTP 403 after its grant was revoked; the grant was subsequently restored. Renewal was observed on the timed path, extending the earlier same-engine continuity evidence.

The reviewed promotion produced a new private release folder, `charmville-private-release-alpha01-r03`, after verifying candidate correspondence and package hashes. Its inventory SHA-256 is `f5a039ca5d6db9ba3b9a19c27dd95cac266a2975accd7a387c35e09699bf7ff6`; the acceptance receipt SHA-256 is `603eed2d393e69f8174c396586f2faed68a5087c1e880ef13c1e62e73f3d3e59`. This supersedes the pending renewal/revocation and unpromoted-package statements above for this exact accepted package.

**The accepted package is not live.** This is local browser acceptance and artifact promotion, not proof of remote deployment. At this checkpoint, legacy CI checks pass and the new build for `30671ddb` is still running. Remote activation, live health/SHA confirmation and protected-route smoke checks remain release gates.

This bounded alpha acceptance does not claim the entire game vision is complete. Independent guest collaboration, large-scale multiplayer, the full opening narrative, all menus and professions, advanced combat, streaming/theatres and the wider social platform still require their own implementation and acceptance evidence. Preserve those outstanding scopes rather than treating this package milestone as full game completion.
