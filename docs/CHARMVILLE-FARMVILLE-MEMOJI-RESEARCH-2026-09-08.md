# Charmville: FarmVille, Memoji and the next art direction

Research date: 2026-09-08. This extends the source catalog and design pack; it does
not supersede the seed, ledger, identity, caster or continuity rules.

## Decisions from this interview

- Each crop yields a distinct expressive charm. Plank is the platform mascot,
  not the identical icon for every item. Ingredient crafting is an interesting
  later expansion, not a replacement for the everyday seed-to-charm loop.
- Research scope includes social/browser/mobile games AND discovery/search/SEO.
- Both face totals and unique supporters are required, each with current and
  lifetime counts. A stable profile identity is a supporter; extra wallets and
  devices do not become extra supporters.

## What was actually examined

Web searches covered FarmVille revivals, independent farming games, city/room
builders, open art libraries, author portfolios, GDC talks, mobile game design,
Unicorn's historical market and community writing, emoji libraries and discovery
documentation. GitHub search results are saved alongside a pinned twelve-repo
tree census in [the evidence directory](charmville-research-2026-09-08/).
The two saved search batches contain 100 FarmVille matches and 60 farming-game
matches, or 159 unique repositories; these batches are capped, not exhaustive.
Selected implementation files were read: Farmville item decoding, Replowed quest
parsing, game manifests, Memoji registry and market filters. The 77 Memoji source
images were inspected together as a contact sheet.

This is a broad, reproducible census, not proof that every repository, private
Discord discussion, deleted tweet or asset on the internet has been examined.
Search matches include bots, homework and unrelated agriculture software. They
are discovery leads, not recommended games. No downloaded upstream code was run.
File counts measure filenames, not finished content quality or unique assets.

## FarmVille's useful implementation lessons

The original FarmVille team described a Flash client, PHP server, designer-editable
data and server validation of client actions. Its GDC talk is the strongest
historical stack source here. Do not infer that a modern revival's Laravel version
was the original stack. [Amitt Mahajan's GDC presentation](https://www.slideshare.net/slideshow/rapidly-building-farmville-how-we-built-and-scaled-a-1-facebook-game-in-5-weeks/7405653),
[GDC session](https://www.gdcvault.com/play/1012277/Rapidly-Developing-FARMVILLE-How-We).

The lesson for Charmville is a content production system: authored crop definitions,
growth silhouettes, animation metadata, anchors and interaction beats, all reviewed
in the real board. A new framework alone cannot fix sparse composition.

An engineer hired to optimize FarmVille reports finding important problems in the
handoff between art/design and engineering, after modest code-level gains. That is
directly relevant to assessing assets at actual phone size instead of only judging
full-resolution source renders. [Justin Church's account](https://jcc.me/zynga.html).

Zynga technical artist Bret Hobbs documents a Photoshop-layer, atlas, Maya/Python,
FBX and Unity pipeline for CastleVille Legends, plus earlier Flash work. This is
verified adjacent-game evidence, not evidence all FarmVille versions used that
pipeline. [Artist's portfolio](https://brethobbs.com/).

## Repository findings

| Source | Verified substance | Application to Charmville |
|---|---|---|
| [FV Replowed](https://github.com/FV-Replowed/fv-replowed) | Laravel 12 manifest; README asks for PHP 8.3+, MySQL and separate game assets. Quest parser reads compressed XML into prerequisites, children, tasks and rewards. | Study authored progression and asset lookup. It is a revival, not a self-contained modern sprite library. |
| [Farmvillage](https://github.com/AcidCaos/farmvillage) | Python/Flask/Py3AMF; item reader decompresses AMF and caches structured JSON; preservation files and WARC extraction. | Recover historical growth/item structure. Its README describes a roughly 17GB asset/WARC download, separate from the minimal bundle. |
| [BlazorVille](https://github.com/Kristianfriis/FarmVille) | C#/Blazor WASM, localStorage saves, CSS grid, tool modes; credits Kathy Chow's Tiny Garden. | Clear appointment and tool loop; top-down art, not an isometric visual replacement. Its plow fee and local ledger are wrong for Charmville. |
| [World of Farmcraft](https://github.com/joeyinbox/world-of-farmcraft) | Node, old Socket.IO/MySQL, four camera directions, character movement and neighbor interaction. | Useful shared-world and action staging study; old dependencies and its art direction are not a finished cute mobile baseline. |
| [feiok](https://github.com/dacousb/feiok) | Small Go/Ebiten isometric farming source already in the corpus. | Explicit crop stages and placement; limited breadth, not a full FarmVille substitute. |
| [Isometric Farm Demo](https://github.com/Saccharine-Coal/Isometric-Farm-Demo) | Python/Pygame, 128x64 art, planting, camera movement, saving and a small economy. | Small understandable spatial loop, not a production social backend. |
| [CodingQuests](https://github.com/CodingQuests/FarmVille-Game), [gadget-hq](https://github.com/gadget-hq/2d-farming-game) | Godot tutorial projects; the latter explicitly links Sprout Lands. | Study gathering, tools and growth. A project's code license does not describe every bundled artist's files. |
| [HTML5 farming demo](https://github.com/fariazz/html5-farming-demo) | Small public browser demo; census finds only 17 files. | Teaching reference, not evidence of extensive finished content. |
| [Flowerpot](https://github.com/AmbientRun/flowerpot) | Cooperative farming/survival project on Ambient; substantial art file tree. | Multiplayer systems lead. Visual and asset provenance review still required before selection. |
| [IsoCity](https://github.com/amilich/isometric-city) | Current manifest uses Next 16, React 19, image compression and web tooling. | Close stack relative; study renderer/editor boundaries and atlas delivery, while retaining our existing board. |
| [Iso Middle Earth](https://github.com/hasanharman/isomiddleearth) | Next/React builder with grouped assets, undo, JSON/PNG export and collections. | Good composition/editor interaction reference; not automatic approval of every themed image. |
| [OpenGraphics](https://github.com/OpenRCT2/OpenGraphics), [OpenGFX2](https://github.com/OpenTTD/OpenGFX2) | Separate replacement-graphics projects. Census finds 41 and 1,283 art candidate files respectively. | Anchors, scales, coherent libraries and mature simulation production. Their visual density is more useful than mixing their pixels directly into this garden. |

Existing Micropolis, LinCity-NG, Unknown Horizons, FreeRCT, Simutrans, BAT4Blender
and other pinned research remains in CHARMVILLE-ART-RESEARCH.md and the catalog.
The examined free projects do not establish a single ready-made, fully polished
FarmVille replacement we can transplant into PlankSpace.

Direct visual inspection of the published IsoCity and Iso Middle Earth preview
PNGs adds an important distinction: IsoCity is the stronger dense-city reference;
Iso Middle Earth's small planted scene is much closer to the desired cozy garden
composition. Its crops, carts, building, fruit trees and path form a readable
little place. Borrow that composition discipline while creating our own identity.
Neither preview is a measured live performance test.

## Art sources worth using as a coordinated production library

Public availability and author's stated terms are recorded as provenance. The
owner's stated creator partnerships remain part of project context; this report
does not relabel published licenses or treat missing files as already supplied.

| Source | Actual content | Selection judgment |
|---|---|---|
| [Quaternius Ultimate Crops](https://quaternius.com/packs/ultimatecrops.html) | 102 models, five growth stages, FBX/OBJ/Blend, CC0. | Strongest next source for a broad editable crop family. Inspect geometry, then use one Charmville camera/material rig. Five growth stages do not by themselves prove wind animation. |
| [Quaternius Farm Buildings](https://quaternius.com/packs/farmbuildings.html) | 13 models, CC0, editable formats. | Build one recognizable garden entrance/shed composition; avoid adding buildings merely to fill space. |
| [Quaternius Farm Animals](https://quaternius.com/packs/farmanimal.html) | Seven animated animals, CC0. | Useful future ambient character motion; not required to turn the porch into livestock management. |
| [Quaternius Cute Monsters](https://quaternius.com/packs/cutemonsters.html) | 21 animated textured creatures, CC0. | Chibi proportions, eyes and idle behavior reference for original charms; not a replacement mascot collection. |
| [Kenney Miniature Farm](https://opengameart.org/content/isometric-miniature-farm) | 60 tiles/objects, isometric and top-down, 30°/45° view, alpha PNG and Unity/Tiled examples. | Useful consistent spatial kit already available locally. Its current thin boardwalk rendering needs art direction. |
| [LPC Crops](https://opengameart.org/content/lpc-crops) | 50 fruit/vegetable crops with five-frame growth sequences; detailed per-source credits. | Excellent growth vocabulary. Top-down pixels remain reference, not final isometric sprites. |
| [IsometricRobot wheat](https://opengameart.org/content/isometric-gardening-tiles-dirt-wheat) | Seven wheat cells, separate dirt; CC BY 3.0, old source needs alpha handling. | Study stage recognition and day shading; not a complete high-resolution farm library. |
| [pixel32 farm/shack](https://opengameart.org/content/pixel-farm-and-shack) | Compact CC0 isometric crop and building sheet. | Strong footprint and silhouette study. |
| [Varkalandar crops](https://opengameart.org/content/isometric-crops-and-farmland) | Nine crop families and assembled fields; random variants. | Useful planting rhythm. Variants are not time-sequence frames. |
| [City Building Game Art corn](https://opengameart.org/content/corn-farm-isometric-tile) | Large transparent corn image and layered PSD, CC0. | Higher-resolution painted shape study, with camera/palette adaptation required. |
| [Sprout Lands](https://cupnooble.itch.io/sprout-lands-asset-pack) | Pastel pixel farm, animals and tool animations; free/premium versions differ. | Excellent cute gesture/color reference; top-down. Published free terms are noncommercial, premium terms differ. |
| [Kathy Chow Tiny Garden](https://kathychow.itch.io/16x16-tiny-garden-free-pack) | Nine flower types, stages, seed/harvest icons, terrain and cat walk. | Particularly clear plant-to-item relationship; top-down and published redistribution restrictions. |
| [Levi Art farm](https://leviart.itch.io/isometric-cartoon-farm-tycoon-strategy-game-assets) | Eight crops/four stages, six buildings, props, PNG/PSD; paid pack. | Close visual-composition comparison, not a free download. Artist declares no generative AI. |

Do not mix all these styles in one yard. Choose a coherent crop/building family,
retain editable sources, and match light direction, silhouette weight, ground
contact, outline treatment and color hierarchy before integration.

## What Unicorn actually establishes

The pinned [Memoji source registry](https://github.com/nocktoshi/memoji-market/blob/e4a2d1440c2a283cea6cedaa1147fca49d187502/src/constants/index.ts)
contains **77 entries**, each with a denom, name, supply field, glyph, listed flag
and pool reference. It loads separate PNG portraits. These constants target
`osmo-test-5`; they are not proof of the complete historical mainnet catalog.
The extracted [registry](charmville-research-2026-09-08/memoji-registry.json)
preserves this distinction. Every extracted entry is marked listed; the current
file cannot reconstruct the historic hidden book by itself.

The image review shows several visual languages: expressive faces/animals,
objects/food, kaomoji, multi-emoji combinations, pixel relics and custom images.
The purple-pill item portrait exists. That does NOT recover a ritual birth screen.
The React/Vite source includes draggable desktop windows, Webamp, AG Grid and
Cosmos tooling. Trading's Classic/Hidden controls filter the listed property;
they are not evidence of karma classifications or cosmetic rarity tiers.

A [contemporary community article](https://medium.com/@notadevyet/unicornterminal-black-market-memes-4221ce44b185)
links a separate black-market interface, explorer and terminal. Its origin story
is explicitly presented as lore. The actual domain in that article is
`uwublk.market`, not the previously remembered `uwublack.market`. The V2 Pages
deployment still rendered a table shell during this research, with no rows;
the terminal domain failed DNS. These are live probe observations, not claims
that trading currently works. No wallet was connected or transaction attempted.

The [Delphi-attributed contemporary thread mirror](https://www.aicoin.com/en/article/413144)
corroborates emoji-combination tickers, including corn. It is a secondary copy,
not newly verified original Delphi documentation. Modern same-name token SEO
pages were excluded from reconstructing the 2024 UI. No accessible source here
establishes a Unicorn karma protocol, a complete ritual sequence or a complete
unlisted catalog. We should not invent those and attribute them to Unicorn.

## Charmville's item and reputation vocabulary

The duplicate Plank portrait was an implementation mistake in visual semantics:
the original spec already described distinct goods. Correct the presentation
without renaming inventory IDs or changing their balances.

| ID | Existing silhouette direction | Proposed expressive purpose |
|---|---|---|
| stalk | Friendly cereal stalk, reference 🌾 | Everyday acknowledgment / cheap talk |
| splinter | Stubborn little woodchip, reference 🪵 | A pointed or memorable contribution; not automatically a downvote |
| knock | Small wooden mallet, reference 🔨 | Welcome, visiting, calling attention |
| hum | Tiny radio, reference 📻 | Resonance, music, shared feeling |
| pith | Orange/heartwood cross-section, reference 🍊 | Substance, warmth, heartfelt contribution |
| gleam | Gold shaving/spark, reference ✨ | Delight, craft, noteworthy detail |
| knot | Eyed knothole, reference 🔘 | Connection, belonging, lasting bonds |

Silhouettes come from the existing pack; expressive meanings are proposed product
copy, not researched Unicorn meanings or approved voting weights. Each requires
a seed packet, growing plant stages, recognizable harvest charm, small ornament,
selected portrait and reaction motion. The glyph is a readable fallback; final
art must be a coherent authored set.

For broader expression, evaluate [Fluent Emoji](https://github.com/microsoft/fluentui-emoji),
[Noto Emoji](https://github.com/googlefonts/noto-emoji), and
[OpenMoji](https://github.com/hfg-gmuend/openmoji) as source systems. Fluent's repository
is MIT; Noto separates font and image licenses; OpenMoji documents its own terms.
Do not depend on OS emoji rendering for final consistent appearance. Store stable
charm IDs, aliases, Unicode sequences and versioned artwork separately.

Future catalog families can cover affection, laughter, surprise, thanks, comfort,
celebration, music, craft, belonging and seasonal combinations. Keep the seven
starter entries; do not automatically import all 77 historical items. Future
crafting needs explicit recipes and one atomic consume/produce receipt. Crafting
must never be required to restart Stalk with zero grain.

Inventory is spendable stock. A stamp spends stock once and attaches a reaction.
An ornament is that attachment's visual presentation. Reputation is the accepted
event projection. None of these is interchangeable with grain or seeds. Cosmetic
socket rules must state whether they also produce reputation before implementation.

## Storyboard the first visit, not merely the terrain

This is the next proposed art/interaction brief, not a claim these scenes exist.

| Beat | What the player sees | Required behavior |
|---|---|---|
| Arrive home | Owner label, six plots, a compact entrance and readable ripe crop silhouettes | Board/music remain present; no tutorial island or bank trip |
| Inspect | One crop leans or perks up; small species charm and clear action | Hover, keyboard and first touch have equivalent information |
| Gather | Plant compresses, charm releases, seed visibly returns to its stack | Reward appears after accepted receipt; no duplicate replay burst |
| Satchel | Distinct charm portraits in counted stacks; a selected expressive portrait | Opens without scrolling the board; mobile sheet preserves context |
| Replant | Seed drops, soil settles, recognizably different sprout remains | Stalk costs one seed; four-hour clock comes from server time |
| Pine | A charm settles onto content like an ornament | One intent, one burn; face total and supporter total remain distinct |
| Visit | Neighbor's handle and visitor state are obvious | Tend only where allowed; never imply the neighbor's stock is yours |
| Return | Same desk, garden position and WoodAmp continue | No collapsing garden during identity reattachment |

Use connected prop clusters: a seed crate, watering can and short worn path near
the entrance; a recognizable small shed behind the planting area; flowers and
shrubs as grouped borders. Preserve breathing room around crops. Supercell's
[Farm Patch guidance](https://make.supercell.com/en/create/hayday/farm-corner/submission-guidelines)
explicitly emphasizes cohesive arrangements and small gaps between decorations.
Our current uniform lawn and scattered trees miss that composed quality.

Proposed motion timings: 80–120ms input response, 150–250ms anticipation, 300–500ms
harvest release, then a brief stack acknowledgment. These are tuning targets,
not measured FarmVille timings. Gentle idle life should be staggered; the whole
screen should not pulse constantly. Reduced motion gets the same receipt and
clear static state. Effects volume is separate from WoodAmp; music never restarts.

## Search, social platforms and SEO

[Discourse](https://meta.discourse.org/t/searching-for-content-effectively/273328)
demonstrates composable author, date, tag, media and ordering controls, including
explicit AND/OR tag behavior and permission-dependent scopes.
[Mastodon's search API](https://docs.joinmastodon.org/methods/search/) separates
account, hashtag and status search. Borrow understandable scope/filter controls;
neither source establishes our richer per-charm four-metric contract.

Each Charmville predicate needs face ID + current/lifetime + totals/supporters +
comparison. Nested ALL/ANY/NOT, zero matches, ranges, multi-key sorting and stable
pagination must work over permission-filtered server data. Distinct supporter
counts must be recomputed/maintained from profile identities, not summed across
faces or posts. A person supporting two posts is still one unique supporter of
the author's aggregate, if such an aggregate is later approved.

Keep internal discovery and public indexing deliberate. Canonical content and
curated collections can be crawlable; arbitrary threshold permutations should
not generate an unlimited crawl space. Google's
[faceted-navigation guidance](https://developers.google.com/crawling/docs/faceted-navigation)
explains why uncontrolled filter URLs waste crawling resources. Robots rules are
not access control. Private drafts, private inventory and inaccessible content
must remain excluded from responses before any SEO decision.

## Concrete next implementation order

1. Finish identity-transition/scroll regression checks and owner/visitor clarity.
2. Build the seven-item art bible and replace the duplicate mascot resource icon.
3. Compose one finished compact garden from a coherent source family, then adapt
   that same composition to desktop and 390px mobile; no separate mobile art style.
4. Review planting, harvesting and stamping in motion with the satchel and music.
5. Implement event-backed reaction projections and the four-metric search contract.
6. Extend the authored catalog and optional crafting only after the seed loop,
   inventory, ornaments and projections are consistent.

This research does not certify the current 6/10 garden as finished or replace the
full unified build roadmap. Public market, caster and continuity boundaries remain.

## Local changes and regression evidence

The screenshot's `play_1b96190bf0` is a synthetic test profile. The porch now names
the viewed handle and distinguishes verified ownership from visiting or viewing.
A delayed-read browser test reproduced garden removal during a wallet-state
transition before the fix. The component now clears owner privileges and private
inventory immediately while retaining public plots until the server responds.
The test passes after that change. This addresses a demonstrated collapse/expand
path; the user's exact navigation sequence remains to be confirmed.

Satchel opening/closing also explicitly preserves scroll while moving keyboard
focus. Desktop and mobile viewport regressions pass, but those tests did not
reproduce the original reported jump before the focus hardening. Do not present
that alone as the root cause. TypeScript passes; scoped lint has zero errors and
two existing porch warnings. No deployment or real-wallet signature was performed.
