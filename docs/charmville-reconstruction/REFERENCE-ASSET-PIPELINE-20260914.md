# Source artwork inventory and native item palettes

Research snapshot: September 14, 2026. Source presence is distinct from release permission and implemented gameplay.

## Pinned inventories

The machine-readable source-evidence/fan-asset-repository-inventory.json records revisions, document hashes and repository-tree counts. Counts are paths, not unique items or complete movesets.

| Repository | Revision | PNG paths | Item PNG paths | Coverage |
|---|---|---:|---:|---|
| pret/pokeemerald | 5eff78649e7170a877b961ef0b3da13b81a16038 | 4076 | 218 | Complete tree |
| rh-hideout/pokeemerald-expansion | 083b15cd6db8cade17c3f83f20807b3c8af6ad0d | 11339 | 619 | Complete tree |
| PMDCollab/SpriteCollab | 64606f173f540d93fa67fa63671a56555268c958 | 69063 | 0 | Truncated: lower bounds |
| TeamAquasHideout/Team-Aquas-Asset-Repo | d1b3b396175548f93128ca2e88f32e3188c8e453 | 7380 | 327 | Complete tree |

[Emerald](https://github.com/pret/pokeemerald) is a decompilation. No blanket artwork grant was identified. [Expansion](https://github.com/rh-hideout/pokeemerald-expansion) is a ROM-hack base with substantial contributor credits; those credits are not a blanket asset license. Its changed follower paths and icon structures require a version-specific importer.

[SpriteCollab](https://github.com/PMDCollab/SpriteCollab) supplies animation XML, offset and shadow sheets; the [license](https://github.com/PMDCollab/SpriteCollab/blob/master/LICENSE.md) is CC BY-NC 4.0 and applies only to rights contributors possess. It mixes fan and official material. A Walk or Attack sheet does not implement battle effects. [Team Aqua](https://github.com/TeamAquasHideout/Team-Aquas-Asset-Repo) organizes community assets; retain per-file credits and review terms before release.

[Solarus resource packs](https://docs.solarus-games.org/resources/resource-packs/) explicitly distinguish original free packs from Nintendo-derived Zelda packs. Prefer original Trillium/free packs for a release-compatible expansion. Engine licensing does not license game artwork: see the [Solarus FAQ](https://www.solarus-games.org/about/faq/).

## Implemented local pipeline

The index verifies every preserved SHA and byte count before producing content IDs. 435 source items remain separate from 510 content assets, 216 images and 303 presentations. Palette identity participates in presentation identity. No custody or gameplay ID is minted.

Run `node scripts/charmville/build-reference-asset-index.mjs`, then `node scripts/charmville/build-reference-palettes.mjs`. The latter verifies PNG CRCs and changes only PLTE. Source pixel indices, IDAT, transparency, dimensions and originals remain untouched. 319 item presentations now use declared native palettes; shared status-heal source art therefore displays the correct item colors. Generated files live in reference-items/derived and remain reference-only.

Run `node scripts/charmville/build-reference-descriptions.mjs` with the pinned local Emerald checkout. 377 source descriptions include a source-file SHA, symbol and line. Display as Original game effect; do not imply the effect has been implemented.

Acceptance: palette test verifies CRC validation, different native colors, identical non-PLTE chunks and rejection of invalid RGB data. Content index test verifies content dedup while retaining distinct palette/item identities and rejects modified artifacts.

## Remaining coverage

Inventory icons require separate held, thrown, pickup, terrain, crafting and animation definitions. Each gameplay binding needs anchors, timing, collision/hit timing, source rights and visual review. Three existing PMD starter catalogs contain 107 animation labels / 102 physical sequences, not universal move coverage. National species identifiers and Emerald internal IDs require explicit mapping. No new remote artwork was copied by this research inventory.
