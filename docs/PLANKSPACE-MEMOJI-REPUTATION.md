# Memoji reputation and discovery — owner refinement

Status: accepted product requirements and proposed integration contract, not a
claim that site-wide search or reputation projections are implemented.

## Product direction

Charmville's assets must follow the cutest neo-chibi source aesthetics. Use the
source corpus and the visual refinement loop to judge the actual composed board.
Reaction feedback should be expressive and immediate after server acceptance:
face animation, readable count changes and contextual celebration. Feedback must
remain readable on touch devices and respect reduced motion. WoodAmp remains live.

Pine memojis serve as the platform's Reddit-like reputation and reaction system,
with richer per-face discovery. This applies across site content, not only farms
or a profile's feed. A reaction count is distinct from inventory, seeds and grain;
spending a face is not the same object as the reputation it produces.

The owner explicitly chose BOTH current and lifetime counts as visible filters.
The owner also chose BOTH face totals and unique supporters. These are separate
metrics, never aliases for one another. Every predicate and sort key therefore
selects a face, a current/lifetime basis, and a totals/supporters metric.

Face totals sum accepted quantities. Unique supporters count distinct stable
PlankSpace profile identities, not wallets or devices. Repeated stamps from one
profile increase totals but count as one supporter for that face and content.
Current supporters require at least one currently attached accepted reaction;
lifetime supporters include anyone with an accepted reaction in its history.
Identity merge and moderation policy still require explicit handling.

## Count and query contract

- Current: accepted reactions currently attached to eligible content.
- Lifetime: accepted reactions over the content's history, including subsequently
  removed reactions. Content visibility/access control still governs discovery.
- Keep a separate integer count per face and basis. Never silently substitute one
  basis for another or show a combined inventory/reputation balance.
- Each predicate selects face, basis, metric, comparator and integer threshold(s).
  Support at least, at most, exactly and inclusive between, including zero.
- Combine predicates with nested ALL / ANY / NOT groups. Preserve these groups
  in shareable URLs and saved searches; don't flatten OR into AND accidentally.
- Sorting supports explicit per-face/current-or-lifetime keys, ascending or
  descending, then stable content ID tie-breaking. Weighted aggregate rankings
  require visible weights; do not silently assign face rarity as voting power.
- Text, content type, creator, time range and memoji predicates compose together.

Example: ALL(current Stalk >= 10, lifetime Gleam >= 3,
ANY(current Hum >= 2, current Knot = 0)), ordered by current Gleam descending,
then lifetime Stalk descending, then stable ID.

## Integration shape

One stable content reference joins the searchable content registry to accepted
reaction events. Adapters cover boards, pines, comments and media, and later
Woodstock/market content as those surfaces are implemented. Explicitly record
coverage so unsupported content isn't presented as searched.

Acceptance retains the stable intent/receipt identity. One accepted intent burns
once and creates one reaction event. Retries neither burn again nor inflate
current/lifetime counts. Revocation/removal changes current counts once; it does
not create a fresh acceptance. Server projections serialize these changes.

Current slice-1 local stamp receipts are the integration starting point; the
existing profile-only client search is not the completed discovery system.
Do not publish identical current/lifetime controls backed by placeholder values.
Reaction history and counter projections belong in Postgres, never draft sync.

Visibility, blocked-content and moderation rules must apply before results and
count disclosures. Paginated searches need a declared snapshot/watermark strategy
so concurrent reactions don't silently duplicate or skip results.

## Remaining decisions and acceptance evidence

Reddit-like behavior does not yet define negative-face semantics, one-person vote
limits, reaction replacement/refunds, aggregate profile karma or moderation's
effect on lifetime reputation. Resolve those explicitly before those mutations.
Do not invent a face burn/refund policy under the label of a visual improvement.

Required evidence: truth-table tests for boolean combinations and thresholds,
current/lifetime divergence after removal, acceptance retry/concurrency tests,
content adapter coverage, permission-safe results, stable paging under concurrent
reactions, accessible mobile filter editing, and a populated-board/desk review.
