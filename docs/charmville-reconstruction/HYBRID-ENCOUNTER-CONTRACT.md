# Proposed hybrid encounter contract

`scripts/charmville/encounter-state.mjs` is an engine-neutral, server-only model. It is not connected to the native quest, authenticated account ledger, a Pokémon battle engine, or the live inventory. Its tests establish invariants for a future adapter, not playable encounters.

A world creature keeps one entity ID, HP, and status collection across real-time and turn presentation. A single controller claim prevents competing encounter control. Capture consumes one ball for each accepted unique attempt, uses one supplied server decision, and produces a specimen retaining that identity and health. Defeated creatures cannot be captured. Replaying a request cannot reroll it or spend again.

The authoritative caller must calculate eligible damage and capture probability, generate a server random value, validate distance and action timing, authenticate the actor, and atomically persist this state with inventory and the durable request ledger. It must serialize competing revisions across workers. The module does not implement these infrastructure responsibilities. Status duration ticking, flee/claim timeout, PvP ownership, battle turns, species abilities, animations, and economic recipes remain future work.

Source reference: the collected `charmville-references/pokeemerald/src/battle_script_commands.c`, `Cmd_handleballthrow` (near line 9905), computes capture odds using species catch rate, ball multiplier, current/max HP, and status modifiers. See [pret's source](https://github.com/pret/pokeemerald/blob/master/src/battle_script_commands.c). The collected `src/pokemon.c` contains the Pokémon data access implementation, and `src/battle_main.c` the battle lifecycle. These are research references; no code from them was copied into this model.

The hybrid transition and single probability draw are Charmville design proposals, not a claim to reproduce Emerald's shake algorithm. A future species-aware formula must be explicitly specified and tested against intended gameplay. The supplied probability is deliberately separate from client request fields.
