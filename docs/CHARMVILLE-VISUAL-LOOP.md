# Charmville visual iteration record

## Authority and source

User-supplied SimCity, RollerCoaster Tycoon and FarmVille references govern the
isometric world. Official Plank art governs faces; Unicorn references govern the
satchel/desk/street composition, restyled in DESIGN.md wood/gold. The board remains
home: composer, porch, feed and persistent WoodAmp. No separate game application.

Workflow source: https://github.com/achimala/dream-loop at
`d113b78bd8143d6c4e2b46840c1a881139bcc084`, MIT. Local source is preserved in the
sibling `charmville-references/dream-loop` directory; the skill is installed in
the user's Codex skills directory. The source catalog retains prior game research.

Adaptation: supplied references replace the skill's generated photoreal concept.
Its screenshot review, independent critic, gated assessment and structural-rethink
rules apply. Generated imagery must not redefine the user's approved art direction.
Raw captures live in ignored `.dream-loop`; durable decisions are recorded here.

## Baseline review — 2026-09-07

Independent critic: 2.5/10, Tier 1 incomplete. This is a direction assessment,
not exact screenshot matching: no same-composition target was supplied.

1. Six soil footprints visually merge. Provide 8–12px lawn gaps at desktop scale.
2. Large Plank face floats beyond the terrain. Ground any replacement as a real
   sign; build a coherent entrance/boundary rather than decorating empty space.
3. Seedlings disappear and mature crops read as sparse sticks. Improve stage
   silhouettes, leaf clusters, grain-head density and restrained height variation.
4. Grass texture is too busy relative to crops. Unify texture frequency, lighting
   and asset scale; review the full board including satchel and WoodAmp.

## First corrective pass

Reduced soil width 170→144 and crop width 224→190, preserving projection and
ground anchors. Reduced picking outlines accordingly. Removed the floating face;
a modeled entrance/sign is still pending. Added owner-controlled tree placement
with accessible lawn cells and a revision-checked server save. These changes do
not constitute a final art pass or a passing critic verdict. Grass, crop modeling,
boundary/entrance and full-board composition remain open directives.

Validation: local PostgreSQL tests include scenery replay, stale-save rejection,
owner-only access, crop-footprint rejection and unchanged economy/crop state.
Browser verification saves a tree move and reloads before checking server state.
TypeScript passes; scoped lint has the two previously recorded Porch warnings.

## Whole-vision tracking

- Soil: session porch, six plots, Stalk seed-only, 1:1 seed return, Stalk 4h /
  Splinter 16h and 48h ripe windows implemented. Additional art and full acceptance
  remain. Scenery commits are implemented; cross-device layout drafts are not.
- Identity: many keys, authoritative Postgres links and primary-session role remain
  a later phase. AppKit is a door; OAuth is an identity badge.
- Pine intents: stable acceptance ID, one stamp burn, idempotent recovery remain
  a later phase. Never substitute generic third-party posting APIs.
- Caster: human-owned local partitions; foreign cookies and tokens never sync.
- Desk: overlapping windows and persistent WoodAmp; full composition review open.
- Street: no public book in slice 1. Later dense grain-quoted book, no DEX columns.
- Continuity: encrypted prose/media drafts, music restore and layout draft conflicts;
  never merge balances, harvests, stamp burns, wallet roles or caster secrets.

The seven faces remain Stalk, Splinter, Knock, Hum, Pith, Gleam and Knot.
Grain (post), grain (balance) and stalk (inventory ID) remain distinct.
Nothing in this workflow reduces that scope or marks those later phases complete.

Crop follow-up: Stalk now uses 11x11 stems (previously 8x8), larger modeled grain
heads, broader leaves, restrained height variation and stronger green/gold
material contrast. Editable .blend sources and all frames were rebuilt; this
still needs a new independent visual verdict.
