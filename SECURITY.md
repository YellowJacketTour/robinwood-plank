# Security policy

## Supported branch

| Branch or release | Supported |
| --- | --- |
| `inmotion` and the SHA currently deployed from it | Yes |
| Older immutable InMotion releases used for rollback | Only until replaced |
| `master` | No |
| Local forks and modified deployments | No |

Security fixes for the hosted application must target `inmotion`. The
repository's default branch may still be `master`, so verify the pull-request
base before sharing a patch.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** button when it is available in the
repository Security tab. Repository collaborators can instead create a draft
GitHub Security Advisory. If neither private GitHub path is available, contact
the repository owner through an existing private channel before sending
technical details. Do not open a public issue or discussion containing exploit
details, secrets, private user data, or a working attack.

Include:

- affected commit SHA, route, contract, or component;
- expected and observed behavior;
- reproducible steps or a minimal proof of concept;
- realistic user and fund impact;
- required attacker permissions;
- whether production was tested; and
- a safe remediation idea, if known.

Maintainers will respond on a best-effort basis. Do not assume a response or
disclosure deadline unless it is agreed in the advisory.

## Safe testing rules

Do not:

- move, approve, lock, burn, or withdraw another person's assets;
- send transactions from an address you do not control;
- attempt denial of service, spam the order relay, or exhaust shared-hosting,
  RPC, database, Cloudflare, or GitHub Actions quotas;
- exfiltrate, rotate, invalidate, or test a discovered credential;
- publish wallet keys, database passwords, API tokens, SSH material, raw
  production dumps, or unredacted logs;
- alter live listings, offers, vault inventory, or redemption state; or
- rely on a production exploit when a local regression test can prove the
  issue.

Use local Docker, Hardhat, mocked wallets, and purpose-built test contracts.
If production confirmation is necessary, stop and coordinate through the
private advisory first.

## High-risk areas

Changes in these areas require focused review and regression tests:

- Seaport order construction, signature verification, and displayed values;
- wallet chain checks, transaction simulation, destinations, and approvals;
- V1/V2 vault selection, migration, share math, and redemption;
- drand round selection, beacon submission, claim, and forfeiture;
- relayer private-key handling, gas balance, cron, and logs;
- PostgreSQL migrations, order persistence, snapshot durability, and expiry;
- Uniswap quote/swap server routes and API-key isolation;
- CI SSH trust, release extraction, symlink activation, and rollback;
- CSP, proxy headers, caching, RPC/IPFS proxying, and request limits.

## Secret handling

- Never commit populated `.env` files.
- `NEXT_PUBLIC_*` is public by definition.
- Keep the PostgreSQL password only in the server's mode-`600`
  `shared/.env.production`.
- Keep `UNISWAP_API_KEY` in GitHub Actions and the separately installed
  mode-`600` runtime file.
- Keep `RELAYER_PRIVATE_KEY` out of Passenger and release artifacts. Only the
  cPanel cron may load `shared/runtime-secrets/relayer.env`.
- Use a dedicated deployment SSH key and a verified `known_hosts` entry.
- Use a dedicated gas-only relayer wallet and retain its backup offline.
- Remove temporary Upstash migration credentials after cutover verification.

If a secret appears in git, CI output, chat, an issue, or a pull request, treat
it as compromised. Revoke or rotate it at the provider, then remove the
exposed value from active systems. Rewriting git history alone does not make a
secret safe again.

## Dependency and build security

The lockfile is required. CI installs with `npm ci`. Dependency upgrades must
pass tests and a production build. Contract-toolchain overrides must also
prove compiled production bytecode is unchanged unless the pull request
intentionally changes Solidity.

See [docs/DEPENDABOT_INMOTION.md](docs/DEPENDABOT_INMOTION.md) for the branch's
current alert analysis.

## Audit status and residual risk

The repository contains internal adversarial audits and regression tests.
These records are valuable evidence, but they are not an independent
third-party audit. The Marketplank vaults are immutable deployments, and the
application interacts with real-value assets. A green CI run does not prove
economic safety.

Known trust boundaries include:

- Robinhood Chain and its sequencer/RPC availability;
- canonical Seaport 1.6;
- the bridged WETH proxy and bridge administration;
- the drand League of Entropy threshold;
- Cloudflare and InMotion availability;
- the order relay's ability to serve or censor off-chain orders; and
- operators who control GitHub Actions, cPanel, DNS, and dedicated wallets.

Review [docs/marketplank](docs/marketplank) before changing contract-facing
behavior.
