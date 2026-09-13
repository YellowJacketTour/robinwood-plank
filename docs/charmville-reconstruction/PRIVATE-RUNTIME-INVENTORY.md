# Private runtime inventory

`scripts/charmville/private-runtime-manifest.mjs` inventories explicit inputs for the current joined-homestead runtime. It reads files, streams SHA-256 hashes and writes one new JSON report. It does not copy assets, run a server, access the network, read environment secrets, provision hosting or certify release readiness.

From the repository root in PowerShell:

```powershell
node scripts/charmville/private-runtime-manifest.mjs `
  --repo-root . `
  --runtime-root ../charmville-references/zquest-classic/build_charmville_web/packages/web `
  --content-root ../charmville-references/zquest-quest-snapshots `
  --sprite-root ../charmville-references/charmville-native-homestead/action-sprites `
  --output work/private-runtime-manifest.json
```

All five arguments are required. The output parent must already exist; output must be a new file (existing reports are never overwritten). Report paths identify named roots and relative files, not absolute local paths. Input paths resolving outside their supplied roots are rejected. Do not point roots at credential stores; the script only reads its explicit runtime allowlist, fixed server metadata, sprite names and validated MIDI patches.

## Scope and interpretation

- Engine loader, WASM/data, play entry, declared icons/styles, explicitly referenced Workbox chunks.
- Current browser bridges, menu art, action sprite allowlist and catalogue.
- Sprite manifest runtime hashes are compared against inventoried bytes.
- MIDI patch paths come from the existing validated `parseMidiPatches` config parser.
- Six metadata inputs required by the current server and only the joined-homestead quest payload. This is deliberately not a copy of the entire reference archive, editor or old quests.
- Adapter source hashes record the behavior that still transforms HTML/main.js and generates metadata/MIDI routes. These source files are not served assets.

Exit 0 means all inventoried inputs were found and checked. Exit 1 with a written report means missing/rejected inputs or failed dependency verification. Invalid arguments, roots and existing output fail without an inventory report. `completeInventory` is not `deployable`: the generated report always says `readiness: inventory-only`.

Before packaging, narrow the runtime's public metadata and launchers to the actual private release. Validate service-worker precache and dynamic filesystem/network requests with a cold-cache browser; the server's generic static fallback can serve more than this bounded manifest. Local source HTML also contains remote links/scripts and requires its existing adaptation and a production review. Keep player-supplied quest loading/editor routes outside the initial private release. Verify compression, MIME, isolation headers, exact JS/WASM/content version pairing, source rights and private admission separately.

## Observed check, September 13, 2026

Actual local roots produced `work/private-runtime-manifest-20260913.json`: 270 entries, zero missing/rejected, zero manifest issues, 219,089,498 total input bytes. This includes adapter/metadata inputs and uncompressed files; it is not transfer size, runtime memory or cold-start duration.

A deliberately incomplete runtime root (`docs`) produced `work/private-runtime-manifest-missing-20260913.json`, exit 1, 18 missing/rejected inputs and 20 issues. This verifies that incomplete input cannot silently report a complete inventory. Neither check changed the runtime or deployed anything.
