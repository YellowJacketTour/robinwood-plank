# Private runtime input export and relocation plan

The exporter creates a self-contained, hash-verified **input package**, not a directly runnable web release. This distinction prevents accidentally publishing raw original HTML, external data origins, editor links or unprotected assets. `PACKAGE-COMPLETE.json` explicitly sets `readyToServe: false`.

## Run

First generate a fresh inventory using PRIVATE-RUNTIME-INVENTORY.md. Then run from the repository root:

```powershell
node scripts/charmville/export-private-runtime.mjs `
  --manifest work/private-runtime-manifest.json `
  --repo-root . `
  --runtime-root ../charmville-references/zquest-classic/build_charmville_web/packages/web `
  --content-root ../charmville-references/zquest-quest-snapshots `
  --sprite-root ../charmville-references/charmville-native-homestead/action-sprites `
  --output ../charmville-private-input-package
```

Output must be new, outside every input root, and outside a directory named `public`. Its parent must exist. Inputs must be stable operator-owned trees. All manifest entries are copied through streamed SHA-256 verification, preserving named relative root directories. No directory crawl, downloads, environment files, Git metadata or unspecified reference assets are included. Duplicate/case-colliding paths, traversal and symlink components are rejected.

The completion marker is written last. Any interrupted or hash-rejected folder lacks that marker and must not be used; the exporter deliberately does not delete or overwrite it. A fresh output name is required for another attempt. The package's inventory hash is over the exact emitted `inventory.json` bytes. Hashes and relative mappings are deterministic for the same manifest/input bytes; filesystem timestamps are not release identity.

## Exact remaining runnable-export work

1. Extract the current server's HTML transformation and main.js data-origin substitution into deterministic pure adapters. Preserve gesture-controlled engine startup, MIDI preload, sprite hash checking and bridge order. Replace inline loader absolute paths with one validated release prefix.
2. Generate entry HTML and transformed main.js alongside their own output hashes; original input hashes cannot certify transformed bytes. Configure data/WASM `Module.locateFile` explicitly and verify pthread same-script URLs under the prefix.
3. Rewrite bridge absolute fetch/navigation paths, menu/action art, catalogue and MIDI URLs. Replace generated quest metadata with only approved joined-homestead content. Remove old source launchers/editor routes and remote analytics. Disable inherited service-worker exposure for initial protected hosting.
4. Feed only these compiled outputs to an authenticated route and manifest. Original adapter source and metadata inputs remain private build provenance, not served files. Existing adapter imports resolve within the input package, but their old path assumptions are not executable hosting configuration.
5. Cold-cache browser network audit must prove every loader/worker/quest/music/art fetch stays within the accepted package and works after admission, expiry and revocation. Then check game movement, input and account bridges. No network trace or gameplay acceptance is implied by successful copying.

## Evidence: September 13, 2026

- Focused exporter test passes: exact bytes, existing-output rejection, input-root/public overlap rejection, traversal rejection and no completion marker after hash mismatch.
- Exporting the older inventory correctly failed because a live input changed after inventory. Partial folder `../charmville-private-input-package-20260913` was retained without a completion marker.
- Fresh inventory/export succeeded at `../charmville-private-input-package-20260913-r02`: 270 files, 219,089,689 bytes; inventory SHA-256 `8403e7f6d236ab7ffb1fa1687a0de2e8839ac386b40d5586d3e99590c0f0d52b`.
- No server, route or deployment was created. The package is local preparation, not a playable private release.
