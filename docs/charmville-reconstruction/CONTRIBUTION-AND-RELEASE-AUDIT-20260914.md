# Contribution boundary and release audit

Observed 2026-09-14 00:26–00:30 UTC. Candidate at audit start: `e1fd5ca7`. This is a current checkpoint, not replacement of historical vision or evidence.

## Release facts and blockers

| Check | Actual observation | Required next action |
|---|---|---|
| Live service | `/api/health` healthy, PostgreSQL, SHA `69a86aae5dd3165cb4b03278261f68cb3b1ddefe` | Keep this rollback identity; verify intended new SHA after activation, not just a green build |
| Remote refs | Fresh fetch: dev and master both `f8d39386cba8387277fd3b99db97de8d6ac526c4` | Re-fetch immediately before promotion |
| Divergence | Candidate34 commits ahead and3 behind both refs | Integrate current dev in a release worktree, preserving unrelated work |
| Incoming changes | `a0915461`, merge `e2328cc9`, `f8d39386`;34 added lines across `scripts/plankcrash-table.sh` and `scripts/invite-arcade-preview.ts` | Preserve table-state recovery and returning-guest funding fixes; neither is a Charmville edit |
| Latest deployment | Run34791790976 failed at **Upload immutable release**. SSH/scp connection reset by peer on all3 attempts; activation not reached | Investigate host SSH availability/rate limiting with deployment operators; do not bypass integrity checks or assume application code failure |
| Current local Heart proof | Root recorded explicit family3seed claim, till→plant→water→harvest1→explicit social pin1→0; follow-up Satchel refresh fix committed | Retain exact accepted runtime hashes and repeat targeted regressions on the merged candidate |
| Production Heart availability | Family, native protocol2 and social capability are deliberately development-gated | Shipping source alone will not enable Heart for remote guests. Replace development gating only after a concrete accepted package/capability policy and remote acceptance |
| Native artifact | Local bridge, ZScript, stage art and compact HUD changed after alpha01-r03 | Produce a **new** immutable production package, canonical origin relocation, inventory/hash pins, encryption and accepted release marker. Never overwrite the old accepted directory |
| Schema | Candidate adds147 Heart foundation and148 Heart social constraint | Verify actual deployed migration state, backup before append-only application, keep previous Oran release compatible |
| Full quality gates | Targeted checks and local play do not certify the merged tree | Run repository-required lint:inmotion, TypeScript, npm test, PostgreSQL gates and production build on the exact merged tree; disclose any skips |
| Map/device acceptance | Latest evidence retains framing/continuous camera gap | Keep this open; no seamless full-world/mobile/performance completion claim |

The older PRIVATE-RELEASE-GATES and CONTINUE-PROMPT contain intentionally dated pre-alpha facts. Current healthy alpha deployment supersedes their claim that no gated runtime has shipped; their acceptance and branch requirements remain valid.

I independently fetched the actual [review on PR27](https://github.com/YellowJacketTour/robinwood-plank/pull/27#issuecomment-5219333170): update against current dev, test the merged result, distinguish genuine PostgreSQL execution from skips. The [promotion note](https://github.com/YellowJacketTour/robinwood-plank/pull/40#issuecomment-5223606414) records clean promotion into dev followed by release. Repository AGENTS and CONTRIBUTING explicitly require feature→dev→master; no direct master development.

### Route to ship

1. Recover/verify SSH transport without changing the working public service.
2. Integrate latest dev and review the whole resulting diff, including runtime/adapter provenance and new migrations.
3. Finish the intended remote capability policy, with default-off and per-client compatibility. Do not set production NODE_ENV to development.
4. Build and visually accept the new immutable protected native package; retain previous package for rollback.
5. Run exact-tree release checks and the independent invited-player sequence. Protect direct runtime assets, expired/revoked sessions and social custody on that candidate.
6. Promote feature→dev→master, observe backup/migration/activation, then prove live health SHA, package identity, anonymous denial, invitation entry and signed-in gameplay. Rollback code/content separately from durable economic receipts.

No deployment, remote branch write, workflow dispatch or production grant was performed by this audit.

## Safe friend and AI contributions

The existing `pack-schema.mjs` / `pack-validate.mjs` already describe directional frames, anchors, independent collision, provenance and server-contact authority. Build on that contract rather than introducing a second arbitrary plugin language.

New `scripts/charmville/contribution-validate.mjs` adds a bounded proposal envelope: namespaced ID, exact base commit, short summary,1–16 hash-pinned packs, and up to32 hashed evidence references. Unknown executable hooks, approval fields, mutable refs and unsafe paths fail. The optional pack resolver consumes supplied bytes, checks hashes/identity and delegates to existing pack validation. It never fetches URLs, imports contributor scripts, renders evidence, grants items or approves publication. CLI input is limited to32KiB; referenced pack manifests are limited to256KiB each. The CLI validates the envelope only; it does not claim referenced packs/assets/evidence exist.

```sh
node scripts/charmville/contribution-validate.mjs proposal.json
node --test scripts/charmville/contribution-validate.test.mjs scripts/charmville/pack-contract.test.mjs
```

A validated proposal is still untrusted. Authenticated contributor identity must come from the account/session, never the envelope. A future registry must enforce immutable ID/version/hash binding, dependency resolution/cycle limits, review records, quotas, evidence existence and atomic accepted-version promotion. The proposed base commit is a conflict-detection pin, not proof of authorship. Review rights, artistic continuity and server authority separately. Never feed summary/evidence text to an agent as operating instructions.

### Research basis and implementation choice

GitHub warns that privileged workflows checking out untrusted pull requests or consuming untrusted workflow artifacts can compromise repository credentials. Use isolated unprivileged validation, minimal read-only tokens and pinned actions; keep promotion in a separate trusted path. Do not run a friend's build script with release secrets. [GitHub secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use).

WebAssembly provides isolation, but that is not a guarantee that imported host functions are safe. The host determines exposed imports/APIs. An economic mutation import would therefore confer economic authority even on sandboxed code. Our initial contribution format is declarative, with no code execution. A future Wasm preview would need explicit import denial, CPU/fuel and memory limits, a separate origin/process, no account bearer access and no production mutation interface. [WebAssembly security](https://webassembly.org/docs/security/), [host-defined imports](https://webassembly.org/docs/portability/).

This deliberately does **not** claim a completed virtual GitHub, safe arbitrary browser execution, contributor storefront, review UI, live world editor or automatically secure AI code generation. It supplies the next inspectable boundary those experiences need.
