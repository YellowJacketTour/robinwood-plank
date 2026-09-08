# Charmville Phase A - Soil

Base: origin/dev at fd36834; branch feat/charmville-slice-1. The owner's ONE-SHOT BUILD CONSTITUTION
supersedes older interview wording. No production migration, deployment or master push has occurred.

The existing `/u/[handle]` Feed now renders composer, inline porch, then posts. The porch uses the
existing PlankSpace session. It includes six permanently tilled plots, Stalk/Splinter lifecycle,
satchel, local self-stamp and neighbor tend. Rendering uses licensed terrain and original animated
Blender crops; owner page chrome remains outside the scoped game styles.

## Storage and action rules

Migration 104 adds charmville_yards, plots, stacks, seeds, receipts, stamps and tends. Profile/post
references match the actual BIGSERIAL migration keys. The migration is additive; no public book exists.

Claim grants two ripe Stalk plots, two unplanted Stalk seeds, one Splinter seed and 2 grain, once.
The two planted starter seeds are additional accounted stock. Public GET never grants anything.
Stalk plant costs one seed and zero grain. Splinter costs one seed plus 2 grain. Timers are 4h/16h,
then a 48h ripe window. Harvest/compost returns exactly one seed; compost returns no faces.
Current Phase A tuning is three harvested faces and one grain crumb. Later dynamic glut tuning is pending.

Mutations derive identity from the bearer session, lock the relevant profile/plot state, compare
revisions and commit inventory plus receipt together. Stable request ids replay the original result;
changed payloads reject. Plot-cycle resolution is unique. Private inventory stays owner-only.
Self-stamp consumes one Stalk onto an owned Grain with no Rings. Tend rewards are capped at five/day,
one per target/day; care changes appearance, not crop timer or yield. No offline mutation queue.

## Artwork and runtime

The projected scene replaces the temporary rotated CSS plot cards. Ground diamonds and pick areas
share coordinates; tall sprite transparency does not intercept neighboring plots. Six original
crop atlases contain seedling/growing/ripe stages and eight real rendered poses each. The renderer
reads anchor and frame metadata, pauses offscreen, and respects reduced motion. Zoom and mobile
horizontal navigation stay on the board. Satchel is a draggable desktop window / mobile sheet.

Read CHARMVILLE-ART-RESEARCH.md, CHARMVILLE-SOURCE-CATALOG.json, and scripts/charmville/README.md.

## Verification (2026-09-07)

- Migrations 001-104 applied to isolated local PostgreSQL; migration 104 repeated in a fresh schema.
- PostgreSQL tests: owner authorization, concurrent harvest rejection, retry replay, zero-grain
  Stalk, failed Splinter rollback, one-seed returns, compost, neighbor caps and self-stamps.
- Sprite tests: projection round trips, lifecycle boundaries, frame dimensions/alpha and eight
  distinct renders per atlas.
- Browser test: synthetic local session on real board; claim, harvest without new signature,
  seed return, replant, animation, reduced motion, one 390px satchel, no /api/x requests.
- TypeScript, lint:inmotion and production build passed. Scoped lint has two warnings in Porch
  (epoch invalidation cleanup and small official img), no errors.
- Full npm test: 212 contract tests passed. Market tests: 1301 passed, 46 skipped, one failure in
  unchanged server-feature-flags.test.ts for market/multichain/discovery/magiceden-m2-sweep.ts.
  Neither the guard nor that module changed here. The full suite is not green.

## Still unfinished

Full first-open/WoodAmp acceptance review and final art approval.
The eight starter trees can now be arranged on unoccupied lawn cells and saved to the server.
Migration 105 stores scenery with its own revision; crop footprints cannot be occupied.
Stale saves reject and retain the in-memory draft; cancel/reopen loads the saved version.
Draft persistence across devices and additional decoration types remain unfinished.
Expanded lot currently provides more viewing space. The other five face expression sets and later
phases remain unfinished. This branch is not a claim that the total unified vision is complete.

## Latest integration check

Merged origin/dev, matching active master 17a5ba2, into this feature branch.
The shared wallet components already matched master; local public build variables
were missing. Loaded the deployment's two public wallet variables into ignored
.env.local and verified Reown picker plus a rendered WalletConnect QR. Actual
wallet approval/login remains an interactive user step. The configuration helper
in scripts/charmville reproduces this without importing production secrets.

Full suite after upstream merge: 212 contract tests passed; market 1304 passed,
49 skipped, zero failed. The historical failure above was resolved upstream.
Targeted PostgreSQL and sprite tests passed; browser save/reload checks passed.
