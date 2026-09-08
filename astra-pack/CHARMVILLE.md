# Charmville

## Home is the game

Charmville lives on `/u/[handle]`. The profile keeps its hero, personal CSS, videos, friends,
knocks, widgets, feed, and WoodAmp. A wood/gold isometric porch sits after the composer and
before the feed. Degen's purple/cyan profile remains purple/cyan around that porch.
The porch's own legibility and official ink-outlined art remain stable under profile CSS.
Use a scoped component boundary; do not repaint the user's whole page to obtain isolation.

Default porch: six tilled plots, four empty, one ready Stalk and one ready Splinter, a small
Plank-family shed, and an eaves control labeled Open the lot. It occupies roughly the upper
third of the main board column, sized to the actual column rather than the viewport.

First visit as owner: harvest two ripe plots; the face rises briefly and enters the pouch.
Open the pouch, optionally stamp a Stalk onto a Grain, then plant four-hour Stalk and sixteen-hour
Splinter. No market lesson, no new route, no autoplay music, no wallet prompt if the session is active.
A disconnected visitor sees the lived-in lot; Connect to claim your lot is an explicit owner entry.
Existing playback continues. A cold browser visit respects WoodAmp's no-autoplay rule.

Expanded lot stays in the same app/page and preserves playback and feed position. It exposes
placement, rotation where asset silhouettes support it, and a clear Done control. Collapse
returns focus to Open the lot. The default camera is fixed low isometric; no camera simulator.
Objects occupy integer ground cells; visuals can overlap in projection but footprints cannot.

Desktop: porch, satchel, later market, and WoodAmp can coexist. Floating windows have clamp-to-viewport
positions, keyboard movement/reset, explicit close controls, predictable focus order, and no focus traps
unless modal. Phone: inline porch, full-screen expanded lot, one foreground satchel/market surface.
Touch controls are at least 44px. Reduced motion keeps state changes and removes flight/blink motion.

## Seven starter faces

| ID | Name | Symbol reference | Art and role | Availability |
|---|---|---|---|---|
| stalk | Stalk | 🌾 | Friendly cereal stalk with official-family eyes; handshake and everyday stamp | First playable, 4h |
| splinter | Splinter | 🪵 | Rough little woodchip with stubborn expression | First playable, 16h |
| knock | Knock | 🔨 | Small wooden knocking mallet, porch visitor identity | Registry first, growth later |
| hum | Hum | 📻 | Tiny radio crop, two-frame pulse while actual playback is on | Registry first, growth later |
| pith | Pith | 🍊 | Warm heartwood/orange cross-section; house-color face | Later |
| gleam | Gleam | ✨ | Ink-outlined gold shaving; decoration/socket affinity | Later |
| knot | Knot | 🔘 | Knothole with eyes, official mascot's cousin | Later |

Unicode symbols describe silhouette, not final shipping artwork. Goods first, no quest-giving NPCs.
An inventory selection can wake a small toy in a side well. Reproduce toy presence using compact
raster frames initially; a Three.js dependency is not required to achieve it.

## Satchel and pining

Closed satchel: worn pouch pinned to board chrome or Lumberyard header, drawstring, one peeking
unread face. Opening is intentional; first harvest can briefly reveal the acquired stacks without
maximizing a window. Wood click and drawstring effects respect the user's sound setting.

Open satchel: wood/gold XP-like frame, cream grid, Uncial title, Nunito labels. Face and seed stacks
are visibly different items. Counts belong to stacks. grain balance is a bottom strip, not an item.
Rings belong to the person in the board header. No price chart or portfolio value in the bag.
Later market is a separate window with its own charts, offer slots, and collection action.

Composer: What's on your grain? Button: Pine. Pining locally is free. Add a Stalk stamp is optional.
The face is consumed atomically with the accepted local post/stamp action. A self-stamp earns no Rings.
Spending on another person's Grain can create distinct-giver standing; stack size cannot buy standing.
No grain, money, or PLANK payout to the author. Local pining is not blocked by an unavailable caster.

Outbound destinations are explicit chips, off by default per pine. Accepting one immutable intent_id
burns exactly one stamp, regardless of destination count. Review shows this cost before signing.
Local decorative stamping is a separate optional action; never charge it implicitly when pining out.
Cancel before accepted intent costs nothing. Failed delivery retains the accepted burn. Retries use
the same intent_id, no second debit, and never resend a destination already confirmed as published.
Economy writes require an online live primary session; offline continuity saves drafts only.

## Seed and time constitution

Plant Stalk: consume one stalk_seed, zero grain. Harvest: return one stalk_seed and H stalk faces.
Compost: return one stalk_seed, zero faces. Never a plow fee on the original six cells.
Advanced planting consumes its seed plus grain; return its own seed at resolution, one-for-one.
No chance of losing the guaranteed returned seed. Optional bonus seeds are separate future awards, disabled initially.

Server timestamps are authoritative. ready_at = planted_at + grow time; expires_at = ready_at + 48h.
Harvest accepted at ready_at <= server_now < expires_at. At/after expiry, resolve as compost.
No client clock, animation, or page refresh grants output. Missed plots look fallow, not shamefully ruined.
Expiry is derived on read; resolving a plot is a transaction, not a continuous server tick.

Proposed auditable starter budget (not an existing production value):

- One claim per profile, never per wallet/provider link.
- Inventory grant: 2 Stalk seeds, 1 Splinter seed, and 2 grain.
- Two pre-ripe crops additionally hold one seed each. Claim receipt records those two planted seeds.
- Starter ready windows begin at claim time; they are not dated days before the user arrived.
- Splinter costs 2 grain per planting, so the inventory grant buys one overnight planting.
- Total initial seed supply is three Stalk and two Splinter across inventory plus planted stock.
- Porch tin holds at most two Stalk seeds as a view/location inside seed inventory, not another mint.
- Successful harvest returns seeds to inventory; a tin transfer changes location only.

Proposed first-slice grain faucet: 1 grain per successful crop resolution; at most 1 grain per valid
neighbor tend with five total rewarded tends/day and one helper/target/day. These are simulation defaults,
not promised token conversion rates. No reward for login, music autoplay, failed harvest, or self-tend.
Tending changes appearance in slice 1, never readiness or output; helper cannot harvest.
Primary changes and linked wallets share the same profile caps.

## Land value and output

First playable: V fixed at 0.85 and no social/glut adjustment. To keep initial output legible,
proposed H0 = 4 faces per crop, with integer output floor(H0 * V) = 3. Both ripe starters use this rule.
This is a tuning proposal; it does not imply advanced species all keep the same H0 at release.

Later: V = 0.85 + 0.15 * clamp(care + visits + civic + use - glut, 0, 1).
All terms are normalized bounded measurements, computed from capped distinct profile events.
Hraw = H0 * V / (1 + kappa * Sg / max(Dg, Dboot)).
Use kappa = 0.1 and Dboot = 100 only as simulation defaults. Dboot prevents division by zero;
it is a denominator floor, not fabricated demand. Publish actual consumption separately.
Avoid applying an identical supply penalty twice through both V and the harvest denominator.
At S=100, D=100, V=.85, H0=4: Hraw=3.09. At V=1: 3.64; solo is 85% of loved-board output.
At S=1000, D=100 and V=.85: Hraw=1.70. At zero demand, Dboot keeps the formula defined.

Integer rounding can erase small social bonuses or create zero-output harvests. Before enabling the
governor, simulate deterministic per-profile/glyph fractional carry and define a visible zero-output
state. Carry is nontransferable accounting precision, not spendable currency. Do not silently clamp
every harvest to one face, which defeats the high-glut brake. Seeds still return at zero face output.

Global supply includes freely held and escrowed faces; moving to an offer does not reduce supply.
Only irreversible face uses count as consumption. Trades, self-reactions, moves between linked wallets,
refundable gifts, socket removal, and interior-to-wrap transfer do not manufacture demand.
Wrap is a venue change, not a sink; only its genuinely burned fee counts. This resolves the original
brief's inclusion of wrap in D against its one-id/one-supply conservation requirement.

## The street, civic growth, and later doors

Market: grain book first, escrow, price-time priority, partial fills, explicit cancel and collect-to-satchel.
Offers finish while the owner is away. Trade creates no items; collect claims already credited escrow once.
Guide EMA reflects completed non-self fills; show sample count and stale time. No invented chart history.
Listing dust, price-band surcharge, caps, and stale decay are disclosed before listing. Returning unsold
escrow is not minting. A shopkeeper needs a bounded funded grain reserve and disclosed bad bid; no infinite bid.
PLANK pairs require a separately specified settlement adapter; do not invent server-held user funds.

Decor and civic adjacency make a board prettier and affect later bounded land value. Expansion costs grain
and minimum land value; existing cells never become rented land. Neighbor gifts are bounded transfers;
reaction/sunk gifts burn faces, while care packages containing seeds remain inventory transfers.

Ritual birth is rare, last: burn specified inputs, board stake, cooldown, short birth curve. No daily harvest
on curves. Reject duplicate ids and disclose finite parameters. AMM graduation is later, explicit, after wrap.

Wrap reserves one glyph id and a monotonic custody history: lock interior, prove reserved quantity,
mint exterior; unwrap burns exterior and releases locked interior once. A Merkle balance snapshot alone
is insufficient to prevent repeated wraps or concurrent interior spending. Add reservation nullifiers,
snapshot epoch, chain/contract domain, finality, and replay protection. No deployed contract in slice 1.

Crash/KOTH do not issue Charmville goods, route rake to rituals, or grant harvest advantage.
Seaport remains existing NFT infrastructure; no migration into WormWood, no vault version labels.
grain and Rings never convert to money/tokens; no memoji cashier, no Chia plots, no new Next app, no Redis.
