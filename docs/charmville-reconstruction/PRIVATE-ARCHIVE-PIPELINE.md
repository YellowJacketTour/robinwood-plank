# Accepted runtime archive → encrypted distribution → private staging

Implemented using Node built-ins, without tar/ZIP extraction or a base64-in-JSON memory spike. The CVARCH1 gzip archive contains an eight-byte magic header, a four-byte JSON-index length, a bounded index, and raw file bytes in index order. Only regular file entries exist. Maximum 4096 files, 2 MB index and 900 MB expanded contents. Extraction streams in bounded chunks, rejects traversal/drive/UNC/backslash/encoded paths, Windows reserved names, case-colliding duplicate paths, trailing payload, size/hash mismatches and missing accepted inventory. No filesystem links are representable.

## Operator packaging after acceptance

```bash
node scripts/charmville/private-runtime-archive.mjs --mode pack \
  --input /private/accepted-runtime --output /private/runtime.cvgz \
  --release APPROVED_RELEASE --inventory-sha256 APPROVED_INVENTORY_SHA256
node scripts/charmville/runtime-package-envelope.mjs --mode encrypt \
  --input /private/runtime.cvgz --output /private/runtime.encrypted
```

Pack requires an already accepted `charmville-runtime-release` receipt. It does not promote a candidate. Encryption requires the secret key in `CHARMVILLE_RUNTIME_PACKAGE_KEY`; output prints safe ciphertext/plaintext hashes. Upload only ciphertext to a public artifact. Pin both hashes plus inner inventory hash and release ID through reviewed configuration. Keep raw source, plaintext archive and key private.

## Deployment preparation after ciphertext download

**Run this only in the trusted deploy job, after downloading the ordinary Passenger build artifact.** The existing build job uploads `passenger-release.tgz` and uses a public-repository Actions/cache fallback. Never insert plaintext native assets into that build artifact. In the deploy job: check out scripts at the exact approved application SHA, unpack the trusted ordinary Passenger bundle into private temporary staging, decrypt/stage the native bundle there, repack locally and send directly over the existing trusted SSH/SCP deployment path. Do not upload or cache the enriched archive afterward.

```bash
node scripts/charmville/prepare-private-runtime-release.mjs \
  --input "$RUNNER_TEMP/runtime.encrypted" \
  --workdir "$RUNNER_TEMP/charmville-private-preparation" \
  --standalone "$RUNNER_TEMP/private-passenger-staging" \
  --release "$CHARMVILLE_APPROVED_RELEASE" \
  --archive-sha256 "$CHARMVILLE_CIPHERTEXT_SHA256" \
  --plaintext-sha256 "$CHARMVILLE_PLAINTEXT_SHA256" \
  --inventory-sha256 "$CHARMVILLE_INVENTORY_SHA256"
```

This orchestrates authenticated decryption, bounded extraction and accepted-package staging under standalone/private/charmville/runtime. Work directory and final package directory must be new. The work directory's parent must exist and be private. No key arguments or automatic serving flags. The runtime remains unavailable unless Passenger's separate explicit readiness/release/admission gates pass.

Failed extraction may leave a private partial directory without EXTRACTION-VERIFIED.json. It must not be reused; staging independently rehashes every file and checks the accepted receipt. Failed authenticated decryption removes its temporary plaintext and never publishes a final archive. CI must clean its private workspace after completion and never upload/cache plaintext publicly. Default runner cleanup is not permission to retain plaintext in shared caches.

## Evidence and limits

Focused test passed: pack/extract roundtrip, encrypt→decrypt→extract→stage orchestration, traversal/duplicate/expansion-limit rejection, corrupt-file detection, final-output no-overwrite and absent verification marker on failure. Synthetic fixture only; no actual candidate promoted and no deployment performed. Actual 219 MB package compression, cold-start throughput and host behavior still need measurement after browser acceptance.

This supersedes the earlier requirement to select a ZIP extraction dependency. The private-GitHub artifact acquisition option remains separate; the encrypted-public-ciphertext route needs no cross-repository token and should distribute this `.cvgz` archive inside the authenticated envelope.
