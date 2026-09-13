# Victory experience subset

Implemented source arithmetic uses pret/pokeemerald commit `5eff78649e7170a877b961ef0b3da13b81a16038`. Reproduce mappings with `node scripts/charmville/extract-species-growth.mjs <reference-root>`. `species-growth.json` records SHA256 hashes and all 386 internal species ID mappings.

Primary source: [experience_tables.h](https://github.com/pret/pokeemerald/blob/5eff78649e7170a877b961ef0b3da13b81a16038/src/data/pokemon/experience_tables.h) supplies six curves through level100. Nested divisions in Erratic and Fluctuating truncate before multiplication, matching C integer arithmetic. Level1 explicitly has one experience point in each source table.

[Cmd_getexp in battle_script_commands.c](https://github.com/pret/pokeemerald/blob/5eff78649e7170a877b961ef0b3da13b81a16038/src/battle_script_commands.c) supplies base wild yield `expYield * defeatedLevel / 7`. The implemented award uses this base for the controller's finishing companion only. It does not implement participant redistribution, Exp Share, traded-creature bonuses, held-item bonuses, trainer multipliers, EV awards, evolution or move learning.

An assisted finishing strike records `party-allocation-pending` with zero XP rather than assigning another account's entitlement. A controller finishing strike can follow earlier assistance; its receipt therefore says `controller-finishing-strike`, never claims source-authentic solo allocation. This temporary allocation rule is authored Charmville policy.

Migration125 records one defeat award per encounter and durable creature XP. Capture does not award defeat XP. Initial XP equals the existing creature level threshold; no level/IV reroll. On level increase, maxHP follows the existing source formula while currentHP preserves its deficit; zeroHP remains zero. Level100 caps experience. The same transaction settles HP, award and battle receipt; retries cannot award again. Current single-wild lifecycle does not respawn defeated enemies.
