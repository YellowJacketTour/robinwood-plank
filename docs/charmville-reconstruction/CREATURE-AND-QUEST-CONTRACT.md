# Continuous creature, quest and property contract

Binding intent captured from the user's actual source-quest playthrough, 2026-09-09. This is a required design contract, not a claim that the implementation exists.

## One creature across encounter modes

A creature instance needs a stable instance ID distinct from species and visual source IDs. Its authority includes owner/capture state, species/form/evolution, level/experience, HP/max HP, statuses with authoritative duration, location/region, encounter state, participants and revision. A follower is a mode of the same owned instance, not an independent visual duplicate.

Overworld Zelda-style damage and abilities alter that instance. A staged battle transition reserves the instance and participating players atomically, freezes or transfers the appropriate action authority, and projects existing HP/status into the encounter. Ending/escaping returns the surviving instance's HP/status and legal location; capture transfers ownership and consumes the capture item once; defeat grants rewards once. Evolution transforms the persistent instance and eligible stats/abilities with recorded lineage. Never respawn a fresh full-health copy merely to render a different battle view.

Rules requiring deliberate implementation: HP/stat scale conversion, action-combat vs turn-based status timers, who can join or interrupt a staged encounter, what observers see in the shared world, follower collision/leashing/recall, disconnected players, defeated participants, region crossing, contested capture and item reservations. Define and test these before enabling valuable rewards. Preserve normalized damage progress only if the selected combat model truly needs different HP scales; preferably share one canonical HP scale.

Transition requests need idempotency keys and expected state revisions. Two clients cannot capture/harvest/defeat the same creature for duplicate reward. Server time owns status expiry. The world stays live for other players while an encounter runs. A staged encounter cannot arbitrarily pause the whole MMO.

## Quest and authored event reuse

Retain source dialogue/window pacing, conditional branches, quest flags, portals, actor choreography, spawn effects, item requirements/rewards, authored scene transitions and narrative progression. Source scripts become versioned quest definitions or adapters with explicit side-effect boundaries. Presentation events may run on the client; durable rewards/flags/ownership changes require server validation and receipts.

A quest definition must distinguish player-local progress, party progress and world/civic progress. A completed local cutscene should not remove another player's NPC or repeat a world reward. Script checkpoints must permit reconnect and retries without replaying irreversible effects. Replacing an authored engine with a homegrown text box is not fidelity.

## Properties, regions and progression

Private properties have stable IDs, owner/access roles, a world-map connection, entry/exit points, crop/structure state and durable permissions. Public wild regions, towns, iconic regions and industrial areas share the same traversal/state model. Portals transfer the player's satchel, equipment, active quest state and permitted companions without duplicate instances.

RuneScape-style skill practice, evolved gear/abilities, Zelda tools and magic, creature evolution and civic industry feed one explicit crafting/resource graph. Reaction charms remain part of the same identity system while expression and scarce inventory/issuance have separately defined rules. Economic settlement and ownership cannot be inferred from which sprite is visible.

## Acceptance examples

1. Damage a creature to 60% HP and apply a status in live action. Enter a staged encounter: the same instance, damage and unexpired status are present. Escape: no healing reset or duplicated reward.
2. Two players attempt capture simultaneously: one legal capture/consumption result, no duplicated creature or satchel entry.
3. Capture, summon as follower, cross a property/world portal and reconnect: identity and ownership remain correct, with one follower instance.
4. Complete an authored reward scene, disconnect during its final window and reconnect: reward/quest flag applied exactly once; presentation resumes coherently.
5. Farm/craft on private property, carry output to industry/exchange, use a permitted social charm action: lineage, costs, ownership and transaction receipts remain consistent.

None of these acceptance examples was passed merely by launching the source quest. Implement and record evidence before promoting their status.
