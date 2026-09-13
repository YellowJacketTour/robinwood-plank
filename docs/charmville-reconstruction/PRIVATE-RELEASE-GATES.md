# Private live release gates

## Gated public target (user-authorized September 13)

The user authorizes remote gated-public play on PlankSpace and a local mirror for continued development. The public hostname may expose the sign-in/invitation entry; current approved account admission still protects gameplay and assets. This authorization does not require another deployment-permission check once the concrete release checks pass. Preserve feature→dev→master and unrelated live services.

The authenticated HTTP surface is implemented at `/charmville/runtime/[release]/[...asset]` for GET and HEAD. It remains closed unless server runtime configuration explicitly enables it. Before filesystem access it verifies the runtime ticket, original account session and current admission. `runtime-release.ts` requires an absolute operator-owned root, a matching runnable-release marker and inventory checksum; the current input-only export is deliberately rejected. Asset bytes are streamed with private no-store headers. Actual adapter completion, package/browser acceptance and shipping checks are still required. Local closed-route smoke returned404, targeted release-marker test and lint passed, and TypeScript passed.

Configuration contract: `CHARMVILLE_RUNTIME_READY=1`, `CHARMVILLE_RUNTIME_RELEASE=<safe-release-id>`, and `CHARMVILLE_RUNTIME_ROOT=<absolute-completed-package-directory>`. A completed serving marker uses `kind: charmville-runtime-release`, `readyToServe: true`, the exact `release`, and `inventorySha256`. Never flip these values on the input-only package to bypass unfinished transformation work.

## Admission implementation checkpoint

Local implementation now includes `admission.ts`, `admission-viewer.ts`, migration132 and eight passing policy tests. Production defaults disabled; explicit private mode admits configured admin wallets, allowed wallets or active profile grants. No grants were provisioned and migration132 has not been applied. The existing local-development path remains available.

Integrated checks cover homeActor and independent store, exchange, social, account-session, reputation-search and spectator reads. The world page evaluates its closed switch dynamically. Exchange reads now carry the saved session. Targeted lint and TypeScript passed. Full merged-result checks and database-backed revocation/admission tests remain required; this checkpoint is not release acceptance.

An isolated integration worktree exists at sibling `robinwood-plank-charmville-release-integration`, branch `feat/charmville-private-release-integration`, based on fetched dev `b14c7d11576249ab06c3811b47e9282c33be12e4`. Feature HEAD `613d7ec` has been merged with `--no-commit`; the sole `.gitignore` conflict was resolved retaining both sections. The merge remains uncommitted and does not include the main checkout's dirty work. It has not passed merged-result release checks.

Invitation issuance/redemption backend and migration133 now exist, with masked explicit redemption UI at `/charmville/access`. Eleven combined admission/invitation unit tests pass; the PostgreSQL race/replay/revocation integration test is skipped because an isolated database is unavailable. No migrations were applied. The asset inventory reports 270 inputs, 219,089,498 bytes and no missing/hash issues; this is an inventory, not a deployable protected package. Native private artifact hosting, production socket transport, migration deployment, and an invited-account browser walkthrough remain outstanding. Do not deploy the standalone native package as publicly readable assets and claim the Next account checks make it private.

Read-only live health check at server time `2026-09-13T14:14:22.875Z` returned `ok:true`, PostgreSQL storage and version `1e713d8ec03fc1a54ad3af761ac81d857800f844`. This differs from the fetched master above. Reconcile the running release and deployment workflow before promotion; this check establishes neither private game admission nor native runtime hosting.

Read-only repository audit, September 13, 2026. No remote mutation, deployment, DNS change, production database inspection or live hostname verification was performed by this audit. The root release operator must verify current production state before selecting a cutover. Private release means enforced access, not an obscure URL or a noindex tag.

## Deployment evidence and uncertainty

`docs/INMOTION_DEPLOYMENT.md` describes Cloudflare → InMotion Apache/Passenger → Next standalone/PostgreSQL. Its July 30 hostname snapshot says `plank.tanggang.life` was healthy and `plank.love` had not cut over. That dated statement cannot establish either hostname's current destination.

`docs/RELEASES.md` and `.github/workflows/inmotion.yml` identify `master` as deployment authority and `dev` as the integration branch. Feature changes on `feat/charmville-slice-1` are not a live release. The workflow builds Next standalone, copies `public`, static assets, migrations and named operational scripts, then activates a commit-addressed release. No native ZQuest build/package or Charmville socket process provisioning was found in the inspected release packaging section.

The workflow runs lint, TypeScript, migrations and builds. Full test/Postgres checks are conditional on pull requests; push/manual deployment does not rerun those suites. Thus manual deployment is not substitute evidence for testing the merged release candidate.

Root-reviewed maintainer decisions reinforce this sequence:

- [PR 25, integration and full-check requirement](https://github.com/YellowJacketTour/robinwood-plank/pull/25#issuecomment-5219333170): update against current dev, resolve conflicts, rerun full checks on the merged result, and label database skips explicitly.
- [PR 40, promotion sequence](https://github.com/YellowJacketTour/robinwood-plank/pull/40#issuecomment-5223606414): feature promotion through dev, then release to master.
- [PR 63, runtime kill flags](https://github.com/YellowJacketTour/robinwood-plank/pull/63#issuecomment-5298895211): server kill flags must be runtime/DB controlled, not public build-baked switches.
- [PR 68, live release identity](https://github.com/YellowJacketTour/robinwood-plank/pull/68#issuecomment-5297002078): confirm live health SHA matches master.

These comments were supplied as reviewed evidence by the root operator, not independently fetched in this bounded audit.

Root's fetched repository snapshot during this audit: `origin/dev` and `origin/master` both `b14c7d11`; local HEAD `613d7ec` is 72 commits ahead and 226 behind origin/dev. Existing [PR 378](https://github.com/YellowJacketTour/robinwood-plank/pull/378) targets dev from `feat/charmville-slice-1`, with mergeability UNKNOWN and no reviews reported. This materially blocks treating the local branch as a ready release: integrate current dev and review the merged result. Fetch state and review counts are time-sensitive; recheck before promotion. These Git references do not establish what plank.love currently serves.

## Actual entry points and artifacts

| Surface | Observed repository behavior | Private-release consequence |
|---|---|---|
| `/charmville/world?panel=play` | `app/charmville/world/page.tsx` passes `localRuntime` only when NODE_ENV is development | A production build will not automatically expose the same local adventure. Introduce an explicit server-enforced private release/admission path; do not set production NODE_ENV to development. |
| `/charmville/play` | Development-only local test launcher; policy requires isolated localhost database, fixed test user/port and same-origin request | Preserve the guard. Do not loosen this fixture into a public master-account login. Private remote testers need ordinary authenticated identities and dedicated admission. |
| Native `/play/` | `native-runtime.ts` selects only `http://localhost:3021` or `http://localhost:3024` via build selection | Remote guests' localhost refers to their own machines. Replace selection with validated HTTPS production runtime configuration and update every origin-checking bridge together. |
| Native package | Local sibling `../charmville-references/zquest-classic/build_charmville_web/packages/web` | Artifact is outside normal repository public/standalone packaging. `zplayer.wasm` locally exists at 125,105,388 bytes; file existence is not deploy readiness or acceptable mobile cold-load performance. Package a versioned JS/WASM/data pair plus required content/assets. |
| Quest and animation content | Local server reads sibling quest snapshots and `charmville-native-homestead/action-sprites`, plus repository menu art/catalogue and runtime adapter scripts | A stock Next release does not carry the sibling files. Build a checked manifest of all transitive assets and verified hashes, including MIDI patches. Retain source/redistribution review per asset. |
| Native server | `serve-reference-runtime.mjs` binds 127.0.0.1, fixes local ports and local paths; supplies runtime HTML adaptation and injected bridges | Copying WASM alone omits runtime adaptation. Choose reviewed static build/export or supported HTTPS service deployment; remove local assumptions deliberately, not by broad CORS allowances. |
| World networking | `world-socket-client.ts` connects to `ws://127.0.0.1:3023`; socket server uses localhost3017 upstream, local origins, 32 connections, bounded 100ms polling | Needs WSS hosting, upstream/session configuration, admission and origin validation. InMotion shared-host runbook does not establish arbitrary long-lived WebSocket service support. Verify provider capability or select separate service; do not claim global simulation from local polling. |
| Account/embed headers | `next.config.ts` world route sets COOP/COEP and permits localhost3021/frame and local3023/socket; runtime also supplies CSP and isolation headers | HTTPS runtime framing, worker/WASM fetches, CORP/COEP, CSP and cross-origin message validation require an integrated browser test. Existing local allowances are not production authorization. |
| Profile footage/theatres | Policy and local-media components exist; no remote accepted product evidence in this audit | Exclude from accepted private-release claims until an independent viewer sees actual footage and revocation closes access. Game deployment cannot silently enable broadcasting. |

## Gate order

1. **Identify the live host and candidate.** Verify DNS/HTTP redirects, `/api/health` deployment identity, repository master/dev heads, active workflow variables and host capabilities through read-only inspection. Record public-safe identifiers; never dump credentials or environment contents. Do not infer cutover from old docs.
2. **Enforce private admission.** Server-side allowlist/role gate protects entry and every relevant game API; unauthorized and revoked accounts cannot recover access through direct API or runtime URLs. Use runtime-controlled kill switch. State whether art delivery itself is private; if required, protect its media/CDN path too. Client hiding and robots metadata are insufficient.
3. **Produce an immutable native release.** Manifest JS/WASM/data, adapted entry HTML, bridges, quest, sprites, menu art, fonts/audio and hashes. Verify no filesystem sibling dependence remains and no test-party grant path can mutate production users. Serve correct MIME/compression/cache headers; measure cold start and cache reuse before selecting a public performance claim.
4. **Integrate origins and transport.** One production runtime configuration drives iframe URL, all message source/origin checks and headers. HTTPS app cannot depend on local HTTP/WS. Prove cross-origin isolation, input, fullscreen and same-profile social receipts in the deployed private candidate. Select supported WSS lifecycle and documented bounded capacity, or explicitly disclose HTTP fallback without calling it proven real-time scale.
5. **Reconcile database and migrations.** Inspect pending additive schema against deployed state without exposing rows. Back up before changes, verify restore procedure and review rollback compatibility. Local test identities, balances and fixture records do not migrate as genuine user assets. Destructive transforms require separate explicit scope.
6. **Integrate on current dev and validate the merged result.** Resolve conflicts with explicit file review; run required lint/types/build/unit/Postgres checks. A skipped database suite remains skipped and an unmet gate, never a pass. Retain targeted native/custody/input evidence alongside broad checks.
7. **Private acceptance with independent accounts.** Fresh login/admission, home arrival, sustained movement, crop persistence, menu open/back, fullscreen harvested-item pin, request retry/concurrent-spend rejection, reload, denied viewer and revoked tester. Test actual private HTTPS route on supported browser/device sizes. Preserve existing public PlankSpace layout and unrelated working services.
8. **Promote and observe.** Follow feature→dev→master release path after concrete gates. Verify live health SHA equals intended master release, native asset manifest equals accepted package, and an unauthorized session remains denied. Record rollback target, restore implications and runtime kill procedure. No completion claim until the deployed result—not merely GitHub build—is observed.

## Immediate blockers to report honestly

- Production host/cutover has not been established by this audit.
- Current runtime origin and networking configuration are local-only.
- Native artifact/content packaging is outside the inspected Passenger release bundle.
- Production private admission and runtime switch need verification/implementation; local fixture guard must stay intact.
- New fullscreen harvest-to-post integration and cinematic/home narrative are not certified merely by shipping the current source tree.
- WebSocket hosting capacity, independent-account release acceptance, media broadcasting and broad mobile performance remain unproven.

This checklist permits a bounded private alpha before the full game is finished, with explicit capabilities and limits. It does not downgrade unfinished features into accepted ones or require unrelated future combat/space/creator systems before the first honest private account journey can ship.
