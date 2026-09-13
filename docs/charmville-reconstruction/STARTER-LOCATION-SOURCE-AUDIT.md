# Starter location source audit

Read-only native enumeration of the existing Hero-of-Dreams-derived homestead template: **512 DMap slots, 256 named DMaps, 62 maps containing 6,698 authored/nonempty screens**. The original template SHA256 remained unchanged. Audit script and runner are `scripts/charmville/dmap-source-audit.zs` and `dmap-source-audit.mjs`; only a copied quest/runtime in `work/dmap-source-audit` was modified. No live quest, region, spawn or account state was changed.

[Complete metadata](source-evidence/dmap-template-inventory.json) · [12 screenshot candidates](source-evidence/starter-map-candidates.json)

## Practical first choice

Palm Island is DMap2, map1, continue screen75 (hex4B), palette0, MIDI4. The source manual describes it as home with houses, sandy beaches, a garden and training. This makes it a stronger opening-location candidate than Autumn Town. This is a design inference pending screenshots and native traversal; palette IDs do not measure brightness.

The original Palm entry has two authored enemy slots, not a proven combat-free tutorial. Screens69/85 are open candidates with zero authored enemy slots. Native NPCs/training actors can also occupy enemy slots. Link's House is DMap26, map11, screen112; TreeTop Village is DMap207, map16, screen86. These should be reviewed as a coherent home/exterior/public-village progression, not spliced blindly.

## Candidate capture table

| DMap | Screen decimal (hex) | Name | Map | Palette | MIDI | Authored enemies |
|---:|---:|---|---:|---:|---:|---:|
| 2 | 75 (4B) | Palm Island - 4B | 1 | 0 | 4 | 2 |
| 2 | 74 (4A) | Palm Island - 4A | 1 | 0 | 4 | 3 |
| 2 | 76 (4C) | Palm Island - 4C | 1 | 0 | 4 | 3 |
| 2 | 59 (3B) | Palm Island - 3B | 1 | 0 | 4 | 1 |
| 2 | 91 (5B) | Palm Island - 5B | 1 | 0 | 4 | 2 |
| 2 | 69 (45) | Palm Island - 45 | 1 | 0 | 4 | 0 |
| 2 | 85 (55) | Palm Island - 55 | 1 | 0 | 4 | 0 |
| 26 | 112 (70) | Link's House - 70 | 11 | 12 | 17 | 0 |
| 207 | 86 (56) | TreeTop Village - 56 | 16 | 0 | 37 | 0 |
| 3 | 106 (6A) | Hyrule Field - 6A | 7 | 0 | 12 | 0 |
| 73 | 112 (70) | Slash House - 70 | 16 | 29 | 24 | 6 |
| 8 | 116 (74) | Ruto's House - 74 | 11 | 12 | 39 | 5 |

## Named overworld DMaps

| DMap | Name | Map | Continue | Palette | MIDI |
|---:|---|---:|---:|---:|---:|
| 1 | Mt. Frost | 2 | 37 | 18 | 6 |
| 2 | Palm Island | 1 | 75 | 0 | 4 |
| 3 | Hyrule Field | 7 | 106 | 0 | 12 |
| 4 | Autumn Town | 10 | 63 | 38 | 19 |
| 5 | Moblin Forest | 16 | 80 | 0 | 10 |
| 6 | Golden Swamp | 16 | 32 | 19 | 53 |
| 31 | Death Mountain | 2 | 110 | 41 | 44 |
| 32 | Windy Peak | 2 | 43 | 37 | 45 |
| 34 | Canyon | 25 | 124 | 0 | 36 |
| 35 | Cerbat Desert | 25 | 55 | 0 | 36 |
| 36 | Graveyard | 10 | 87 | 40 | 21 |
| 39 | HyruleCastle:Outside | 42 | 115 | 0 | 41 |
| 117 | Hyrule Field dawn | 7 | 63 | 15 | 12 |
| 207 | TreeTop Village | 16 | 86 | 0 | 37 |
| 208 | Lost Woods | 16 | 87 | 0 | 38 |
| 211 | Season Isle: overwor | 42 | 63 | 36 | 43 |

## Limits and next checks

- This inventories the existing template; do not assume byte-identical metadata to untouched HeroOfDreams until compared. Screenshot reviewer targets the untouched source, so its visuals provide an independent comparison.
- DMap palette and per-screen palette are both retained. The native renderer resolves the actual visible palette; metadata alone cannot choose art direction.
- MIDI IDs and enhanced-music paths are catalogued; MIDI IDs are not track titles or proof that a music asset is licensed for redistribution.
- Authored solidity/empty-enemy counts are selection hints, not collision, accessibility or safety proofs. Check four directional entrances, house return warps, shore/water boundaries, NPC interactions and stable starter spawn before cutover.
- Keep homestead ownership and visit permissions separate from source map identity. A welcoming exterior/interior can be a shared-world address with a private account interior without changing source lore or silently sharing personal inventory.
