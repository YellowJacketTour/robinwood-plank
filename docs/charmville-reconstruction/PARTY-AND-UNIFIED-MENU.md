# Party, tools and the unified menu

The party is account state, not a second emulator save. The current party contains the one starter already owned by the profile. Six belt positions show the intended party capacity; five empty positions do not grant additional creatures. The API preserves each companion UUID and source species ID. Battle levels, HP, moves, capture and evolution are not invented by the menu.

Migration 111 adds an absolute following preference and revision. Turning following on or off requires the owned companion ID and a valid revision. Repeating a completed request is harmless; a stale conflicting request cannot undo a newer choice. Choosing the same starter again does not erase its following preference.

The account shell sends the native frame only an allowlisted species ID or zero, never its bearer token. This is a local visual projection, not a grant of creature ownership, XP or items. Account changes clear that projection. Durable party ownership is not evidence of authenticated multiplayer movement or a combat simulation.

## One menu, different views of the same state

Enter opens the game menu. Party leads to the account roster; Gear retains access to the existing native equipment screen; Inventory reads account supplies and the Charm Satchel; Charmdex discovers definitions; Exchange operates on saved stacks and Grain; Friends controls account region access. Native gear is still a reference subsystem and must not be presented as durable account equipment until its commands are connected.

The next systems must use the same action boundary rather than separate title-specific saves:

| Player intent | Equipment and target | Visible sequence | Authoritative outcome needed |
|---|---|---|---|
| Build or repair | Hammer, owned blueprint, permitted structure site | Face site, raise tool, strike, construction-stage change | Reserve materials, commit site revision, consume once, award construction XP |
| Fell a tree | Axe, harvestable tree | Windup, directional contact, chips, depletion/fall | Validate reach and tree revision, award timber once, update shared tree |
| Mine | Pickaxe, ore seam | Repeated strikes, impact, depleted seam | Skill/tool gate, vein budget, ore and XP receipt |
| Fish | Rod, permitted water edge and bait | Cast, line/bobber, wait/bite, reel, catch reveal | Server catch timing and roll, consume bait once, create owned catch |
| Grow | Hoe, seed, water, fertilizer, garden cell | Preparation, sow, water, staged growth, harvest | Region permission, moisture and cycle revisions, bounded yield |
| Travel with a companion | Owned party member and follow selection | Directional walking along the player's route, warp reset | Saved selection; later shared server movement |
| Enter creature battle | Same companion and encounter IDs | World-to-battle transition preserving health/status | One encounter authority, no duplicate creature or reward |

Every action must carry target identity, equipment identity, actor identity and a command ID. The client may predict motion; contact animation alone cannot grant a reward. Skills are projections of committed activity receipts. The menu must display those same skill and item records, not maintain its own counters. Each action needs a compatible body pose, explicit tool attachment, contact timing, sound/effect origin, cancellation policy and four-direction visual verification.

Construction, felling, fishing and the connected skill system in this table are requirements, not features implemented by this checkpoint. The immediate implementation is party access, a saved follow choice and the local follower projection. Real shared creature movement, party expansion and hybrid combat remain subsequent integrations.

## Verified party checkpoint

All three starter selections passed the actual account-to-native follow/return test. The party preference survives reload and uses owned UUID/revision checks. Enter opens the unified menu and Gear opens the native equipment screen. The three-bed planting/watering/harvest regression passed after the indexed PNG correction. Follower sprites use separate credited walking sources; Emerald battle portraits remain in the party panel. Native followers are local visual entities, not replicated shared combat entities.
