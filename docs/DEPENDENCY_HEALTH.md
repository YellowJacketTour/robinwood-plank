# Dependency health

This is the current dependency posture for `dev` and `master`. The older
[`DEPENDABOT_INMOTION.md`](./DEPENDABOT_INMOTION.md) remains as a historical
record of the former deployment branch and is not the current baseline.

## 2026-08-07 baseline

The lockfile was refreshed within the existing package ranges. The resulting
local install reported:

- production-only audit: **0 vulnerabilities**;
- full install audit: **28 vulnerabilities** — 12 low and 16 moderate, with
  **0 high or critical** findings;
- 13 deprecated package entries. Most are in development or optional paths;
  `crypto-js` is a runtime transitive of the Seaport integration and has no
  deprecation-safe replacement that can be selected locally.

The application runtime dependency tree is clean under the production-only
audit. The remaining development findings are tracked separately because the
contract test/deployment toolchain is not part of the Passenger runtime.

## Deprecated dependency dispositions

| Dependency path | Disposition |
| --- | --- |
| `typechain` and `solidity-coverage` old `glob`/`inflight` trees | Contract-tooling track; resolve with the coordinated Hardhat migration. |
| `hardhat-gas-reporter` and `mocha` `glob@10.5.0` | Contract-tooling track; do not force a cross-major `glob` override. |
| `@node-minify/core` `glob@9.3.5` | OpenNext upstream path; recheck when OpenNext publishes a compatible update. |
| `node-domexception` through Cloudflare/OpenNext | Upstream path; do not replace independently without testing the adapter. |
| `crypto-js` | Runtime transitive of `merkletreejs`, owned by `@opensea/seaport-js`; track upstream rather than applying an untested override. |
| `@safe-global/safe-gateway-typescript-sdk` | Optional Reown/Safe integration; upstream-owned and not replaced by a blind override. |

## Audit policy

- `npm audit --omit=dev --audit-level=high` is a blocking runtime gate.
- The full-tree `npm audit --audit-level=high` is report-only because it includes
  the isolated Hardhat contract toolchain and other build-only adapters; those
  findings are not Passenger runtime dependencies and are tracked by path.
- Deprecated package notices are reported in the GitHub job summary and remain
  visible until their dependency path is upgraded or explicitly documented.
- Hardhat changes are contract-toolchain changes and must preserve compiled
  bytecode fingerprints; they are not bundled into frontend/backend changes.

The dependency-health workflow runs on pull requests targeting `dev` or
`master`, weekly, and on manual dispatch.

## Build warning observed

`npm run build` passes, but Next/Turbopack reports four dynamic-filesystem
tracing warnings in `lib/uploads.ts`. This is a deployment-bundle warning,
not an npm vulnerability: the upload route deliberately reads the persistent
media directory. It needs a separate storage/tracing decision before changing;
the dependency refresh does not mask it.
