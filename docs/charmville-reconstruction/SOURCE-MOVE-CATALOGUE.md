# Source move catalogue

The pinned pokeemerald revision `5eff78649e7170a877b961ef0b3da13b81a16038` supplies 354 move definitions through `include/constants/moves.h` and `src/data/battle_moves.h`. The reproducible extractor retains file hashes, IDs, power, accuracy, PP, secondary-effect chance, priority, type, target and effect/flag symbols.

`lib/charmville/move-stats.ts` exposes this metadata without claiming those effects are executable. A move may enter the playable ruleset only when its accuracy, damage category, PP consumption, target rules, effect, interruption and animation timing are implemented and verified. Unknown effects must never silently become ordinary damage. Emerald's generation-specific physical/special rules must not be replaced with later-generation move categories by accident.

This catalogue complements the 386-species statistics catalogue. It is research and implementation input, not proof of battle completion. Shared encounter authority, full combat calculations, status mechanics and species-specific move presentation remain separate checklist gates.
