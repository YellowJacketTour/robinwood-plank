# Private runtime in the Passenger release

September 13, 2026. Local packaging helper implemented. Follow-up implements Passenger bundle selection and a workflow copy line for its helper; artifact acquisition/staging and remote activation remain unimplemented here. No credentials, DNS or production host state were accessed by this audit.

## Concrete packaging path

Security supersession: enrich the ordinary Passenger archive only inside the trusted deploy job after its artifact download. The existing build-job upload/cache is public-repository infrastructure; it must never receive a bundle containing plaintext native assets. Decrypt/stage into private deploy-job temporary storage, repack locally and SCP directly, with no subsequent artifact/cache upload. The older placement description below is superseded on this point by PRIVATE-ARCHIVE-PIPELINE.md.

The existing `.github/workflows/inmotion.yml` packages `.next/standalone` into `passenger-release.tgz`. Its native runtime input must come from an authenticated, immutable build artifact selected by exact workflow run/commit and independently pinned inventory SHA-256. Do not download an unversioned URL or follow a package's arbitrary paths. Existing local sibling reference directories are not CI dependencies.

After obtaining the reviewed runnable package and after Next standalone build, before the workflow's final `tar`:

```bash
node scripts/charmville/stage-private-runtime-release.mjs \
  --input /trusted/extracted-runtime \
  --standalone .next/standalone \
  --release approved-release-id \
  --inventory-sha256 approved-inventory-sha256
```

The helper requires a `charmville-runtime-release` marker with `readyToServe: true`, matching release ID and independently supplied inventory hash. It rehashes every copied file through the bounded exporter, stages under `private/charmville/runtime`, preserves the accepted inventory bytes and refuses existing destination output. Candidate/input-only markers fail. The helper cannot certify a candidate; marker promotion requires separate browser acceptance. It never fetches or deploys.

## Required existing-file integration

1. `.github/workflows/inmotion.yml`: add opt-in acquisition of a trusted native artifact by immutable ID/hash; validate archive extraction against traversal/symlinks; invoke the helper before tar; verify packaged runtime marker. Keep default game disabled if no accepted runtime is attached. Do not use build-baked public flags as authorization.
2. `deploy/inmotion/passenger.cjs`: it already computes `releaseRoot = realpathSync(appRoot/current)`. After loading server environment, derive the runtime root from that real immutable release directory: `path.join(releaseRoot, 'private', 'charmville', 'runtime')`. A path through `appRoot/current` will fail the artifact resolver's symlink checks. Bind runtime release selection to the validated packaged marker. Code rollback must select the previous package automatically, not retain an absolute path to the newer release in shared environment.
3. Admission remains a runtime server/DB policy independent of the artifact. Keep the deployment disabled until private grants, revocation and synthetic-account HTTPS validation pass. Never pack session credentials, allowlist exports, wallet keys or production env files with native assets.
4. Update deployment docs/environment validation with nonsecret keys and explicit operator controls. Keep the protected asset route off shared caches and exclude the private filesystem directory from Apache static aliases.

## Host constraints requiring actual verification

- The documented InMotion environment supplies Apache/Passenger/Node and PostgreSQL, not a confirmed general WebSocket daemon host. Native asset serving through existing HTTPS Next routes does not prove WSS worker support.
- The local WASM is approximately 125 MB; current local gzip helper skips files above 32 MB. Measure authenticated streaming throughput, memory, process concurrency and cold start; precompressed variants require separately tested header/representation handling.
- Confirm Cloudflare and Apache preserve private/no-store and isolation headers, do not cache 200 assets across admission boundaries, and deny the physical private directory. Verify HEAD and expired/revoked cookies, not just the friendly game page.
- Artifact acquisition/storage and deployment credentials may already exist, but none were inspected here. Current public hostname routing and SHA must be verified independently; historical hostname runbooks are not current evidence.
- Source branch integration, migrations and full merged-result checks remain release gates. Successful tar upload or a page returning 200 does not establish live account gameplay.

## Local evidence

`stage-private-runtime-release.test.mjs` passes: candidate rejection, independently pinned hash mismatch rejection, exact reviewed inventory preservation and private placement. Synthetic fixtures only. No real candidate was promoted, no live package was staged, and no workflow/Passenger code was changed by this bounded task.

### Follow-up: bootstrap implemented, not activated

`deploy/inmotion/charmville-runtime.cjs` now requires explicit `CHARMVILLE_RUNTIME_READY=1` and `CHARMVILLE_RUNTIME_RELEASE` matching the accepted bundled receipt. Passenger invokes it using the real immutable releaseRoot. The helper deletes stale externally supplied ROOT, verifies no symlink ancestors, marker/inventory size/type/hash and completeness, then selects that release's private directory. Missing/mismatched/candidate packages set READY=0 and leave unrelated application settings unchanged. A missing helper also disables only native runtime and permits the existing site to start.

The workflow now copies that small helper beside passenger.cjs. It does not acquire native artifacts or enable serving. `passenger-runtime.test.mjs` passes opt-in, matching bundle, disabled/missing/mismatched/candidate/tampered bundle and symlink cases. Targeted ESLint passed after using the repository's CommonJS bootstrap lint convention. Root must integrate this patch into current dev and run full release checks before any production activation.
