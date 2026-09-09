# Community action and asset pack contract

This checkpoint implements a data contract and validation CLI. It does **not** import packs into ZQuest, execute source scripts, publish community content, or implement a multiplayer editor. Existing game rendering remains unchanged.

## What a pack preserves

A pack has a stable namespaced ID, exact numeric semantic version, authors, pinned dependencies, source assets and action definitions. Every dependency pins both its version and the SHA-256 of its exact manifest bytes. The CLI emits the submitted manifest's SHA-256 for a future registry to pin. A registry must reject attempts to replace an existing ID/version with different bytes; the standalone validator cannot enforce remote registry immutability or dependency availability.

Each PNG declares its real dimensions, file hash, source locator, original revision/path and attribution. **Source provenance and rights are separate records.** Finding a repository or preserving an original sprite does not establish redistribution permission. `unreviewed` is valid for research catalogs. Other statuses require evidence and a license/permission label, but the validator does not establish that the claim is true. Publication needs its own reviewed decision; validation is not a publication approval.

Each action identifies its semantic purpose and item definition. Four explicit directions are mandatory: up/down/left/right. Every frame records an atlas crop, duration, body origin, grip anchor, independent collision rectangle and explicit flips. Coordinates are integer pixels, frame-local except the atlas crop. This initial contract requires anchors and collision within the crop. A future schema revision may support out-of-frame attachment anchors; adapters must never silently reinterpret coordinates. Left-facing mirrored art must explicitly specify the flip and adapters must transform anchors with that flip. Differing direction timings are permitted, but contact plus recovery must fit every direction's timeline.

These mappings prevent guessing that a treasure-presentation frame is a directional carry animation or that any flower tile is the held crop. They do not prove artistic correctness: four-direction visual review and native-engine comparison remain required. Body/shield/tool multi-layer composition, sounds, sockets, trajectories and engine-specific state adapters require subsequent schema versions; do not squeeze those into unrelated fields.

## Validation

Run from the repository root:

```sh
node scripts/charmville/pack-validate.mjs --schema
node scripts/charmville/pack-validate.mjs path/to/manifest.json
node scripts/charmville/pack-validate.mjs path/to/manifest.json path/to/pack-root
node --test scripts/charmville/pack-contract.test.mjs
```

`--schema` emits standard draft-2020-12 JSON Schema suitable for an editor. The CLI additionally checks cross-field frame bounds, timing, references and safe relative PNG paths. With a pack root it checks real resolved path containment, file SHA-256 and PNG header dimensions. It does not fully decode PNG data or execute it; an eventual importer must impose decoded-memory limits and validate actual image decoding. Unknown fields are rejected so misspelled directions or accidental executable hooks cannot silently pass.

Action contact is a presentation timestamp, **not permission to issue items**. `server-contact` is mandatory. The world server must independently validate reach, target reservation, required equipment and current action state, then issue one idempotent result. A pack cannot contain minting callbacks. `itemDefinition` is an identifier to be resolved against the authoritative item registry, not an inventory grant. It is not yet checked against that registry by this standalone tool.

## Community workflow to build next

1. Fork a pinned pack; retain provenance and record edited assets as new bytes with new hashes.
2. Validate locally and preview every direction, grip, shield conflict, wall collision, contact and interruption.
3. Submit a proposed new version with comparison images and native-reference evidence. Keep artistic review distinct from rights review and gameplay authority review.
4. A registry resolves every pinned dependency, rejects cycles and mutable version replacement, and records a reviewed manifest hash.
5. A compatible engine adapter binds the accepted pack to source-native animation semantics. Server and clients negotiate the same pack hashes. Missing/incompatible packs fail explicitly.
6. World rollout uses a tested content revision with rollback to prior manifests; economic state never rolls backward merely because artwork does.

This supports one item identity across farming, equipment, creatures, social reaction charms and later civilization/galaxy content. The pack is its visual/action description; account ownership, scarcity, exchange settlement and creature HP/status stay in the authoritative world model.
