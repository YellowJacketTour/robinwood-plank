# Unified combat, companions and cooperative worlds

## Design conclusion

Charmville should use one authoritative encounter simulation with multiple ways to control and view it. Direct sword-and-tool play, companion commands and a staged battle camera must operate on the same entities, action clock, HP, effects and resource ledger. A camera transition must never manufacture another enemy, erase damage, extend a buff or grant a second reward.

This is a proposed synthesis, not a claim that every source system can run unchanged together. Emerald-style turns, real-time action and MMO raid scheduling have incompatible timing assumptions. The strongest approach is to preserve recognizable action identities and presentation while defining an explicit shared scheduling policy. Separate rule profiles can preserve stricter source behavior in designated challenges without pretending those profiles are interchangeable mid-fight.

The current implementation supports a bounded starter/test-party turn battle, six source-backed followers, shared encounter HP and authenticated spectator/event presentation. It does not yet support simultaneous party attacks, full status effects, raid AI, capture settlement or faction PvP. The detailed evidence tracker remains authoritative for implementation status.

## Primary precedents

Pokémon Legends: Z-A provides a direct precedent for trainers and creatures moving in real time while creatures execute trainer commands. Its official gameplay description explicitly calls out timing, move reach, areas of effect and activation time. This supports choosing action scheduling and spatial targeting as first-class systems; it does not establish an MMO architecture or permission model.[^1]

Pokémon Legends: Arceus describes seamless entry into wild battles and action order that can allow consecutive actions. Agile and strong styles trade power against action speed. Its research tasks also show how discovery can extend beyond owning one specimen. The useful design lesson is to connect exploration, observation and combat without reducing every encounter to defeat-and-loot.[^2]

Scarlet/Violet's official Tera Raid description presents four-player cooperation under a time limit without waiting for every other player to choose an action. It also offers team-wide attack, defense and recovery cheers. The proposed Charmville adaptation is a small, understandable assistance palette available before a player masters a full creature moveset.[^3]

Z-A's Battle Club is a distinct PvP ruleset: up to four players compete during a three-minute match, with recovery on re-entry and points for defeats. It illustrates why PvP recovery and scoring can be ruleset-specific rather than inherited from the persistent world. Charmville should likewise declare arena rules before entry.[^4]

Solarus custom-state APIs explicitly separate permissions to swing, cut, use a shield, use items, interact and grab. This is valuable implementation evidence for an action-state schema: the visual sword pose, shield behavior, movement and allowed interactions belong to one action definition. Solarus documentation alone is not evidence that it can host the intended large multiplayer world.[^5]

The companion research documents cover OSRS/Diablo and Final Fantasy/Graal/Dragon Ball in detail, with additional primary sources and version limitations. Their conclusions are incorporated below as proposals; exact source mechanics remain distinguishable from the proposed unified rules.

## What is preserved, adapted and separated

| Design concern | Preserve | Adapt for a shared world | Keep in explicit rulesets |
|---|---|---|---|
| Adventure combat | Facing, anticipation, contact, recovery, tools and readable impact | Server validation of reach, collision and resource use | Source-specific invulnerability and cancel rules |
| Creature combat | Species identity, move identity, type/status meaning and roster ownership | One spatial action scheduler and target model | Exact generation-specific turn order and damage rules |
| MMO progression | Persistent skills, useful materials, social specialization | Contribution accounting for healing, control and support | Risky loot-loss and competitive restrictions |
| Action-RPG builds | Meaningful ability interactions and equipment choices | Bound effect stacking and understandable counters | Extreme seasonal multipliers and resets |
| Cooperative raids | Complementary roles, telegraphs, recoverable mistakes | Admission, relevance filtering and party command limits | Encounter-specific resurrection and reward policies |
| Transformations | Distinct silhouette, charge, aura and changed moves | Resource budget, interruption and effect-density limits | Temporary spectacle modes and competitive normalization |

The table is an implementation recommendation. It is not a claim that all named source games share these rules.

## One encounter clock

An accepted action should identify its actor, controller, target or target area, ability version, encounter and input sequence. The server resolves preparation, release/contact and recovery on its own clock. It records resource costs and results once. Presentation receives event identities and timing; it cannot submit authoritative damage because a sprite overlapped something.

Direct play can predict movement and the start of a swing for responsiveness. Reconciliation must correct rejected actions without issuing rewards. Command play queues the selected creature's intent into the same scheduler. The staged camera may make targeting easier to read, but it cannot pause enemies for one participant while everyone else remains exposed.

A strict turn challenge is a separate encounter profile. All participants agree to it on admission, and the world-space interaction rules say whether outsiders are spectators, reinforcements waiting for a boundary, or excluded. Mixing a paused turn participant with unrestricted outside damage creates exploitable timing and unintelligible status durations. That conflict must be resolved in rules, not hidden by animation.

Initially admit two cooperating controllers against one enemy, with one active creature each. Verify ordering, reconnect, interruption and reward accounting before increasing active creatures or player counts. Six roster members need not mean six independent full-rate actors all the time: roster capacity, following capacity and active-combat capacity are separate explicit settings. No fixed large raid capacity should be promised before load and visual-density measurements.

## Companion intelligence

Companion behavior should be a limited, inspectable policy. Beginner commands are follow, defend, focus this target and return. Advanced presets may prioritize healing an injured ally, interrupting a marked cast or protecting a position, but those presets must obey ability costs, line of sight, cooldowns and permission rules. An auto-command is not permission to attack neutral players or protected creatures.

Each companion needs a controller assignment, formation slot, leash, current intent and fallback behavior. Path history is sufficient for the existing follower trail but not combat navigation. Combat requires traversability, avoidance, valid attack positions and recovery from blocked paths. A creature unable to reach a target should report that condition and reposition or return; it must not swing forever through a wall.

The interface should explain the current command and allow immediate recall. Advanced policies should be editable as a few ordered conditions with visible reasons for each decision. Avoid a programming interface as the beginner default. A player should be able to understand why a companion healed, waited or refused an attack.

## Status, buffs and crowd control

Every status definition needs a source, target, duration model, stacking group, maximum stacks, refresh rule, dispel category and visual cue. Damage over time uses server ticks. A camera change does not convert seconds into fresh turns or reset a poison duration. Healing reduction, shields and damage amplification need bounded ordering rules so combinations remain testable.

Boss control should usually become resistance, stagger or a limited interruption window rather than unlimited stun chains. This is a proposed raid policy, not a universal rule copied from the references. It preserves the value of control specialists while preventing a large group from permanently removing an enemy's ability to act.

Support contribution must count effective healing, useful shielding, successful interruption and objective work. Raw cast counts reward spam; overhealing and repeatedly applying an already-maxed buff should not create unlimited contribution credit. Reward eligibility should be declared at encounter admission and settled from capped contributions, not last-hit ownership alone.

## Source artwork and camera architecture

An asset manifest must identify source revision, file hash, license/provenance note, species or actor, action, direction, frame timing, ground anchor, hand/mouth/projectile anchors, collision footprint and intended role. A portrait is not a walking sheet. A walking sheet is not evidence of a valid attack animation. Unsupported combinations require authored work rather than substituting a visually unrelated effect.

The renderer should transform world positions into camera positions while keeping simulation geometry unchanged. Ground sorting follows foot contact. Overhead effects, flying actors and projectiles need explicit height bands. Equipment layers must follow each animation's poses: a shield cannot remain rigidly over the torso during a sword swing, and a beam should begin at the authored emission anchor.

A staged view can reposition the camera and frame the active fighters while leaving allies visible at their actual projected world positions. If a cinematic rearranges actors for clarity, the rearrangement must be presentation-only and visibly consistent; it cannot change attack reach or collision. Spectators should retain recognizable handles and silhouettes without appearing to execute actions they did not perform.

Transformations need more than an aura. They need a coherent alternate silhouette or palette, charge/release phases, movement treatment, impact language and audio state. Their mechanics need costs and limits independent of particle density. Reduced-motion and low-effects modes must retain danger telegraphs and action readability.

## Controls and onboarding

Start with movement, context action and equipped action. Context labels should identify both the target and the consequence: water a friend's crop, meet a creature, return a companion or cancel rest. Advanced combat controls can add targeting, dodging, blocking and companion commands gradually. Keyboard, controller and touch should share action names and intent, not necessarily identical physical layouts.

The first cooperative encounter should teach one attack, one defensive response and one help action. The next adds a companion swap and a visible elemental or status interaction. Raid-level combinations belong after the player has learned those pieces through smaller encounters. A beginner should contribute without managing six separate cooldown bars.

Charmdex should be the consistent home for party, discovery, equipment, skills, friends and market information. Opening social or market panels during danger must not imply a global pause. A safe-area indicator and a clear return-to-action command are more useful than burying the player under overlapping panels.

## Economy and rare captures

Combat consumes and produces resources through explicit budgets: ammunition, healing, repair, capture items and authored reward tables. Real-money purchases should not create unbudgeted combat supply. Cosmetic access, season access and game currency transfers require separate accounting from material issuance.

Rare wild creatures require an explicit capture policy before multiplayer capture is enabled. Options include one captured entity shared through agreed ownership, a personal reward entitlement with independently budgeted issuance, or a cooperative research reward without a catch. Allowing every participant to duplicate one scarce wild entity contradicts a one-entity scarcity model unless the reward definition explicitly authorizes multiple issuance.

Capture settlement must debit one ball, resolve one stored random outcome and create at most the permitted number of owned entities in one transaction. Full party handling must be decided before spending: reject, send to implemented storage, or require a slot choice. A retry must never reroll odds or spend another ball. Discovery entries may credit observation, assistance and study independently of ownership.

## PvP, factions and social play

Introduce consent-based duels and normalized arenas before open conflict. Arena admission should show team size, companion limits, equipment policy, loss rules and victory conditions. PvE status durations and damage multipliers should not silently carry into competitive modes. Matchmaking and accessibility need separate testing from enemy AI.

Faction play can begin with cooperative construction, territory objectives and scheduled battles. Persistent territorial loss should have protection against offline griefing and unclear ownership. Guild/faction authority needs explicit roles and audit trails, particularly when pooled materials or market assets are involved. Proximity chat must have mute, report and per-channel controls; voice should not be necessary to understand a telegraph.

Later large battles should separate strategic objectives from pure elimination: defend a convoy, interrupt a ritual, power a structure or escort a rare creature. These objectives give non-damage professions and support parties useful roles. They also connect the farming/crafting economy to world events without forcing every player into PvP.

## Verification and release gates

| Gate | Required evidence |
|---|---|
| Shared identity | Both cameras and two accounts agree on encounter, HP, statuses and event sequence |
| Direct combat | Four-facing contact timing, line-of-sight, cancel/recovery and authoritative hit validation |
| Cooperative commands | Two controllers, legal targets, support effects, disconnect and command ownership |
| Source presentation | Correct anchors, frames, layers, projectiles and no replayed damage effects |
| Progression | XP/reward conservation, anti-farming limits, repair/consumption and reload |
| Capture | Ball debit, stored outcome, uniqueness, full-party policy and lost-response recovery |
| PvP | Consent, normalization, collision/timing fairness and explicit loss rules |
| Scale | Measured simulation cost, network relevance, frame time and effect readability on target devices |

The next implementation milestone should be a small cooperative encounter with a direct attack, one companion attack, one support effect and one shared enemy. It should preserve the current account economy, roster and recovery. Only after that loop passes visual, network and economic checks should it expand into rare spawns, multiple enemy roles and raid scripting.

## Sources

[^1]: The Pokémon Company, [Experience Brand-New Mechanics in Pokémon Legends: Z-A](https://legends.pokemon.com/en-ca/gameplay), official product page, accessed September 9, 2026. Product page notes development footage; used for declared mechanics, not performance claims.
[^2]: The Pokémon Company, [Pokémon Legends: Arceus — Gameplay](https://legends.arceus.pokemon.com/en-gb/gameplay/), official product page, accessed September 9, 2026.
[^3]: The Pokémon Company, [Tera Raid Battles](https://www.pokemon.co.jp/ex/sv/ja/battle/220803_01/), official Japanese Scarlet/Violet page, accessed September 9, 2026; English descriptions here are paraphrases of the Japanese text.
[^4]: The Pokémon Company, [Intense Four-Player Link Battles in the Z-A Battle Club](https://legends.pokemon.com/en-gb/news/z-a-battle-club), August 17, 2025; accessed September 9, 2026.
[^5]: Solarus, [Custom States](https://docs.solarus-games.org/lua-api/custom-states/), official API documentation, accessed September 9, 2026. API capability is not multiplayer scale evidence.

Additional primary-source studies: RESEARCH-OSRS-DIABLO.md and RESEARCH-PARTY-AND-PRESENTATION.md. The implementation and proposed raid contract are tracked separately in FEATURE-PROGRESS.md and SHARED-RAID-VISION.md.
