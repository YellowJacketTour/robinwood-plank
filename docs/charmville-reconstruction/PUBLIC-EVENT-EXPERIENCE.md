# Public events in a continuous Charmville world

## Decision and scope

The world should remain the main screen. A player tending a home plot should notice activity on the horizon, see friends heading toward it, zoom outward without resizing the browser canvas or changing movement, and choose whether to follow. On arrival, the player must understand the immediate task through scenery, animation, a compact objective, and readable danger signals. Public events connect farming, companions, combat, construction, travel, social viewing, and the Charm economy; they are not a separate lobby minigame.

This document records research reviewed on September 13, 2026 and proposed implementation requirements. Historical developer descriptions explain particular releases, not necessarily current balance. Community reports are individual experiences, not measured prevalence or verified diagnoses. No cited game establishes Charmville's capacity, and nothing here marks a feature implemented. Retain all requirements in [the approved completion contract](APPROVED-GLOBAL-COMPLETION-CONTRACT.md), especially GLOBAL-01/02/08/10–20/25.

## Studied examples

### Destiny: discovery, convergence, and optional escalation

Bungie's activity guide describes public-event participation for players already occupying the public space. Map nodes expose upcoming timing; interacting with an event flag sets a shared waypoint. A newer Bungie guide describes hidden mechanics that escalate public events to Heroic variants with better rewards. These are useful references for making an event discoverable before arrival and allowing a familiar encounter to deepen through player action. They do not imply global visibility or unlimited participants. [Bungie activities](https://help.bungie.net/hc/en-us/articles/360048720992-Destiny-2-Activities), [Bungie new-player activities guide](https://help.bungie.net/hc/en-us/articles/46668136913172--10-Activities).

The hidden escalation also produces friction. In a historical player discussion, some participants describe not knowing the trigger; others describe completion bounties encouraging rapid boss kills that prevent another player's desired escalation. This is a conflict between incentives and legibility, not simply a lack of instructions. Preserve discoverable secrets, but give an in-world clue, an optional hint, and an explicit party signal when someone begins a cooperative escalation. Avoid rewarding ordinary progress that sabotages the current shared objective. [First-hand Destiny discussion](https://www.reddit.com/r/DestinyTheGame/comments/fkdew3/a_great_load_screen_tip_would_be_how_to_make/).

The Datto video is a historical player-authored demonstration reference, not an official source or evidence of current mechanics. Its indexed description enumerates event-specific secondary interactions. It is useful for a future shot-by-shot gameplay review; only its available description was reviewed here, not a frame-complete visual analysis. [Destiny 2: How to Activate Heroic Public Events, September 6, 2017](https://www.youtube.com/watch?v=sxq5NrQvc2k).

### Warcraft: a moving event can unite farming and combat

Blizzard's Guardians of the Dream description combines an hourly moving Superbloom escort with watering, weeding, creature assistance, and enemy waves. A shared Bloom measure affects extra rewards, and smaller groups receive compensating Bloom. Related Emerald Frenzy activity occurs in a random area; Emerald Bounty lets players plant seeds in world patches and contribute while defending growth. This is a close design reference for a farming economy feeding public adventure rather than remaining a private timer screen. [Blizzard, Guardians of the Dream public events, October 18, 2023](https://worldofwarcraft.blizzard.com/en-us/news/24017020).

First-hand reports identify important failure modes: an event remaining at zero time without advancing, a full progress bar mistaken for completion, missing waves, and apparent loss of the event when leaving a moving area. These reports do not establish the underlying cause. They justify separate phase and reward displays, a visible moving participation boundary, recovery for stuck transitions, and preservation of legitimate contribution. [November 2023 event report](https://us.forums.blizzard.com/en/wow/t/superbloom-dosent-even-work/1705030), [March 2024 stuck-event report](https://us.forums.blizzard.com/en/wow/t/superbloom-bugged/1816750), [moving-area discussion](https://eu.forums.blizzard.com/en/wow/t/phasing-out-of-superbloom/475592).

### ARC Raiders: conditions change the meaning of a familiar map

Embark's official tracker separates named map conditions and events, supports server-region selection, and presents active and upcoming time windows. Its August 18, 2026 update explicitly moved condition schedules toward regional peak hours. The design lesson is that anticipation and accessibility belong inside the product, without forcing players to follow an external spreadsheet or be awake in one favored time zone. Exact tracker times are dynamic and should not be copied into Charmville. [Official map conditions](https://arcraiders.com/map-conditions), [Live Update 1.42.0](https://arcraiders.com/news/live-update-1-42-0).

The official Shrouded Sky teaser and release video provide audiovisual reference candidates for environmental anticipation and a storm as an event identity. Their indexed descriptions establish the Hurricane framing; this report does not claim frame-level inspection, measured readability, or detailed mechanics from unviewed footage. A separate official community competition solicited Hurricane gameplay clips, illustrating how an event can also become a shared storytelling subject. [Official teaser, February 19, 2026](https://www.youtube.com/watch?v=9lGpwVvdyJQ), [official update video, February 23, 2026](https://www.youtube.com/watch?v=xPaKRV76Tlc), [Embark Storm Stories rules](https://id.embark.games/arc-raiders/support/faq/233-storm-stories-community-competition--official-rules).

An ARC player-authored Hidden Bunker guide describes distributed antenna activation converging on a contested destination. Other first-hand comments disagree about reward value and the purpose of the activity. Treat these as experience reports rather than an authoritative loot table. The useful question for Charmville is whether distributed labor earns intelligible credit before a crowd reaches a finale; a player who prepared the event must not be forgotten because another group arrives at the last moment. [Player guide](https://www.reddit.com/r/ArcRaiders/comments/1oroy6x/complete_guide_to_open_the_hidden_bunker_in_arc/), [player reward discussion](https://www.reddit.com/r/ArcRaiders/comments/1qtxgow/hidden_bunker_is_the_worst_event_design_ive_ever/).

### Guild Wars 2: consequences, timing, and destination identity

ArenaNet explicitly describes casual cooperation without a party, individual rewards, scaling challenges, and event outcomes changing the surrounding area. Follow-up events can reflect success or failure. These are useful precedents for meaningful world consequences. Its individual-loot policy is not automatically Charmville's policy: the approved distinction between party and unpartied loot must remain explicit. [ArenaNet dynamic events](https://www.guildwars2.com/en/the-game/dynamic-events/).

The historical megaserver article is particularly relevant to continuity. It explains scheduling bosses across dynamically created map populations, guild-triggered encounters, and incorrect cross-map status when a destination copy differs from the displayed world. Charmville should retain the exact event and destination identity in map indicators and invitations, and avoid silently transporting a friend into a visually similar but different encounter. Historical schedules and limitations in this article are design evidence, not a current service specification. [ArenaNet world bosses and events, 2014](https://www.guildwars2.com/en-gb/news/the-megaserver-system-world-bosses-and-events/).

## Player experience requirements

### World visibility and handheld text

The gameplay viewport fills its allocated space. Remove decorative dead framing through a real render/composition change, not by cropping away needed world pixels or stretching the original image. HUD elements occupy stable screen space while the world camera changes scale. Preserve aspect ratio, mobile safe areas, readable interaction distances, and a comfortable default zoom. Detailed text moves to an intentionally opened Charmdex panel; urgent gameplay information stays visible.

Use three simultaneous information levels:

| Level | Presentation | Purpose |
|---|---|---|
| World | Distant plume, migrating creatures, changing sky, event beacon, moving convoy | Notice something happening without reading |
| Immediate guidance | Small icon, short action phrase, progress or timer, optional direction marker | Know what to do now |
| Charmdex | Event map, phase explanation, party location, reward eligibility, history, accessibility settings | Understand the full system when requested |

Example microcopy is functional, not final branding: `Help the caravan`, `Water the roots · 3/5`, `Storm arrives · 2:10`, `Reward secured`, `Follow your party`. Show one primary objective and at most one relevant secondary objective. Never make a constantly expanding log push the world out of view. Dialogue is paged by meaning, records itself in a journal, and has manual advance, replay, text-speed and instant-text options. Do not require reading a timed tutorial while combat remains dangerous. Public combat cannot pause globally when one player opens a menu; show that state clearly and provide safe places to read.

Color reinforces icon, shape, motion, and wording rather than carrying meaning alone. Danger silhouettes and ground boundaries remain visible under spell effects. Subtitle background/size is configurable independently of camera zoom. Controller prompts change to the active input device without rearranging the menu. Touch targets remain usable at maximum world zoom-out.

### Migration and arrival

An event moves through authored phases: dormant, announced, gathering, active stages, resolution, aftermath, recovery. Some begin on a schedule, some from world conditions, and some from earned player actions. Seeded randomness can vary location, weather, routes, and encounter composition, but must respect navigation, home safety, region level constraints, existing events, and resource budgets.

The map shows real permitted event state: where, phase, destination instance, approximate travel time, and whether friends are there. It does not reveal private homes or concealed PvP positions. A friend marker identifies the same world population, not merely the same place name. A full destination offers an honest admission state and a safe return; no silent duplicate event pretending to contain the friend.

Players physically gather along navigable paths. Companions preserve identity, facing, collision intent, and animation while formations compress at narrow crossings. The event's safe arrival area must not be the boss's attack origin. Joining midway does not reset the boss or rewrite the player's progression. At arrival, show the current short objective and existing phase progress immediately; the journal explains earlier stages without forcing an intro cutscene.

### Party, unpartied, PvE, and PvP reward rules

Preserve the approved policy: eligible party members receive their own guaranteed reward entitlement, while unpartied players do not automatically each receive duplicate personal loot. Exact item/money outcomes can still vary by content, scarcity, and eligibility. An entitlement need not mean an unrestricted valuable item mint. Every event declares which finite reward budget, table, sink, and issuance rule it uses.

For unpartied cooperative public events, distinguish shared event success from individually owned drops. Show whether the reward is a contribution claim, a shared contested drop, a party entitlement, or a public world unlock before players invest effort. A helper can receive legitimate support credit without silently changing all monster drops into personal loot. If a future exception is desired, it requires an explicit economy rule, not a UI convenience.

Credit can include validated damage, healing effective damage, shielding, revives, deliveries, construction, watering, escort presence with active tasks, and puzzle work. Do not grant credit for overhealing, hitting invulnerable targets, repetitive action spam, or spectators. Participation should not require a high-level damage race. Preserve already earned credit across a short disconnect or a legitimate moving-boundary crossing, with explicit expiry rules.

Party membership and reward eligibility are snapshotted at documented stages to prevent last-second invitation minting. Allocation commits exactly once against the authoritative event occurrence and recipient/claim. Retrying, reconnecting, changing floors, changing combat perspective, or crossing a worker boundary cannot grant it twice. Full inventory routes an owned reward to a durable claim location without creating a second copy.

PvP or competing-party events announce their rules before crossing the relevant boundary. Watching a public stream never confers participation or exposes otherwise hidden opponents through map telemetry. Friendly repair and farming events do not become PvP because a hostile party approaches. A PvP-enabled storm or contested caravan is an explicit region/activity rule.

### Hybrid combat in the crowd

Action combat and staged companion commands use one event occurrence and creature record. Boss HP, status durations, capture eligibility, cooldowns, contributor credit, and queued actions survive viewpoint changes. Public action continues on the authoritative timeline; a private staged view cannot pause strangers or earn extra actions. A genuinely turn-based encounter requires an explicitly compatible participant set and rules.

The staged background shows actual permitted nearby actors and actions where feasible. It is not a random decorative battle movie. A zoomed-out view may simplify art, but active hitboxes, attack warnings, target identity, and outcomes remain equivalent. Every monster ability needs windup, release/contact, effect, recovery, and interruption/death handling rather than an interchangeable particle burst.

## Scale and rendering design proposals

Zooming out increases visual coverage, not simulation authority or permission. Near combat uses precise entity updates. Far permitted travelers can use lower-detail sprites, interpolated trajectories, and reduced cosmetic effects. Strategic views can summarize distant density, but a summary must not be passed off as individually simulated visible players. Transition between representations should preserve positions and prevent popping on turns.

Prioritize visibility in order: incoming hazards and local player; selected target and immediate interactables; party and their relevant companions; nearby threats and helpers; distant crowds; nonessential ambient effects. The camera must not activate monsters solely because a player zoomed out, nor stop a dangerous attack because it left view. Simulation, interest management, and visual presentation require separate bounds.

Epic documents why per-actor/per-client replication decisions become costly and describes persistent replication-graph nodes with game-specific relevance. Its Fortnite example is 100 connected players and about 50,000 replicated actors, not a claim that all actors are active fighters or that this browser stack supports those numbers. Adopt the relevance principle only after profiling the actual Charmville authority, serialization, client render, and companion AI costs. [Epic Replication Graph documentation](https://dev.epicgames.com/documentation/unreal-engine/replication-graph-in-unreal-engine).

Proposed experiment: make an event's migration corridor an anticipatory relevance region. Prefetch permitted terrain and coarse public traveler state ahead of the gathering; increase precision as interaction becomes possible. Compare against radius-only relevance using the same recorded workload. Promotion requires lower late arrivals/pop-in and bounded bandwidth/CPU without leaking hidden state or changing outcomes. This is a testable hypothesis, not a claimed novel invention or proven gain.

## Acceptance scenarios and evidence

| ID | Scenario | Required evidence |
|---|---|---|
| EVENT-01 | Zoom while walking between adjacent authored regions | Camera shows more terrain; canvas/HUD size and authoritative movement speed stay constant; no black artificial room boundaries |
| EVENT-02 | Notice and approach an event from a home | In-world cue, accessible direction, correct destination, safe arrival, no mandatory dashboard detour |
| EVENT-03 | Late arrival during each phase | Current objective and phase agree with server; past personal progress unchanged; support role remains useful |
| EVENT-04 | Solo, small party, multiple parties, unpartied crowd | Explicit eligibility; party guarantees preserved; no accidental unpartied duplicate loot; measured challenge scaling |
| EVENT-05 | Player dies, disconnects, changes perspective or crosses authority boundary | One encounter timeline; earned contribution and custody recover exactly once |
| EVENT-06 | Objective fulfilled while enemies remain, zero timer, missing wave, failed script | Phase transition has a defined outcome/recovery; reward meter is distinct from completion; failure never silently freezes forever |
| EVENT-07 | Large migration with full six-companion rosters | Recorded client/server frame times, update age, bandwidth, correction rate, population and device/browser; no fabricated humans or capacity claims |
| EVENT-08 | Dense finale with many effects | Local player, target, party, ground hazards and actionable prompts remain readable on phone and desktop |
| EVENT-09 | Friend follows profile stream into event | Same event identity, admission validated, privacy respected, safe join and return |
| EVENT-10 | Repeat occurrence and world aftermath | Distinct occurrence ID; event budget/custody conserved; authored world change and recovery persist |

Capacity testing should increase real authenticated clients and simulated workload separately: 1, 6, 20, 100, then higher only as measurements justify. Report players, companions, active enemies, replicated objects, and video viewers separately. Set device-specific budgets before acceptance; a successful small test is not evidence for millions of simultaneous local actors. Video evidence must include a real browser run, not just native simulation logs.

The first complete event should connect existing homestead farming to a public moving objective, companion assistance, a readable combat finale, a durable reward claim, and a changed world feature. Finishing that continuous loop is the prerequisite for multiplying event types. All EVENT gates remain pending until implementation and recorded evidence exist.
