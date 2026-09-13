# Charmville: real model and memetic asset sources

Checked 2026-09-09. This is a concrete acquisition shortlist, with inspected file evidence where available. A downloadable meme or avatar is not automatically licensed for redistribution inside a commercial browser game. Preserve the exact source license with each acquired file. No purchases or account connections were made for this research.

## Ready source families

| Source | Actual formats and scope | Evidence and use |
| --- | --- | --- |
| [Quaternius Ultimate Animated Character Pack](https://quaternius.com/packs/ultimatedanimatedcharacter.html) | 52 characters; FBX, OBJ, `.blend`; animated | Creator publishes CC0 and commercial use. Already acquired locally in `charmville-references/quaternius-characters`. Immediate editable base for settlers, workers and feminine/masculine villagers; the current farmer is adapted from this family. Keep improving proportions/materials rather than mistaking an unedited pack for finished art. |
| [Quaternius Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html) | Male/female bases in regular, teen and superhero proportions; hairstyle options; FBX/glTF. Rigged `.blend` belongs to the Source tier | Creator publishes CC0. Free Standard includes a subset, and Source includes all models and Blender files. Do not claim the complete editable kit is free. Useful compatible wardrobe rig foundation after choosing the actual free subset. |
| [Quaternius Modular Character Outfits — Fantasy](https://quaternius.com/packs/modularcharacteroutfitsfantasy.html) | Modular clothing, FBX/glTF free subset; `.blend` in Source tier | Creator publishes CC0; full pack is 12 outfits from 62 parts, with color variants. Appropriate for primitive/settler/fantasy progression. Confirm which pieces are present in the free archive. |
| [Quaternius Animated Alien Pack](https://quaternius.com/packs/animatedalien.html) | Two models; FBX, OBJ, `.blend`; animated | Creator publishes CC0 and personal/commercial use. A small, concrete source for original cute extraterrestrial variations. |
| [Quaternius Modular Sci-Fi Megakit](https://quaternius.com/packs/modularscifimegakit.html) | Modular science-fiction environment, creator lists FBX/OBJ/Blend formats | Source candidate for colonies; inspect actual Standard/Source tier archive before recording included models or formats. Do not substitute this pack's untouched visual language for Charmville art direction. |
| [Kenney Space Kit](https://kenney.nl/assets/space-kit) | Creator lists 150 3D assets; [official itch download](https://kenney-assets.itch.io/space-kit/purchase) lists a 6.3 MB ZIP | CC0 on creator page; free download. Suitable for colony blockouts and repaintable toy spacecraft. Formats inside ZIP have not been inspected in this pass. |

## Milady, Remilia and real VRM evidence

[Milady Maker](https://miladymaker.net/) explicitly describes its neochibi fashion direction and releases its branding/assets under the [Viral Public License](https://viralpubliclicense.org/). Fashion coherence, expressive face layers, and collectible self-presentation are useful direct reference points. The VPL requires keeping its full license through combinations/derivatives and applying no further restrictions; it should not be silently recorded as CC0.

[Milady Tracker](https://github.com/wables411/milady-tracker) supplies real VRM files and identifies Pockit models from `prnth.com/Pockit`. It credits Sp00bs for AlienMilady and links [moviemaker](https://github.com/prnthh/moviemaker) for the Pockit pipeline. The tracker repository states VPL. The moviemaker top-level page does not itself expose a LICENSE file; the attempted `/blob/main/LICENSE` returned 404. That absence must not be filled in from another repository's claims.

The [actual AlienMilady.vrm](https://github.com/wables411/milady-tracker/blob/main/AlienMilady.vrm) was downloaded for local inspection, outside the public application, to `charmville-references/research-2026-09-09/models/AlienMilady.vrm`. It is a 3,466,856-byte glTF 2 container exported through a Blender VRM exporter, with 11 meshes, 11 skins and no embedded animation clips. SHA-256: `c162e1c8b0820314f9f5f566bd07eebbf57c70a4c950875e3fb67db21f132a57`.

**The embedded permissions conflict with the repository-level description:** the file identifies title `Milady Clawb`, author `wable`, `allowedUserName: OnlyAuthor`, `commercialUssageName: Disallow`, and `licenseName: Redistribution_Prohibited`. Retain as reference until the asset creator clarifies the specific file's permission. It has not been put into the game cache. A README credit alone is not evidence that embedded restrictions can be discarded.

## Bobo, Pepe, Mog, Wojak and plush references

| Candidate | Concrete evidence | Acquisition decision |
| --- | --- | --- |
| [Bobo Media Kit](https://www.bobothebear.io/mediakit.html) | Downloadable transparent PNG reactions, rendered turnarounds, and [textured GLB](https://www.bobothebear.io/assets/models/bobo-3d.glb). The page permits community remixes and transformative work; disallows raw-file resale/repackaging and misleading affiliation. | Acquired GLB into local references only. It is 1,656,164 bytes, one mesh, no skin and no animations; it needs rigging before locomotion. SHA-256 `2b19c869afea0c40fe1b382c62a678f6869a8190d83c93133a9229eb040a66cc`. Commercial-game redistribution scope is not explicit in the summary, so do not mark CC0. |
| Pepe / farmer Pepe | [Creator's publisher](https://blog.fantagraphics.com/truthaboutpepe/) identifies Matt Furie and the work; [his representatives](https://www.wilmerhale.com/insights/news/20190610-pepe-the-frogs-creator-obtains-monetary-settlement-from-infowars) document copyright enforcement. | No verified general commercial asset license or Blender model located in this pass. Meme popularity is not a license. An original frog farmer can fill the gameplay role while specific art permissions are established. |
| Mog / Joycat | [Project page](https://mogcoin.xyz/) exposes logo and character images but displays an all-rights-reserved notice. | Useful style/reference source; no verified freely redistributable rig/model or broad license located. Do not infer rights from a token listing. |
| Farmer Wojak | Search did not produce a creator-origin, commercially reusable rigged model or SVG pack with reliable chain of permission. | Open lead, not an acquired or cleared asset. Original farmer reaction faces are a practical parallel authoring track. |
| [Cubey Cirno Fumo free base](https://booth.pm/en/items/3496184) | Real `.blend`, PSD and Unity package; 24.9 MB ZIP. Listing explicitly says noncommercial and prohibits NFT use. | Strong plush proportion reference; unsuitable for this commercial/trading product as licensed. Not downloaded. |
| [Luggy customizable fumo](https://booth.pm/en/items/8746155) | Free-download listing, 17.9 MB ZIP; edits allowed, redistribution prohibited. | Not a reusable game asset grant. Not downloaded. |

## How the asset search continues productively

For each next art task, search for the actual required body/rig/garment/prop first, examine the creator's page and archive terms, and take the smallest useful subset. Record source URL, creator, license, acquisition date, file hash, original format, actual rig/clips and import result. Preserve original bytes and place edited `.blend` plus reproducible export scripts beside them. Keep unresolved assets in references, never under the public web root.

Build a shared wardrobe attachment convention across feminine, masculine and androgynous silhouettes, with separate progression tags for homestead, settlement, town, industry, orbit and galactic travel. Recoloring all characters alone is insufficient: align head/body ratios, hand size, cloth silhouettes, outlines, eye readability, material roughness and light response. Each borrowed source must survive an in-scene front/back/side locomotion check at actual phone size before acceptance.

Real file inspections are reproducible with `node ../charmville-references/research-2026-09-09/models/inspect.mjs` from this repository; `inspection.json` records machine-read evidence. These models have been inspected structurally, not imported/rendered or integrated. The live cache remains the existing original and credited source artwork.
