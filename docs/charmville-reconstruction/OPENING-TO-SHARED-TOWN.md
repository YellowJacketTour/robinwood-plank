# Opening to the shared town

Approved requirements capture, September 13, 2026. This document specifies the requested player experience; it is not evidence that the scenes, maps, persistence or shared town have shipped. Read with `STORY-VOICE-AND-HERO-CONTRACT.md`, `HOMETOWN-HOMESTEAD-AND-JUSTICE.md` and `STARTER-NARRATIVE-PLACEMENT.md`.

## Priority and experience

Build the family departure, companion introduction, farming, charm custody and first social use before expanding combat or team combat. A companion is first a friend who joins the journey, not a demand to teach battle immediately. The homestead and shared town form one progression, with the same account, possessions, party and discovered knowledge throughout.

The hero is seven in the fiction. The player chooses the boy or girl presentation, names their hero, receives the family's proud and absurdly premature declaration of independence, and learns to make a living through care. Love is the enduring theme. Elevated prose belongs in short, well-timed scenes; practical instructions remain literal. Use Charmdex consistently as the guidebook name.

## Scene sequence and committed outcomes

| Stage | What the player sees and does | Required durable outcome |
|---|---|---|
| Title | Illustrated title scene; Begin Adventure or Continue, settings available without leaving the scene | No account reset or grant from merely opening the title |
| Hero | Preview actual supported boy/girl art, choose a name, confirm together | Appearance and name saved to the existing game profile; shared capability contract |
| Family | Short staged conversation, parent movement and a visible gift handoff | One starter gift receipt per eligible account; cinematic completion separately recorded |
| Home | Walk through a readable expanded house and yard; learn movement and interaction | Owned home address and valid spawn; tools accessible without hidden menu hunting |
| Partner | Meet and inspect the supported starter choices; choose, confirm, then see the companion appear beside the hero | One starter allocation, actual party membership and independent follow setting |
| Garden | Prepare visible soil, plant the family Burning Heart seed, water, observe distinct growth and harvest | Real crop state, resource costs, elapsed growth and conserved yield |
| Satchel | Inspect the harvested charm, its identity, amount, origin and social use | One custody record viewed through inventory/satchel, never duplicated by the presentation |
| Sharing | Choose a recipient or eligible post; preview one love reaction and confirm or cancel | Explicit player-authorized use; cancellation consumes nothing; retry cannot double spend |
| Household | Optional first animal care, fishing, cooking or simple crafting lessons | Actual receipts and discoverable instructions; no pretend outputs awarded by dialogue |
| Departure | Follow the visible road to the shared town; see destination and travel readiness | Server-admitted destination preserving home, inventory, party and tutorial checkpoint |
| Town | Arrive at a protected meeting place, orient by map/signs, meet others and inspect an exchange quote | Shared presence and services with truthful connected/failed states; no compulsory trade |

Partner selection follows profile creation and family context, while farming remains the main first-session progression. Do not require combat mastery to reach town. Skip/replay controls skip presentation only: they cannot bypass resource eligibility, duplicate gifts or reset a returning player's location. Optional household lessons can continue after reaching town.

Names need consistent validation, length measured in rendered text, localization-aware display and safe rendering. Fictional hero age does not establish the account holder's age or authorize financial or community features. Do not ask for private keys or wallet signatures for the local introductory experience; local progress must remain clearly separate from authenticated custody until an explicit supported transfer exists.

## Expanded starter property

Author a Link-house-inspired family interior, sheltered yard, bounded garden, livestock space, reachable pond bank, work area, storage, companion gathering space and one legible townward exit. The original source house is not certified to contain these additions. Inspect the real source tiles before choosing geometry. Maintain stable world coordinates for placed objects, collision and interaction anchors; camera panning cannot drag beds across screens.

The long-term home supports furnishing, room and floor changes, gardening layouts, terrain and paths, animal enclosures and visitor collaboration. Build a versioned placement model now rather than baking everything into one tutorial coordinate. Object definitions need footprint, ground anchor, visual layers, interaction anchors, allowed surfaces, ownership and rotation variants. Placement previews show valid/invalid results through shape and words as well as color. Confirm/cancel is the default; advanced tools reveal progressively. Preserve an accessible entrance and routes to essential interactions. Moving a crop or container preserves its identity, contents and timers.

Visitor roles distinguish viewing, assisting, decorating and resource use. Friends cannot take ownership through a visit. An owner's first tutorial must survive friends arriving, leaving or completing their own tasks. A returning player resumes at a valid location, never the initial cinematic spawn merely because a menu reloads.

## One Charmdex, knowledge learned together

The Charmdex is the in-world guidebook and communication device: discovered creatures, crops, tools, recipes, places, people, quests and charm uses share a consistent inspect/search/back flow. Its personality is knowledgeable but fallible in a charming way; authoritative facts are not generated guesses.

Separate authored canonical information, server-verified discoveries, player annotations and AI explanations. Entries carry stable content IDs, version, discovery condition and provenance. Private home coordinates, undisclosed party activity and allow-listed information do not become public discoveries. Shared discovery credit follows explicit party/world rules and deduplicates the same event; knowledge reveals do not mint duplicate items.

An AI guide may explain verified information with source references and mark unknown or unconfirmed details. It must not invent spawn locations, prices, drop rates, recipe results, player observations or ownership. Market quotes come from the actual market service and show freshness; discoveries come from validated game events. A witty sentence cannot substitute for either source.

The Babel-fish-inspired translation idea means optional multilingual assistance, not magical correctness. Store authored strings by stable key, support localization expansion, keep player originals available alongside translations, and identify machine translations. Avoid translating player names or stable item identifiers into new identities. Use icons, portraits, diagrams and controls to make the tutorial understandable without reading a paragraph. Shared annotations and translations need reporting and moderation; a player's note is not a command to the guide or game server.

## Kakariko shared hub and protection

The first shared safe hub uses Kakariko's walkable-village organization: exchange, general supplies, seed/feed services, care/healing, workshop, noticeboard and a visible social meeting point. Starter resources belong at reachable outskirts; advanced resources invite further travel. The hub is a shared place with finite resource rules, not a separate imitation for every account presented as multiplayer.

Town crime follows the justice contract: deliberate criminal actions, witnessed incidents, proportional guard escalation, surrender and restitution, bounded dispatch and protected bystanders. Companions never autonomously attack innocents. Wanted status cannot silently enable PvP or let guards invade private homes. Theft does not touch player escrow or create a second copy of an item. The basic onboarding route remains available without committing crime, being chased or watching a compulsory violence demonstration.

## Current reality and delivery order

The inspected native runtime still has the meadow/Oran opening and existing placement constraints. Family scenes, a compatible full girl action set, expanded source-authored property, Burning Heart custody chain and Kakariko town are not certified by this document. Existing party and account systems are integration points, not proof this sequence works end to end. Do not relabel Oran as Burning Heart or advertise a complete shared village while rendering local reference actors.

1. Bind a versioned opening state to the existing profile and receipts; implement title/hero/family scene presentation without resetting returning players.
2. Verify the selected home source art and author its geometry, placement, arrival and reciprocal travel as one change.
3. Complete the distinct Burning Heart grant, growing, harvest, custody and confirmed social-use chain.
4. Integrate starter selection and following into that same opening; finish both hero presentations' required action coverage.
5. Connect protected shared-town admission and a first two-account visit; integrate services using the same inventory and party.
6. Expand household customization, communal discoveries and justice only on the verified foundation.

## Acceptance gates

- [ ] Fresh boy and girl profiles complete the same title-to-town journey; their actual sprites perform every tutorial action with matching movement, equipment anchors and collisions.
- [ ] Reload/disconnect at each scene, grant, harvest, reaction and travel boundary resumes correctly without duplicate custody or false completion.
- [ ] Every visible action has measured anticipation/contact/result/recovery and appropriate direction/layers; cinematic actors and UI never block the task unexpectedly.
- [ ] Keyboard, touch and gamepad share clear confirm/back behavior, readable text and stable focus; opening menus remain usable across supported viewport sizes.
- [ ] Burning Heart has its own identity from seed through charm use, with inspectable costs and no Oran relabeling or unbounded tutorial reclaims.
- [ ] A friend can visit, assist within permission and return to town while both accounts retain independent progression and resources.
- [ ] Two accounts see the same admitted town activity; resource contention, reconnect and return-home travel preserve authoritative outcomes.
- [ ] Charmdex discoveries distinguish verified facts, private data, player notes and translations; AI explanations cannot assert unsupported game state.
- [ ] One deliberate theft and surrender works end to end without harming a bystander, blocking essential onboarding or duplicating stock; broader wanted escalation remains separately gated.
- [ ] A recorded live playthrough and targeted transaction/state checks support completion claims. Documented plans alone do not fill these boxes.

