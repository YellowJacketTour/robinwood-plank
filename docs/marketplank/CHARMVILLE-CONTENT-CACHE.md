# Charmville content cache

The board renderer pins an immutable content revision. Asset definitions contain presentation and stable identity; authoritative yard snapshots and accepted server receipts still determine ownership, crops, quantities, harvests and stamps. No renderer can set a balance by changing this cache.

## Build and consume

Run `node scripts/charmville/pack-cache.mjs` from the repository root. It validates atlas dimensions, hashes each artifact with SHA-256, writes definitions and a revision manifest, updates `public/images/charmville/cache/cache.idx`, and generates `lib/charmville/content-manifest.json` for the bundled renderer. `index.json` mirrors the index for consumers expecting a JSON extension. The index format is JSON in schema 1, not a proprietary binary format.

```ts
import {
  charmvilleAssetUrl,
  charmvilleAssetFromSource,
  CHARMVILLE_CONTENT_REVISION,
  CHARMVILLE_DEFINITIONS_URL,
} from '@/lib/charmville/content';

const ripe = charmvilleAssetUrl('crop:stalk:ripe');
const walking = charmvilleAssetUrl('character:walk:0');
const legacySceneSource = charmvilleAssetFromSource('/images/charmville/original/soil.png');
```

The stable-ID helper is type checked. The source helper supports gradual scene migration and leaves unknown assets unchanged. A running bundled client does not fetch `latest` and accidentally combine a new definition with an older atlas. New standalone clients read the index, choose a supported revision, verify its manifest hash, and then load only that revision's definition and asset URLs. Load the next complete revision before swapping a live scene.

The pack is additive: historical manifests, definitions and hash-named assets remain on disk. `supported` lists the most recent two distinct revisions, while `revisions` retains the complete publication history. Initial publication has one supported revision. Deployment must preserve those historical files. Run the packer before the application build, copy all cache artifacts before activating the new application, and publish the index last if deploying assets separately.

## Current content and limits

Initial revision `7ccdd680fdaa6bec1143b86eb353bb25035da42d3f681bbb918efca93d46eee2` contains 62 assets, 2,573,972 image bytes. Definitions identify seven charm faces, Stalk/Splinter crop stages, directional idle/walk/pickup atlases, starter map cells, geometry/anchors and current authoring scripts. The original editable `.blend` files and credit manifests remain in their established source directories; runtime downloads image bytes rather than authoring files.

Workshop revision `8e21ff26b25e5d7d739df04f91a653dda2ee0fd128122e07ef65f6e903b80b78` adds 9 PNGs and 4 self-contained GLBs: seed cottage, orchard tree, blossom tree, flower border and clover turf. Total runtime assets: 75, 9,156,552 bytes. Both this revision and the initial revision remain supported. Images have `image/png` MIME plus pixel dimensions; models have `model/gltf-binary` MIME and no fabricated image dimensions. Packing checks GLB headers, declared lengths, glTF version and absence of external buffer/image dependencies, plus workshop manifest hashes.

Stable IDs include `workshop:cottage:image`, `workshop:cottage:image3x`, `workshop:cottage:model` and `workshop:turf:image`. `charmvilleAssetFromSource` also resolves their original workshop URLs. Workshop definitions preserve logical frame size, ground anchor and seamless-turf metadata. High-density images have triple pixel dimensions but retain the same logical frame and anchor.

Five editable Blender sources are separately content addressed under `cache/sources/` and referenced through `definitions.authoring.sources`. They are not runtime assets or eagerly downloaded. Each descriptor records hash, bytes, original URL, author, original-project license statement, Blender version and generation script. This preserves the exact editable source of a retained revision even when a workshop source filename is rebuilt. The original workshop README describes GLB materials as a base-color/roughness approximation; procedural microrelief still requires baking for close-up realtime rendering.

This is the foundation for multiple clients, not a claim that a tick protocol or cross-client handshake has shipped. Land-value calculation remains explicitly unimplemented. A future schema can add `lod`, wardrobe attachment, layered SVG charm, sound and animation references using the same content-addressed descriptors. Preserve face/plot/entity IDs. Introduce a protocol capability check separately before the server accepts actions requiring new definitions. Never embed private state or tune financial rules in a renderer/content change.

`npx tsx --test test/market/charmville-content-cache.test.ts` verifies all published manifest, definition and image hashes/byte lengths, retained revisions, definition references and stable source resolution.
