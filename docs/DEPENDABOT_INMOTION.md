# Dependabot status for `inmotion`

This branch remediates every open Dependabot advisory that has a compatible
patched version. The alerts shown in GitHub remain keyed to the repository's
default branch, so they will continue to appear until equivalent dependency
resolution is adopted there. This change does not modify `master`.

All 16 alerts are in `package-lock.json` and are classified by GitHub as
development dependencies. The compatible parent-scoped overrides below avoid
forcing unrelated production dependency trees. The one remaining alert,
`elliptic`, has no patched npm release as of this review.

| Alert | Package | Severity | Advisory | `inmotion` resolution |
| ---: | --- | --- | --- | --- |
| 22 | `adm-zip` | high | GHSA-xcpc-8h2w-3j85 | Resolved at `0.6.0` under `hardhat` |
| 21 | `undici` | low | GHSA-g8m3-5g58-fq7m | Resolved at `6.27.0` under affected Hardhat parents |
| 20 | `undici` | medium | GHSA-p88m-4jfj-68fv | Resolved at `6.27.0` under affected Hardhat parents |
| 18 | `undici` | low | GHSA-35p6-xmwp-9g52 | Resolved at `6.27.0` under affected Hardhat parents |
| 17 | `tmp` | high | GHSA-ph9p-34f9-6g65 | Resolved at `0.2.6` under `hardhat > solc` |
| 16 | `serialize-javascript` | medium | GHSA-qj8w-gfj5-8c6v | Resolved at `7.0.5` under `mocha` |
| 15 | `uuid` | medium | GHSA-w5hq-g745-h8pq | Resolved at `11.1.1` under `hardhat` |
| 14 | `lodash` | high | GHSA-r5fr-rjxr-66jc | Resolved at `4.18.1` under affected Hardhat parents |
| 13 | `lodash` | medium | GHSA-f23m-r3pf-42rh | Resolved at `4.18.1` under affected Hardhat parents |
| 10 | `undici` | medium | GHSA-4992-7rv2-5pvq | Resolved at `6.27.0` under affected Hardhat parents |
| 9 | `undici` | medium | GHSA-2mjp-6q6p-2qxm | Resolved at `6.27.0` under affected Hardhat parents |
| 8 | `serialize-javascript` | high | GHSA-5c6j-r48x-rmvq | Resolved at `7.0.5` under `mocha` |
| 6 | `lodash` | medium | GHSA-xxjr-mmjv-4gpg | Resolved at `4.18.1` under affected Hardhat parents |
| 3 | `elliptic` | low | GHSA-848j-6mx2-7j84 | **Open:** no patched npm release; development-only transitive dependency |
| 2 | `tmp` | low | GHSA-52f5-9888-hmc6 | Resolved at `0.2.6` under `hardhat > solc` |
| 1 | `cookie` | low | GHSA-pxg6-pf52-xh8x | Resolved at `0.7.2` under `hardhat > @sentry/node` |

Verification for this branch:

- `npm ls` must be internally consistent after a clean install.
- The full market and Solidity test suites must pass.
- Production build and Passenger packaging must pass in CI.
- The compiled bytecode hash for every contract artifact must be identical
  before and after this dependency-only change.

The forced pre/post compile produced identical Keccak-256 bytecode
fingerprints for every artifact. The production contract fingerprints were:

| Contract | Bytecode fingerprint |
| --- | --- |
| `DrandBeacon` | `0xd36d13eea71d9c7f31c1300ed562efa7ba4b67ec4315a3dd6f34c17fc3cb7212` |
| `IDrandBeacon` | `0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470` |
| `BLSBN254` | `0x88b084a4d28f97d6a7171fc62ad396a2b61f82944ca14034b88d0b2cadd9057d` |
| `MarketplankVault` | `0x385851b0b008fb39ac57342c4ac3243e278c7e3ec7e9ba72e71ab6a65eef3822` |
