# Release and versioning policy

This policy applies to the canonical `inmotion` branch.

This document is the branch/versioning policy. For a dated record of what
actually shipped in a given window, see the dated release-notes files, e.g.
[Release notes — 2026-07-30](RELEASE_NOTES-2026-07-30.md).

## Branches

| Branch | Purpose |
| --- | --- |
| `inmotion` | Source of truth for development, releases, and InMotion deploys. |
| `master` | Legacy branch. It is not the InMotion deployment source. |
| Feature/fix branches | Short-lived branches that open pull requests into `inmotion`. |

The GitHub repository should use `inmotion` as its default branch when the
owner is ready to make the repository setting match this policy. Until then,
contributors must select `inmotion` explicitly as the pull-request base.

Recommended ruleset for `inmotion`:

- require a pull request;
- require the `InMotion Passenger CI/CD / build` check;
- require conversation resolution;
- block force pushes and deletion;
- restrict direct pushes to release owners; and
- keep deployment credentials in the `inmotion-staging` GitHub Environment.

These are repository-setting recommendations, not claims that protection is
already enabled.

## Two identifiers, two jobs

### Deployment version

Every deployed build is identified by its full Git commit SHA. The SHA is:

- embedded as `DEPLOYMENT_VERSION`;
- exposed by `/api/health`;
- used as the immutable server release-directory name;
- used for the Passenger artifact name; and
- compared during public health verification.

This is the authoritative answer to "what code is running?"

### Product version

`package.json` is the source for the human-facing Semantic Version:

```text
MAJOR.MINOR.PATCH
```

- **MAJOR:** incompatible user, API, storage, contract-address, or operator
  behavior.
- **MINOR:** backward-compatible feature or material product capability.
- **PATCH:** backward-compatible fix, documentation correction, dependency
  remediation, or operational hardening.

Do not bump a version for every automatic deployment. Bump it when an owner
intends to create a named GitHub Release.

## Commit messages

Use conventional prefixes:

```text
feat:      MINOR candidate
fix:       PATCH candidate
security:  PATCH or MINOR depending on user impact
perf:      PATCH unless behavior changes
design:    PATCH unless it changes information architecture or a workflow
ops:       PATCH when release behavior changes
docs:      usually no version by itself
chore:     usually PATCH only when shipped behavior changes
```

A breaking change must include `BREAKING CHANGE:` in the commit body and
normally requires a MAJOR version.

## Pull-request release gate

Before merging to `inmotion`:

1. Pull-request base is `inmotion`.
2. CI is green at the exact head SHA.
3. Security-sensitive diffs have focused tests.
4. Public-variable changes are documented and reviewed as a rebuild.
5. Database migrations are append-only and backward-compatible.
6. Contract bytecode is unchanged unless the pull request explicitly owns a
   contract release.
7. Desktop/mobile screenshots accompany visible changes.
8. Rollback and data implications are stated.

## Automatic deployment

When `INMOTION_DEPLOY_ENABLED=true`, a push to `inmotion`:

1. runs the full build job;
2. creates `passenger-<SHA>.tgz`;
3. uploads it through verified SSH;
4. applies pending PostgreSQL migrations;
5. installs server-only runtime material;
6. activates `releases/<SHA>` through the atomic `current` symlink;
7. restarts Passenger;
8. checks PostgreSQL, deployment SHA, Uniswap configuration, and `/market`;
   and
9. restores the previous application symlink if health fails.

Deploys are serialized per ref and are never cancelled halfway through.

## Manual workflow operations

The `InMotion Passenger CI/CD` workflow supports:

| Operation | Purpose | Confirmation |
| --- | --- | --- |
| `deploy` | Rebuild and deploy the selected `inmotion` SHA. | None |
| `provision-relayer` | Install the cron-only key, verify one run, and manage the cron entry. | None |
| `verify-relayer` | Prove 24 hours of InMotion health, then disable the GitHub fallback schedule. | `DISABLE_GITHUB_RELAY` |

Manual operations must run from `inmotion`. Do not dispatch them from
`master`.

## Database compatibility

Application rollback and database rollback are different operations.

- CI automatically restores the previous app symlink after a failed health
  check.
- CI does not reverse migrations or imported data.
- Every migration must work with both the new build and the immediately
  previous build.
- Destructive data changes require an explicit backup and manual
  confirmation.
- A restore must be tested periodically, not assumed from the existence of a
  dump.

## Domain and configuration releases

`NEXT_PUBLIC_*` variables are build-time inputs. A DNS edit alone cannot
change URLs embedded in the browser application.

For the `plank.love` cutover:

1. make the hostname serve the InMotion application with valid origin TLS;
2. verify `/api/health` and `/market`;
3. set `NEXT_PUBLIC_SITE_URL=https://plank.love`;
4. set `INMOTION_HEALTH_URL=https://plank.love`;
5. rebuild and deploy;
6. move any legacy HTTP cron URL only after the new origin passes; and
7. add the old-host redirect last.

The physical app path remains
`/home/CPANEL_USER/plank.tanggang.life`; a hostname change does not require a
directory move.

## Cutting a named GitHub Release

After the selected SHA has deployed and passed production checks:

```bash
git switch inmotion
git pull --ff-only origin inmotion

# Update package.json/package-lock.json version in a reviewed PR first.
git tag -s vX.Y.Z <DEPLOYED_SHA>
git push origin vX.Y.Z
```

Create a GitHub Release from the signed tag. Release notes should group:

- user-visible changes;
- operator/deployment changes;
- database migrations;
- security changes;
- known limitations; and
- the exact deployed SHA.

Do not tag a commit before production verification. Do not move or reuse an
existing release tag.

## Rollback decision

Use an application rollback when the new SHA fails without corrupting data.
Stop and coordinate a data recovery when:

- a migration removed or transformed data;
- a cutover imported the wrong source;
- on-chain addresses or public configuration were built incorrectly;
- user signatures may have been shown with wrong values; or
- a secret may have been exposed.

Never describe a symlink rollback as a database or blockchain rollback.
