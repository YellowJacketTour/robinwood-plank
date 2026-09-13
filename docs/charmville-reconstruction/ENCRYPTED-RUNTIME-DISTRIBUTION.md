# Encrypted native package distribution

An accepted private runtime archive may be encrypted locally with AES-256-GCM and its ciphertext uploaded to a public release asset. Raw art/package remains private. Keep the random 32-byte base64 key only in a narrowly scoped GitHub Actions environment secret named `CHARMVILLE_RUNTIME_PACKAGE_KEY`; never place it in code, artifact metadata, URL or command arguments. Public ciphertext reveals approximate package size and release timing, not plaintext. Anyone already authorized to download/decrypt cannot have their downloaded copy revoked.

`runtime-package-envelope.mjs` implements a fixed CVPKG01 binary envelope: eight-byte version header, random 96-bit nonce, ciphertext and 128-bit GCM tag. Header is authenticated as AAD. Decryption first checks independently supplied ciphertext SHA, verifies GCM, then verifies plaintext SHA before publishing the output. In-progress plaintext stays in an exclusive mode-600 temporary file; failed operations remove it and never create final output. Outputs never overwrite; plaintext cannot target `public`. There is a 1 GB input cap. This is encryption/transport integrity, not a runtime acceptance certificate.

Local encryption reads the key from environment and prints only hashes/size:

```bash
node scripts/charmville/runtime-package-envelope.mjs --mode encrypt \
  --input accepted-runtime.zip --output accepted-runtime.encrypted
```

Root operator generates a random key and pipes it directly to `gh secret set` without printing or persisting it. Do not copy a broad GitHub login token into CI. Use the existing approved deployment environment; restrict secret-bearing jobs to trusted release branches and reviewed workflow code, never untrusted pull-request jobs. A workflow that can read the key can exfiltrate it, so branch protection and workflow review remain part of the boundary.

Example step after obtaining ciphertext from an exact reviewed release-asset URL and pinning expected hashes in reviewed nonsecret configuration:

```yaml
- name: Authenticate and decrypt private runtime
  if: github.event_name != 'pull_request'
  env:
    CHARMVILLE_RUNTIME_PACKAGE_KEY: ${{ secrets.CHARMVILLE_RUNTIME_PACKAGE_KEY }}
  run: |
    node scripts/charmville/runtime-package-envelope.mjs --mode decrypt \
      --input "$RUNNER_TEMP/runtime.encrypted" \
      --output "$RUNNER_TEMP/runtime.zip" \
      --archive-sha256 "$APPROVED_CIPHERTEXT_SHA256" \
      --plaintext-sha256 "$APPROVED_PLAINTEXT_SHA256"
```

The hash variables must be supplied by a reviewed immutable release manifest, not trusted solely because they arrived alongside an untrusted download. Use an existing read-only public download for ciphertext; no private-repository token is needed. After successful decryption, bounded safe ZIP extraction and `stage-private-runtime-release.mjs` still validate path structure, file hashes and accepted runtime receipt. The archive is never copied to public/. Publishing ciphertext must not set runtime READY.

Key loss prevents decrypting historical packages; establish controlled recovery/rotation. Key compromise requires a new key and new ciphertext; deleting the old public asset cannot erase downloaded copies. Do not cache decrypted artifacts in public CI caches or upload them as public Actions artifacts.

Focused tests pass: roundtrip, nonce variation, wrong key, authenticated header/ciphertext/tag tampering even after outer hash is recomputed, no plaintext output on failure, no overwrite, private-output restriction and temporary cleanup. No deployment key was generated/read/modified or real package encrypted by these tests.
