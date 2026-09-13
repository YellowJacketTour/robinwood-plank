# Hometown, homestead and town justice

Research and proposed design, September 13, 2026. Not implemented or a claim of completed source-map conversion. Supersedes Palm Island as the preferred conceptual hometown: Kakariko is now the shared-town direction; the original Link house is a homestead reference, not a verified complete farm layout.

## Home and shared town

The original A Link to the Past house is a small home associated with Link and his uncle, not a prebuilt family farming simulator. Do not confuse it with the Hero of Dreams Palm Island house inspected previously. A literal copy has not been measured or tested here for a livestock pen, garden, pond and six companions. Treat its recognizable house and yard as the center of an expanded authored property. [House reference](https://zeldadungeon.net/wiki/Link%27s_House).

Proposed first property: a family interior; outdoor garden with visible tilled borders; small livestock shelter and fenced pasture; pond with an accessible fishing bank; workbench/cooking area; tool storage; an open companion gathering area; and one clear road to town. These are additions, not features claimed to exist in the source map. Keep farm paths wide enough that companions cannot trap the player. A small starting garden should expand through play, without forcing every tutorial into the same square of soil.

Proposed learning sequence: meet family, receive the Burning Heart seed, walk outside, prepare soil, plant, water, harvest, inspect satchel, care for an animal, fish, cook or craft, meet a companion, practice combat safely, visit town and exchange a surplus. Each lesson should finish an actual action and preserve its receipt. Returning players resume their checkpoint. Optional lessons remain available rather than blocking all travel.

Kakariko supplies the organizing idea of a walkable settlement with houses, shops and workshops. [Village reference](https://www.zeldadungeon.net/wiki/Kakariko_Village_%28A_Link_to_the_Past%29). Place the Grained Exchange and storage at the center, with a general shop, seeds/feed, healing/companion services, smith/workshop, noticeboard and social meeting space nearby. Place introductory wood, ore, fishing and gentle creature habitats at the outskirts. Supply basic resources here; advanced ores, rare creatures and valuable recipes need outward exploration. Basic availability is not unlimited issuance.

Every home needs a permanent account-specific address and explicit visitor permission. The public town is shared. The same house graphic cannot imply the same resource instance. Travel must preserve inventory, party, tutorial state and wanted jurisdiction while validating entry permission. No new instance layout or maximum population is certified by this proposal.

## A protected town with crime

Town protection and an outlaw system can coexist if crime does not let one person permanently erase another's progress. Ordinary interaction is the default. Theft and attacks on protected actors require deliberate selection, with clear target and consequence previews. Companion AI does not autonomously attack innocents. Deliberately ordering it to do so attributes the action to its owner.

Useful precedents differ. OSRS connects stall theft to witnesses/guards and temporary merchant refusal. [Thieving](https://oldschool.runescape.wiki/w/Thieving). ESO distinguishes escalating guard response states. [Official justice support](https://help.elderscrollsonline.com/app/answers/detail/a_id/27034/~/what-are-the-consequences-of-criminal-actions-in-eso%3F). Rockstar's Red Dead Redemption manual separates active pursuit and bounty consequences. [Official manual](https://media.rockstargames.com/rockstargames-newsite/img/manuals/en_us/RDR_PS3_ESSENTIALS_MANUAL_ENG.pdf). Ultima Online demonstrates that crime attribution can include an aggressor who did not deliver the final blow. [Official murder system](https://uo.com/wiki/ultima-online-wiki/player/the-murder-system/). These are design references, not one identical system to copy.

Proposed escalation, to be balanced through play:

| Level | Trigger class | Response |
|---|---|---|
| 0 | Lawful activity | Normal town services |
| 1 | Reported petty theft | Shop alarm, local investigation, surrender/restitution option |
| 2 | Repeated theft or deliberate assault | Patrol pursuit and nearby reinforcement |
| 3 | Fighting guards or substantial property harm | Shield formations, ranged support, route interception |
| 4 | Sustained violent resistance | Specialist squads, tracking companions, coordinated containment |
| 5 | Major sustained rampage | Regional commander and bounded elite response; relocation toward a pursuit perimeter |

Severity, outstanding restitution and immediate pursuit are separate state. Loss of sight moves guards to the last-known position and search routes, not omniscient pursuit through walls. Hiding may end immediate pursuit without erasing a debt. Arrest, voluntary surrender and restitution provide understandable recovery. Fine defaults cannot trap a beginner: protected tools and tutorial grants remain available, with nonblocking service work as an alternative. Do not punish a whole party merely for proximity; deliberate assistance needs attributable evidence.

The server records incident ID, actor and controlled-creature IDs, target, location/jurisdiction, action tick, witness evidence, severity, restitution and resolution. Clients send actions, never self-issued crimes or wanted levels. Damage and reports deduplicate across retries. Escalation cannot be farmed by repeated replay of one incident. Guard dispatch has regional population and CPU budgets; hundreds of simultaneous offenders cannot each summon unbounded squads.

Essential merchants remain usable for bystanders, and safe-zone player-versus-player harm is not silently enabled by a wanted status. Competitive outlaw/bounty areas need separate explicit rules. Homes cannot be invaded through the justice system. Disconnecting does not clear recorded incidents; immediate pursuit recovery needs a fair reconnect rule. Shops may visibly react to an offender without closing services for every newcomer.

## Economy and custody

Theft initially targets finite NPC theft stock, not player exchange escrow or visitors' satchels. A stolen unit remains one unit with provenance and a stolen flag. It cannot be listed as clean stock in the Grained Exchange. Restitution or a bounded laundering process changes its status, never duplicates it. Fences have limited demand and costs; guard loot cannot become an infinite resource faucet. Confiscation records a transfer or sink. Cosmetic purchases, family seed grants and tutorial items are excluded from punitive deletion. Crime is a voluntary progression branch, not the optimal compulsory beginner money route.

## Source assets and implementation reality

Source repositories do not supply unlimited mutually compatible assets. snesrev/zelda3 is a reverse-engineered implementation with an asset extraction process, not a ready drop-in ZQuest MMO module. [Repository](https://github.com/snesrev/zelda3). Emerald's decompilation is another distinct architecture. [Repository](https://github.com/pret/pokeemerald). Solarus explicitly separates engine/quest licensing and identifies packs with Nintendo material. [Resource packs](https://docs.solarus-games.org/resources/resource-packs/). Universal LPC offers a broad configurable character source, with asset-specific credit/license obligations. [Generator](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator).

Track provenance and permissions separately for code and artwork. Each imported actor needs frame dimensions, ground/grip anchors, directions, timing, transparency/palette, collision footprint and action coverage. A battle portrait does not automatically supply walking, fishing, mounted or directional attack frames. Missing animations must be authored and reviewed. Preserve source art now; gradual remastering remains deferred until playability and public play.

## Delivery gates

1. Inspect the actual Kakariko and Link-house source maps and validate a property layout; current fan-quest audits are not substitutes.
2. Publish a source-asset manifest and compatible import recipe.
3. Build one complete home-to-town tutorial with durable inventory and return travel.
4. Verify two-account visits and public resource contention without duplication.
5. Add one witnessed shop theft, incident receipt, guard response and surrender resolution end to end.
6. Expand escalation and companion attribution only after innocent bystanders remain protected.
7. Verify concurrent offenders, reconnect, region crossings, animation/collision alignment and input parity.

No wanted system or expanded homestead is marked complete by this document.
