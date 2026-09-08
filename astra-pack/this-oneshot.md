ASTRA ONESHOT — PlankSpace Yard + Memoji Market
You are inventing and specifying a game that evolves existing PlankSpace on plank.love, not a greenfield crypto game and not a reskin of FarmVille. You will ingest the repos, docs, art, and lore listed here, then output design + architecture + asset plan that can be built inside YellowJacketTour/robinwood-plank without violating DESIGN.md, securities parking, or the economic constitution.
Do not implement Chia plots. Do not print $PLANK from play. Do not sell grain for dollars. Do not redeem memojis for dollars. Do not treat Reddit karma as a transferable token. Do not use abstract gold rectangles as the plank mascot.
0. Who this is for

Product: plank.love — RobinWood $PLANK + all-chains DeFi + PlankSpace social.
Creator line: Degen Waffle (@Degen_Waffle) co-created the Plank revolution; collection account @RobinWoodPlank; live site plank.love.
Operator stack: Next.js 16 / React 19 / Tailwind 4 / Postgres on InMotion Passenger. No Redis. Cloudflare is edge only.
Branches: work on dev, ship dev → master. master deploys InMotion.
Canonical app today also reachable at plank.tanggang.life until DNS cutover is finished.

You are the brain that receives game-design repos and art repos and invents the game. First deliverable is a complete design spec + schema + asset pipeline + first vertical slice map. Code second, and only against this repo’s conventions.

1. Mandatory ingest — this repo (read all of these, not a sample)
Home
https://github.com/YellowJacketTour/robinwood-plank
Work from dev + master. Live product: https://www.plank.love/
Law of the house (read before any UI or game surface)

DESIGN.md — tokens, type, plank-character rule, marketing vs app, data-market-shell
AGENTS.md — branch law, vault law, never show V1/V2/V3 to users
ARCHITECTURE.md
PRODUCT.md — PlankCrash is the stadium, not the farm. Rake buys and burns $PLANK. Do not siphon crash into memoji mint.
CONTRIBUTING.md, README.md, SECURITY.md, CLAUDE.md
.claude/skills/impeccable/SKILL.md + .claude/agents/impeccable-asset-producer.md
docs/design-md-tokens.md, docs/design-md-audit.md

PlankSpace (the thing you are evolving)

docs/PLANKSPACE_INTEGRATION_MANIFEST.md
docs/PLANKSPACE_X_SETUP.md
docs/PARKED-social-and-points-2026-08-19.md  ← Rings vs Sap; no published points→token conversion (securities, 2026-03-17)
app/(plankspace)/**
app/plankspace/**
components/plankspace/**
components/woodamp/** (WoodAmp — in-site radio; cousin of xCaster/Winamp)
app/api/posts, profiles, relations, profile-visits, widgets, widget-market, scores, plankspace-media, music/*, x/*, memes/*, tips, grain-policy page
Migrations deploy/inmotion/postgres/migrations/090_plankspace_native.sql through 099_unified_edge_ledger_and_demand.sql and neighbors 091–098
Pages already live in spirit: Lumberyard feed, boards /u/[handle], create-profile, browse, mood, board-mail, board-safety, woodstock, grain-policy, help, search, profile-editor

Performance plane (game may add demand; must not become a tick tax)

app/api/market/multichain/visibility-demand/route.ts
lib/art-cache.ts, lib/art-warm-global.ts
docs/marketplank/GROK-FINDINGS-viewport-predictive-hydration-2026-08-25.md
docs/marketplank/GROK-FINDINGS-unified-maximal-hydration-2026-08-26.mdPlay is an extra visibility demand source. If nobody plays, the site is unchanged.

Downtown already on chain (do not rebuild)

$PLANK ERC-20 0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc
RobinWood ERC-721 0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156
Chain ID 4663 Robinhood Chain
Seaport marketplace, Uniswap-routed trade, N-vault registry (lib/market/vault-registry.ts)
Names users see: Driftwood, WormWood, Premium Plank Liquidity — never V1/V2/V3
Do not migrate anyone to V2
drand randomness already used for vaults

Stadium (do not print memojis from this)

PlankCrash, Powerboard, Plank KOTH
docs/CASINO-ARCHITECTURE.md
docs/marketplank/DECISION-plank-economic-kernel-and-accounting-2026-08-27.md
docs/AUDIT-plankcrash-2026-09-02.md

Existing meme / score surfaces

app/memes, app/api/memes, app/api/scores, game_scores style tables

Live language already on the Lumberyard
Boards. Grain composer (“What’s on your grain?”). Knocks. Mood. “feeling board: holding down the lumberyard.” Connections tab. Wallet-signed posts. WoodAmp track titles like “WOODDAMP Too Sexy for My Plank.” Mascot plank in the left rail. This vernacular stays.

2. Official plank art (canonical — generate from these, not from generic wood)
In-repo / public:

public/plank-classic.jpeg
public/plank-robinwood.png
public/plank-social.jpg
public/images/plank-logo.webp
public/images/plank-head.webp
public/images/plank-legs.webp
Root stills real178.png, unrev.png
Arcade/playtest under public/arcade/**, public/playtest/**
docs/mockups/**
WoodAmp skins in components/woodamp/**

DESIGN.md hard rules
Palette only: gold-500 #E9B43F, gold-400 #EEC164, gold-300 #F8D98A, gold-600 #AF761D, on-gold #261105, wood-950 #1B120A … wood-600 #7A4D26, cream #FFF2CF, cream-muted #C9B58A, page-background #14100B, panel rgba woods, border-line gold-alpha.
Type: Uncial Antiqua display, Nunito Sans UI. Arcade HUD only inside arcade/playtest: DM Mono + Bungee.
A plank is the hand-drawn character: warm yellow wood, thick black ink outline. Never substitute flat rounded rectangles or gradient bars. Never use a random holder NFT as the mascot in chrome. NFT art ≠ mascot.
Marketing hero uses plank-head.webp only in Hero.tsx. App pages mount <AppBackdrop />. Dense shells use data-market-shell.
Impeccable asset producer (.claude/agents/impeccable-asset-producer.md) is the in-house art agent. New farm/memoji art must pass that bar and DESIGN.md, not Midjourney-generic.

3. Memoji Market lore + source (the place, not a ticker farm)
Client source (clone and run)
https://github.com/nocktoshi/memoji-market
GPL-3.0. Vite + React + Tailwind + CosmJS + Cosmos-Kit + Ag-Grid + Three.js + Webamp + react-draggable.
Read at least:

src/WinXP/** — the OS shell
src/components/Trading/index.jsx
src/components/SwapModal
src/components/SendModal (emoji picker)
src/components/WalletSelect
src/hooks/fetchChartData.js, balanceUtils.jsx
src/assets/emoji/**
src/assets/vox/** — upeach.vox, ufrog.vox, umog.vox, ucorn.vox, dozens more
Winamp skins unicorn.wsz, rock_unicorn.wsz
package.json for the exact stack

Also: uwublack.market (black-market fork for unlisted glyphs).
Lore (the feeling Astra must reproduce)
https://x.com/unicornandmemes/status/2023750301744878078
Longform: Windows 98/XP desktop, draggable satchel of emoji-only assets, Win98 charts, tribes on 🐸 🌽 🍑 🇺🇸, started with 7 memojis after epoch 2–3, 52k wallets, trading that was “worthless” and therefore honest, Purple Pill sacrifice to birth new memojis on a bonding curve (Unicorn’s Pump.fun joke), black market for 💎🪨🧻✂️ found on-chain before listing. $UWU was the diploma for playing, not the crop.
Delphi on the airdrop + emoji tickers:
https://x.com/Delphi_Digital/status/1823066833206825420
@unicornandmemes claim/clawback threads. Testnet top pair was 🌽🌽🌽.
What to steal: desktop-as-shell, satchel as a draggable bag, glyph-as-SKU, vox toy per face, Winamp-as-radio (you already have WoodAmp), ritual birth of new faces.
What not to steal: faucet epochs as the only supply; every harvest on a live curve; a second governance token paid for clicks.

4. FarmVille — goal and guts
Goal of the game (not the feature list)
A yard that is yours. Coming back feels like care. Friends are useful without being raid bosses. The yard gets prettier. The yard emits goods. There is no final boss. Harvest is the excuse; the farmhouse is the product.
Mechanics to keep
Appointment crops (real hours, not ticks). Dual currency: soft coins vs hard cash. Neighbor visit + fertilize, capped. Gifts cost. Ribbons/moods. Expansion price scales. Decor raises feeling, not raw output. Wither as weather (compost, zero glyphs), never a ransom popup. Write-heavy spatial document (objects cannot overlap).
Do not keep
Pay-to-win print. Uncapped neighbor vacuum. Coins redeemable for dollars.
Repos / papers

https://github.com/FV-Replowed/fv-replowed — FarmVille 1 revival; AMF; fat user farm document
https://highscalability.com/how-farmville-scales-to-harvest-75-million-players-a-month/ — write-heavy 3:1, degradable services
Adobe/Concrete Interactive FarmVille vector-vs-raster case (deer/sheep) — rasterize animated critters
https://github.com/fariazz/html5-farming-demo — uses Daneeklu LPC tiles
https://github.com/DevStudio-AI/GreenValley_ — JS farm + breeding, no engine
https://github.com/AliHaine/GameFarmerJS
https://github.com/kmasaryk/FarmSim
Hungarian FarmVille wiki loop times (2h–4d crops) if manuals are thin

Legal art corpus (farm tiles, not Zynga IP)

https://opengameart.org/content/lpc-farming-tilesets-magic-animations-and-ui-elements — Daniel Eddeland / daneeklu, CC-BY-SA 3.0 / GPL-3.0
https://opengameart.org/content/lpc-style-farm-animals — daneeklu
https://opengameart.org/content/lpc-farm — bluecarrot16
LPC style guide: http://lpc.opengameart.org/static/lpc-style-guide/assets.html

Restyle every borrowed tile into plank ink-and-gold. Do not ship raw LPC as the brand.

5. SimCity — the multiplayer container
Law
RCI must need each other. Parks raise land value. Overbuilt industry without commercial + residential is pollution and abandonment. Budget is a sink. Neighbor deals / freight export is how a city touches the outside. Sustainability is the win, not evacuation.
Repos

https://github.com/graememcc/micropolisJS
https://github.com/SimHacker/micropolis
https://github.com/SimHacker/MicropolisCore — C++ engine, WASM lineage
https://github.com/SimHacker/moollm/blob/main/skills/micropolis/SKILL.md — Soul City notes
https://github.com/lincity-ng/lincity-ng
https://github.com/OpenCity2k/OpenCity2k + https://github.com/dfloer/SC2k-docs
https://github.com/GodotGarden/city-builder-games — index

Steal arrays: map, powerMap, landValueMem, ptlScan. In PlankSpace those arrays are boards, not grass. Do not port the C++ engine unless a sandbox needs it. Steal the separation: sim state vs paint.
Manual ideas to encode: RCI demand cap, land value from civic adjacency, export deals, no infinite money.

6. RuneScape Grand Exchange — the street
Law
Player prices. Escrow. Partial fills. Guide price. Limits. Items that still do something when taken home. A quiet floor so 3am harvest is not void. Fills move items; they do not mint.
Repos

https://github.com/openrs2/openrs2
https://2009scape.org/ and mirrors (2009scape org, JesseGuerrero/2009Scape)
2009scape GrandExchange.kt pattern: worker thread, pendingOffers, player_offers, bot_offers, shop recirculation into the book
https://github.com/MidTermDev/chainscape — GP backed by a token; inverse of us ($PLANK already exists; glyphs wrap later)

Do not clone Gielinor. Clone the matcher.

7. xCaster and outbound social (docks, not faucets)
Reference implementation of bespoke client control
https://github.com/awizardxch/xCaster
Electron + bundled Chromium. User owns the session. Isolated audio. Spaces + music. This is the pattern for PlankCaster: a local first-party shell the human signs into, PlankSpace sends an intent, the caster posts with their credentials.
Related: https://github.com/BankkRoll/Twitter-spaces-music (legacy emulator recipe — do not copy; xCaster replaced it).
Already in-repo
app/api/x/*, migration 097_plankspace_x_integration.sql, 098_plankspace_x_action_limits.sql, docs/PLANKSPACE_X_SETUP.md.
Economic law for brands
X, Instagram, Facebook, Snapchat, TikTok, etc. are docks. Opening a dock is the user’s caster. Outward post consumes a memoji stamp (sink). Failed send still burns the stamp. Inbound that becomes a real knock/visit raises land value. Posting does not mint grain, Rings, $PLANK, or peaches.
Do not design a server that stores foreign passwords. Do not promise official API firehoses as the forever-free path. Forever-free = user-owned session on their machine.
WoodAmp is the in-page Winamp. xCaster is the out-of-page X surface. They should feel like family.

8. DeFi wrappers (later door, sockets now)
Read enough to specify, not to deploy on day one:

ERC-6909 game items (OpenZeppelin) — one contract, many glyph ids
ERC-1155 as fallback
Seaport already in-repo for listings
EIP-2981 royalties already in brand
Gods Unchained / Immutable Passport: play + inventory first, withdraw when leaving
Pump.fun: curve is a birth canal, then graduation to AMM — use only for new glyph ritual, never for daily harvest
Bonding curve ≠ AMM ≠ order book. All three exist. Different jobs.

Wrap interface to reserve:
textCopyCopiedwrap(glyph, amount, merkleProof)   // lock interior, mint 6909
unwrap(glyph, amount)              // burn 6909, unlock interior
Admin cannot mint 6909 except through wrap. Merkle roots of (owner, glyph, qty) publish on Robinhood Chain before wrap goes live.

9. What not to copy (failed utopias)

Axie SLP / STEPN GST: uncapped play token listed next to a treasury token. Harvest became a job. Economy died when new blood slowed.
Official “redeem 🍑 for $X.” That is an IOU.
Official “buy grain for $X.” That publishes FX on the wage.
Points → token window (already parked in PARKED-social-and-points-2026-08-19.md).
Crash rake → memoji mint.
A Uniswap pool per baby glyph on week one.


10. Economic constitution (implement this, do not reinvent)
Three goods






























GoodRoleLeaves city?GrainSoft wage. Seeds, listing dust. Printed by play.Never$PLANKDowntown gold. Already a token.AlreadyMemojisFaces. Grown, traded, burned as jobs.Only later wrap, same idRingsStanding. Reddit karma analogue.Never. Not sold. Not bought.
Sap stays decaying activity if it exists; do not promote it to money.
Three zones on existing surfaces

Residential = boards, knocks, mood, music, people
Industrial = plots on a board (the yard)
Commercial = Memoji Market + Marketplank
Civic = Woodstock, widgets, hero art, parks — raise land value, do not print

Land value governor
Each board has $V \in [0,1]$.
$$V = \mathrm{clamp}(\alpha\,\text{care} + \beta\,\text{visits} + \gamma\,\text{civic} + \delta\,\text{faces used} - \varepsilon\,\text{glut} - \zeta\,\text{empty street})$$
Harvest:
$$H = H_0 \cdot V \cdot \frac{1}{1 + \kappa S_g / D_g}$$
$S_g$ circulating supply of that glyph. $D_g$ glyphs of that id consumed last season (socket, stamp, sunk gift, wrap). Wash trades and self-reactions do not count in $D_g$ or Rings.
If industry outruns use, soil gets stingy for everyone. That is the inflation brake.
Issuance

Plot = appointment. Plant costs grain + seed. Real time. Ready window. Miss → compost, zero glyphs.
Harvest = wallet signature of the board owner.
Neighbor tend cap $N$/day. Helper cannot harvest. Helper gets grain crumb only.
New glyph species = ritual birth (Purple Pill analogue + short curve + board stake). Rare.
Daily 🍑 of an existing species = recipe, not a buy-up-the-curve.

Memoji jobs (sinks)
Socket (widget/board skin), stamp (outward post), gift (cannot instant-relist), craft (burn mix → seed/decor/pill), listing dust, stale-order decay, compost, later wrap fee.
Street
Default book in grain and optionally $PLANK. Escrow. Partial fills. Season buy caps. Guide EMA. Lists far from band pay extra dust. Tiny published shopkeeper bid at a bad price so night harvest is not void.
Curve = birth only. AMM = after wrap + explicit graduation.
Reactions ≠ karma
Reddit awards, not Reddit karma.

Spend or grow-and-give a 🍑 onto a grain. 🍑 leaves the satchel.
Author gets Rings scaled by distinct spenders, not stack size.
You cannot buy Rings. You cannot sell Rings. You cannot cash Rings.
Buying 🍑 with grain is allowed (demand). Trading 🍑 is allowed (street). Growing 🍑 is allowed (industry).
Author is not paid grain/$PLANK/$ for being reacted.

Dollars

Do not sell grain for $.
Do not redeem memojis for $.
If a dollar door is required, sell tools and cosmetics (seeds, decor, ritual pills, plot licenses, caster skins) in $PLANK first.
Secondary dollar price of wrapped 🍑, if any, is the open market’s problem after wrap. Plank Love does not run a cashier.

Identity + provenance
One glyph_id. One owner wallet. One history. venue = interior | wrapped. Satchel is a view. Every harvest/fill is a signed receipt. Periodic merkle root on chain. Wrap is a venue change, not a migration airdrop.
Performance
Gameplay enqueues the same visibility-demand / art-warm jobs the market already uses. No heartbeat that taxes idle hosts. Shared hosting, no Redis.
Anti-exploit
One living board per wallet (extra boards scale in cost). Appointment harvest. Visit caps. GE dust + stale decay. Same-wallet fills ignored for demand. Stamp burns on intent. Ritual cooldown on new tickers. No admin mint except wrap-from-proof.

11. What to build (evolution of Degen Waffle’s PlankSpace)
Vertical slice, in order:

Yard on the existing board — a grid widget that is a spatial document (collision, plant, ready-at, compost). Lives on /u/[handle]. Looks like plank wood, not Phaser stock tiles.
Satchel — draggable window (Unicorn), lists glyph stacks, works on Lumberyard and board.
Reactions — spend glyph on a grain; Rings tick; 🍑 gone.
Memoji Market window — GE book, Win98/XP-in-wood chrome, chart from fetchChartData spirit, not from a 2026 DEX template. WoodAmp can play while it is open.
Stamp → caster intent — composing outward from PlankSpace attaches a stamp and an IPC-style intent. Caster is specified, not necessarily shipped in slice 1.
Receipts + merkle schema — even if the on-chain publisher is later.
Ritual birth — last among slice-1 features. Seven starter faces, plank-native, not a Pepe rip-off unless the community grows that face themselves.

Stadium (Crash/KOTH) stays a spectator sport. Downtown (Marketplank/Trade/Mint) stays $PLANK and NFTs. Farm does not replace them.
Starter seven faces should be invented in plank vernacular (wood, grain, gold, the official three plank faces as optional toys), not copied from Unicorn’s exact roster. The system is copied; the faces are ours.

12. Output Astra must produce

Game design document in this repo’s voice (wood/gold, not arcade HUD except playtest).
Schema migrations draft (plots, satchel_balances, ge_offers, receipts, land_value snapshots, glyph registry, ritual table) that extend 090+ plankspace tables rather than forking a new app.
Land-value and harvest formulas with worked numbers.
Asset list: which official plank files to reuse, which LPC tiles to restyle, which Unicorn UX patterns to redraw in Uncial/wood, which screenshots are still missing.
Satchel + Market + Yard wireframes described against live Lumberyard IA.
Wrap adapter spec (interface only).
What Crash/KOTH/Seaport must never do.
A first playable loop that a single board can run on shared hosting.

Do not open a new Next app. Do not introduce Redis. Do not add a points-to-token page.