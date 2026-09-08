# Implementation map and audit status

Implementation is paused for pack review. Locked prerequisites: Stalk seed return 1:1, no public GE
in slice 1, OAuth is a badge, AppKit is a door, wallet links live in Postgres. Read
CONTINUITY-BOUNDARIES.md before implementing sync, auth, inventory, or caster transport.

## Actual attachment points

- Public route: app/(plankspace)/u/[handle]/page.tsx re-exports the integrated page.
- Real board: integrations/plankspace-app/app/u/[handle]/page.tsx renders custom modules and Feed.
- Board composer: Feed in integrations/plankspace-app/app/profile-extras.tsx. It currently takes no
  owner props. Pass stable viewed profile id/handle for porch reads; never infer yard ownership from
  whichever account the browser happens to expose. Preserve the distinction between viewed board
  and signed-in writer.
- Lumberyard composer: integrations/plankspace-app/app/home-feed.tsx. Share pine/draft logic with
  board composer rather than building two outboxes with diverging semantics.
- Root bridge: components/plankspace/NativePlankSpaceWalletBridge.tsx and lib/wallet-context.tsx.
- Session: integrated app/auth-client.ts and app/api/auth/{session,challenge,verify}.
- Existing schema: integrations/plankspace-app/db/schema.ts. Profile id is an integer; wallet is
  unique text today. Add references to profile ids instead of creating another account table.
- Existing API façades under app/api remain thin; game services can live in lib/charmville with
  shared schema access. Keep transactions server-only and pure geometry/yield calculations testable.
- WoodAmp provider remains mounted at root. Reuse window interaction patterns, not its audio element.
- Visibility-demand accepts a limited set of market contexts and known collection keys. Do not send
  invented glyph ids to that endpoint. Warm local art directly; only actual collection toys enqueue
  collection demand. Add any game source to the existing dedup/budget system explicitly.

## Ordered implementation

1. Finish mandatory source ingest and produce real board/porch/satchel compositions using official art.
2. Add backward-compatible profile wallet links and chain proofs; bootstrap existing primary ownership.
   Harden session verification before relying on it for new inventory mutations. Preserve old UI reads.
3. Add atomic starter claim, six occupied/tilled cells, seed and face inventory, receipts, plant/resolve,
   and capped tend services. Use row locks and idempotency; no client-trusted yields or ownership.
4. Add inline porch, expand/collapse, satchel, local stamp, and Pine vocabulary. First playable has no
   public book and no ritual. Preserve page-specific profile module order and music/video behavior.
5. Add draft persistence and encrypted device enrollment/sync from PINING-CONTINUITY.md. Test recovery
   before treating cross-device Saved as true. Shared login gates writes, not text composition.
6. Add signed pine acceptance and stamp debit, encrypted relay, device leases and honest status UI.
7. Build standalone PlankCaster desktop package with X partition and signed-intent verification.
   Separate local shell assets from foreign renderers. Test with local fixture sites before real X.
8. Add validated docks independently; do not implement server OAuth publishing as a fallback by default.
9. Add public market, sockets, advanced crops, civic expansion and governor after economic simulation.
10. Ritual and wrapper interfaces last. Contract deployment and real-value settlement are separate gates.

## Asset pipeline

Reuse official-plank/ for mascot reference. plank-head remains hero-only as a background under DESIGN.md;
new crop/shed art matches its ink family rather than placing a second hero background on the board.
Produce seven glyphs (small stamp and inventory sizes), seeds/packets, planted/sprout/ready/fallow states,
porch ground atlas, shed, pouch closed/open/peek states, and two-frame selected-toy idles.
Record source, prompt, reference hashes, license, dimensions, anchor, collision footprint, and scale.
Keep labels, numbers, clocks, window controls, and focus rings in accessible DOM, not baked into rasters.
Use alpha cutouts, a consistent low-isometric camera, nearest appropriate resampling per asset,
and tests at actual 390px and desktop display size. Reduced-motion asset fallback is required.

LPC may supply structural tile references only after license attribution/share-alike obligations are
recorded; no raw LPC final brand. Memoji Market is GPL-3.0 per brief: inspect license before any code
reuse; redraw UX patterns in project-native components rather than assuming source is unrestricted.
xCaster source is a reference, not an unreviewed dependency to embed.

Unicorn satchel/desktop/market-table captures are present in unicorn-memoji/, annotated as bag/desk/street.
Use frame 04 for the open inventory grid with SEND; keep public book and financial columns out of slice 1.
Missing captures: populated board original image, fresh Lumberyard, Woodstock, WoodAmp chip/window,
Unicorn chart/ritual/uwublack.market, 3–6 caster session/audio/queue states. Screenshot evidence must
record URL or local source, date, viewport, and what it proves. Never label a constructed mock as live UI.

## Focused correctness tests

Claim twice returns same budget; concurrent claims cannot mint twice. Harvest/compost race resolves once.
Ready and expiry boundaries use database time. Zero-grain Stalk replant works after either outcome.
Linked provider change during request cannot move ownership. Hidden keys do not leak in public reads.
Wrong profile/nonce/domain/chain/signature rejects; contract wallet proof checks the contract address.
Concurrent placement cannot overlap; width/height/rotation remain in lot bounds. Starter cells never charge tilling.
Self-stamp consumes face without Rings; distinct-giver caps span all linked wallets. Negative balances reject.
Same signed pine retried ten times burns once. Uncertain external submission never blindly retries.
Multiple destinations still cost one stamp per accepted intent_id. Offline plant/harvest/stamp cannot
be queued. Two-device planting on one plot rejects the conflicting request. Layout draft conflict
copies never merge live occupancy. Credential-bearing objects cannot enter the continuity serializer.
Postgres restart and Passenger restart preserve seed counts, drafts, and delivery receipts.

UI: 390/768/1280, connected/disconnected/session expired, empty bag, failed save, offline/caster offline,
keyboard placement, reduced motion, two devices editing, and WoodAmp continuing through every window.
Before shipping run repository lint, typecheck, npm test, build, migration and Postgres integration checks.
No test results are claimed for these drafts; no application changes have been made yet.

## Outstanding ingest — do not omit from handoff

Full app/API/migration neighbors; casino and economic-kernel docs; both hydration findings and art cache
implementation; complete Memoji WinXP/trading/send/chart/vox flow and runtime; xCaster full process/IPC
audit; FarmVille revival and referenced examples; Micropolis and GE matcher references; official wrapper
standards; source attribution for Degen's upstream work beyond the integrated commit author metadata.
The original manifest was partially truncated in tool output and must be reread fully before declaring
mandatory ingest complete. Source existence or a clone is not equivalent to reading/running the source.
