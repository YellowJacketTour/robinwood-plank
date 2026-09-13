# Private runtime artifact acquisition

September 13, 2026. Implemented download primitive; no artifact upload, secret modification or production deployment performed here. Source must be the existing private `YellowJacketTour/charmville-reconstruction-vault`, not the public application repository. Login-required Actions downloads from a public repository do not provide the intended asset privacy.

## Inspected metadata

- `YellowJacketTour/robinwood-plank` is public; `YellowJacketTour/charmville-reconstruction-vault` is private.
- The private vault currently reports zero Actions artifacts and zero repository secret names.
- Public-repository and `inmotion-staging` environment secret-name inventories do not show a clearly dedicated private-vault Actions-read credential. An unrelated vault-named secret is not evidence of suitable access and was not read or reused.
- Existing local GitHub authentication can inspect repository metadata. Its privilege breadth must not be copied into deployment merely to avoid provisioning a scoped credential.

## Implemented command

`scripts/charmville/acquire-private-runtime-artifact.mjs` requires an explicit private repository, artifact ID/name, producing head SHA, archive SHA-256 and a new output path. It verifies the repository is private, confirms metadata identity/expiry and producing commit, follows only HTTPS GitHub/Azure artifact storage redirects without forwarding the API bearer token, streams with a 1 GB cap, then verifies the archive hash. A verified receipt is written last. It never extracts or marks a runtime ready.

```bash
node scripts/charmville/acquire-private-runtime-artifact.mjs \
  --repository YellowJacketTour/charmville-reconstruction-vault \
  --artifact-id APPROVED_ARTIFACT_ID \
  --artifact-name charmville-runtime-APPROVED_RELEASE \
  --head-sha APPROVED_PRODUCING_COMMIT_SHA \
  --archive-sha256 APPROVED_ARCHIVE_SHA256 \
  --output /private-runner-temp/charmville-runtime.zip
```

`GH_TOKEN` must be supplied as a masked CI secret with access limited to private-vault Actions read and required metadata, or a short-lived GitHub App installation token. It is read only from environment, never a CLI argument or returned receipt. No response/signed URL is logged. CLI failures emit a generic safe message. The script rejects public repositories and output under `public`.

## Concrete workflow integration sequence

1. Complete browser acceptance of the package; publish it through a private-vault Actions workflow with `actions/upload-artifact`. Store no raw native package in the public app repository or its public release assets. Select an immutable artifact ID and archive digest independently of mutable names.
2. Record approved source repository, artifact ID/name, producing commit, archive digest, runtime release ID and inventory digest in a reviewed nonsecret configuration. The archive digest and inner inventory digest serve different integrity boundaries.
3. In public-repository deployment CI, obtain a scoped read credential for the private vault. Default `GITHUB_TOKEN` from the public repository cannot be assumed to access the vault. Do not reuse the production SSH key, wallet secrets or a broad developer PAT as a GitHub download token.
4. Invoke acquisition into a fresh private runner temporary directory before Passenger packaging. The returned `.verified.json` is required before extraction. It says `readyToServe:false` because downloading is not product acceptance.
5. Extract with a reviewed ZIP routine: reject absolute/traversal/backslash/drive paths, symlink entries, duplicate/case-colliding destinations, oversized entry counts and expanded size; write only to a new directory. Generic unbounded `unzip` is not yet an implemented verified extraction gate here.
6. Run `stage-private-runtime-release.mjs` against the extracted accepted package with the separately approved runtime release/inventory hash. This rechecks every file, refuses candidate markers and places private content inside standalone/private rather than public.
7. Existing Passenger archive/upload/activation then carries the accepted package. Keep runtime admission disabled until deployed negative-access and positive authenticated tests pass. Code rollback selects its own packaged root.

## Hard blockers still open

There is currently no accepted uploaded runtime artifact, no identified narrowly scoped cross-repository CI download credential, and no wired bounded extraction/acquisition workflow. These are concrete infrastructure gaps, not permission requests manufactured by this script. The root operator can prepare an accepted artifact and provision the scoped access through an existing approved mechanism. Do not manufacture a ready marker or expose the package publicly to get around them.

Focused mocked-network test passed: public-repository rejection, head mismatch, bearer removal on storage requests, exact payload/hash verification, no secret/signed URL in receipt, and no verified marker for corrupt bytes. No real archive was downloaded by the test.
