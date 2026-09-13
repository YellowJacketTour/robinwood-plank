# Multiplayer interaction contract

Applies to every Charmville feature, not only combat. Each implementation must state its behavior for solo players, allied players, competing groups, PvE and PvP. A shared screen does not imply shared authority or ownership. These are design requirements; only explicitly verified rows are playable.

| System | Solo | Allied party | Competing party | PvE | PvP |
|---|---|---|---|---|---|
| Capture | Controller spends own ball and receives one creature | Assistance does not transfer capture permission; future group distribution must be agreed before encounter | Current controller claim excludes competing throws; no duplicate ownership | Same HP, statuses and odds in both camera modes | Disabled; owned creatures cannot be captured from another player |
| Damage and statuses | Validated actor and move costs | Explicit consent and contribution attribution; shared boss HP | Zone encounter policy determines contest, never client order | Server settles damage once | Requires an explicit enabled zone/mode, team rules and friendly-fire policy |
| Healing and buffs | Owned consumables and cooldowns | Target permission, range and effect stacking rules | Cannot involuntarily alter opponents outside enabled combat | No duplication on replay | Balance and dispel rules must be declared separately |
| Farming and gathering | Owner receives conserved yield | Separate tend, harvest and storage permissions | No implicit theft through presence | Resource depletion and regeneration authoritative | Raiding disabled unless a future mode explicitly permits it |
| Construction | Materials debited once | Contributor ledger and build permissions | No unauthorized edits or demolition | Collision changes must retain safe traversal | Siege/destruction requires opt-in rules and recovery design |
| Trading | Confirmed inventory escrow | Shared vault roles distinct from personal holdings | Same order execution and anti-duplication rules | Gameplay supply independent of camera or party size | Death/loot cannot bypass settlement or protection rules |
| Travel and instances | Stable identity across regions | Consent before moving others; party routing keeps membership | Admission and capacity enforced per group | Private-home grants and revocation persist | No attack authority inherited across a protected border |
| Social and voice | Explicit post/record actions | Channel membership and proximity permissions | Block/mute/report respected | World events do not auto-post as player | Competitive mode does not waive privacy controls |

## Required authority envelope

Every action validates actor identity, instance, location, target lifecycle, zone policy, ownership or grant, party role, revision, costs and replay key. Party membership alone is not a permission to spend another player's inventory. Party changes, disconnection, expired invitations, travel and revoked home access must invalidate future authority without duplicating already committed results.

Rewards require an explicit distribution policy: personal, shared escrow, agreed allocation or contested objective. Multiple cameras must refer to one target UUID and one outcome. No copied encounter per viewer. Visual effects may be locally predicted only when cancellation is possible; ownership, damage and scarce output require a committed receipt.

## Current capture scope

One controller owns the attempt; helper consent permits one combat move only. Capture spends the controller's finite local-test supply. Successful capture transfers the wild UUID to that controller's storage, including when six party slots are full. A failure does not refund a consumed ball. Full PvP, competing-party objectives, group catch allocation and raid reward rules are not implemented.

## Review gates for each feature

Test owner and stranger; ally and non-ally; simultaneous requests; retries after a lost response; revoked permission; expired controller lease; region transition; disconnect; protected-zone rejection; and full inventory/party capacity where applicable. Then verify the same committed outcome in each supported view, with comprehensible controls and no misleading success animation.