# Charmville / PlankCaster working design pack

2026-09-07. Design and architecture draft; not a released game or verified universal poster.

Canonical repo: https://github.com/YellowJacketTour/robinwood-plank
Working base: `ce970d8af62763cab7f52b09b48802a51743d0a9` (origin/dev).
Working branch: `feat/charmville-design`. Original master checkout is untouched.

Read `CONTINUITY-BOUNDARIES.md`, `CHARMVILLE.md`, `IDENTITY-AND-CASTER.md`,
`PINING-CONTINUITY.md`, `SCHEMA-DRAFT.md`, and `IMPLEMENTATION-MAP.md` together.
Implementation is paused for pack review. This pack contains specifications, not application code.
The copied DESIGN.md governs brand; later user decisions below supersede older interview wording.
Original briefs are preserved under interview/. They contain historical research claims that have
not all been independently verified; they are not evidence that a feature exists in the repo.

## Locked vocabulary and corrections

- Charmville is the unified yard and Memoji Market inside PlankSpace.
- Pining is the action; Pine is the publish button. A Grain is a post; grain is the soft balance.
- `stalk` is the common face, replacing both the initial Grain-face name and Sheaf.
- Starter seven: Stalk, Splinter, Knock, Hum, Pith, Gleam, Knot.
- Stalk planting uses one seed and no grain on any already-open plot. Original six stay tilled.
- Harvest and compost each return exactly one seed. Harvest also produces faces; compost produces zero.
- One profile hosts many verified wallets. Each key belongs to at most one profile.
- Profile identity owns the yard; primary key authorizes the session. Provider account changes do not transfer it.
- OAuth may label a dock. Outbound runs through the owner's PlankCaster browser sessions.
- Build porch, satchel, and local pining first; X caster second; more docks next; public market later.
- No public GE in slice 1. OAuth is a badge; AppKit is a door; wallet links live in Postgres.
- Continuity merges prose/layout drafts only. Ledger writes require the live primary session online.
- Accept one stable intent_id once, burn exactly one stamp, retry the same id without another debit.
- Caster cookies, WalletConnect sessions, and OAuth refresh tokens never enter continuity sync.

## Visual corpus status

official-plank/ contains actual repository assets, not generated substitutes.
The populated Degen board, farming, zoning, city, and GE screenshots were visually supplied in chat.
Their original image files have not been copied into this pack. Do not claim these directories contain them.
Unicorn street, desk, early book, and bag are now included and annotated in
[unicorn-memoji/README.md](unicorn-memoji/README.md):
[01 street](unicorn-memoji/01-memoji-market-table.jpg),
[02 desk](unicorn-memoji/02-desktop-full.jpg),
[03 early book](unicorn-memoji/03-delphi-market-embed.jpg),
[04 bag](unicorn-memoji/04-github-screenshot.png).
Frame 03 is the source embed without the caption surrounding it in the user-supplied screenshot.
Ritual, Win98 chart, and uwublack.market references remain missing, as do live WoodAmp/xCaster captures.
Reference source clones exist next to this checkout in `../charmville-references/` (relative to its parent workspace).

Source pins: xCaster `eb53c18e8af3f71b6d8cfe4bd9693cc7c82c0215`;
Memoji Market `e4a2d1440c2a283cea6cedaa1147fca49d187502`.
Neither reference app has been run or fully audited yet. Do not copy their implementation wholesale.

## Delivery status

Created: source/art pack, consolidated game design, identity/caster protocol proposal, schema draft,
implementation and verification map, and explicit research gaps.
Not completed: exhaustive mandatory ingest, visual compositions, reference runtime captures,
application implementation, migration execution, live platform sending, release checks, deployment.
This status is intentionally explicit so a subsequent agent cannot mistake planning for delivered behavior.


## Isometric art correction ? 2026-09-07

The owner rejected the generated painted garden and wheat. Read [ISOMETRIC-ASSET-SPEC.md](ISOMETRIC-ASSET-SPEC.md) and open [the actual repository sprite study](isometric-reference/index.html). SimCity/RCT/FarmVille geometry and asset construction are the target. Wood/gold is window chrome; natural terrain stays green. These references supersede the generic painted-garden interpretation.


## Implemented source-based crop pipeline

Read [CHARMVILLE-ART-RESEARCH.md](CHARMVILLE-ART-RESEARCH.md) and the [pinned repository catalog](CHARMVILLE-SOURCE-CATALOG.json). The implementation branch now has original Blender crop models, three stages and eight animation frames per stage, licensed terrain, and a projected inline porch. This is implemented source-based artwork, not the rejected generated garden. Final visual approval and remaining game features are not implied.

## Dream-loop and playable progress

Read [CHARMVILLE-VISUAL-LOOP.md](CHARMVILLE-VISUAL-LOOP.md) for the pinned workflow, independent critique and remaining whole-vision work. The upstream README, skill and MIT license are preserved in dream-loop-source/. User art direction overrides its default photoreal target. [CHARMVILLE-PHASE-A.md](CHARMVILLE-PHASE-A.md) records actual implementation separately from specification. Draft implementation PR: https://github.com/YellowJacketTour/robinwood-plank/pull/378. Local playtest instructions are in scripts/charmville/README.md on that branch.
