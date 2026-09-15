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

## Extended source comparison

Nine additional repositories are pinned in the same inventory with observation times. GitHub root README/license/attribution documents have content hashes and immutable URLs. GitLab entries pin HEAD and cite the official pack registry; their per-file license audit remains pending. No ROM was obtained or extracted.

| Source | Actual availability / integration lesson | Release stage |
|---|---|---|
| [Majora's Mask](https://github.com/zeldaret/mm) | WIP decompilation; README explicitly excludes required assets and requires a prior game copy. Study actor/state and scene structures, not an asset download pack. | Research only |
| [Minish Cap](https://github.com/zeldaret/tmc) | Decompilation; README likewise excludes required assets. | Research only |
| [Shipwright](https://github.com/HarbourMasters/Shipwright) | Native port built on libultraship; requires a supported user ROM and extracts assets into o2r archives. Custom archives separate presentation from engine. | Architecture reference; not an art grant |
| [FireRed](https://github.com/pret/pokefirered) | Decompilation targeting original ROMs. Useful sibling item/menu format comparison. | Source inspection; per-file art review pending |
| [Crystal](https://github.com/pret/pokecrystal) | Disassembly targeting original ROMs; not an Emerald schema. | Source inspection; separate format adapter needed |
| [Red/Blue](https://github.com/pret/pokered) | Disassembly targeting original ROMs. | Source inspection; separate format adapter needed |
| [Tuxemon](https://github.com/Tuxemon/Tuxemon) | Original creature RPG with JSON data, Tiled maps, input support and documented art attributions. Code GPLv3; asset terms are recorded separately in ATTRIBUTIONS.md, including CC BY-SA. | Strong original-art candidate; per-file obligations and animation completeness audit pending |
| [Trillium](https://gitlab.com/maxmraz/trillium/) | Solarus pack; official registry identifies MIT/CC-BY. Existing local revision matches remote pin. | Prefer for original world expansion after file attribution review |
| [MIT Starter](https://gitlab.com/Splyth/solarus-mit-starter-quest) | Solarus starter; registry identifies MIT/CC-BY/CC0. | Prefer for portable original interface/world foundations after review |

These are not interchangeable renderers. Keep adapters at import time: decode native indices and palettes, resolve source identifiers, preserve direction/timing/anchor metadata, then bind the reviewed presentation to a separate Charmville gameplay identity. A source repository changing its engine, archive or animation format must not mutate economic custody or gameplay rules.

Priority: finish the already-preserved Emerald item palette/description bindings; curate original Trillium/Tuxemon assets with attribution and complete animation contracts; use ROM-dependent Zelda projects as documented structural research rather than promising direct artwork availability. Every inventory entry remains shippingApproved=false until its specific review is complete.
