# Documentation index

The canonical branch is `inmotion`. Current operating documents are listed
first. Dated audit and incident files are evidence records and may describe an
earlier hosting or contract state.

## Current documents

- [Project README](../README.md): product, quick start, configuration, and
  release summary.
- [Architecture](../ARCHITECTURE.md): runtime, storage, chain, relayer, and
  trust boundaries.
- [Contributing](../CONTRIBUTING.md): branch policy, tests, migrations, and
  pull-request expectations.
- [Security policy](../SECURITY.md): supported branch, private reporting, safe
  testing, and secret handling.
- [Release and versioning policy](RELEASES.md): SHA releases, SemVer tags,
  deployment, and rollback.
- [Release notes — 2026-07-30](RELEASE_NOTES-2026-07-30.md): what shipped to
  production, what is committed but unpushed, flag defaults, and known
  limitations for the trade-page/cross-chain/gasless work.
- [InMotion deployment](INMOTION_DEPLOYMENT.md): cPanel, Passenger,
  PostgreSQL, GitHub Actions, domain cutover, and cron.
- [Dependabot status](DEPENDABOT_INMOTION.md): alert-by-alert resolution on
  `inmotion`.
- [Marketplank engineering specification](marketplank/SPEC.md): current
  marketplace and vault design plus historical decisions.
- [Vault deployment tool](../scripts/deploy-tool/README.md): operator-signed
  contract deployment utility.

## Historical security and product records

- [Initial internal Marketplank audit](marketplank/AUDIT-2026-07-27.md)
- [Fable internal audit and drand follow-up](marketplank/AUDIT-2026-07-27-fable.md)
- [Vault LP migration postmortem](marketplank/POSTMORTEM-2026-07-29-vault-lp-migration.md)
- [Archived Fable handoff prompt](marketplank/FABLE-ONESHOT.md)
- [Remilia/Milady research note](marketplank/RESEARCH-remilia-milady.md)

Historical documents are not deployment runbooks. When they conflict with
current code or operations, use the current documents and the `inmotion`
branch.
