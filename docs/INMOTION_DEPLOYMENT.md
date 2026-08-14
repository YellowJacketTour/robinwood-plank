# InMotion cPanel Passenger deployment

This is the operator runbook for the canonical `master` branch, the
deployment branch. Development happens on `dev`; merging `dev` into `master`
ships.

## Current state

As verified on 2026-07-30:

- the InMotion application is healthy at `https://plank.tanggang.life`;
- `/api/health` reports `storage: "postgres"`;
- releases are built and deployed from `inmotion` (the deployment branch at
  the time of this verification; the deployment branch has been `master`
  since 2026-08-02);
- the physical application root is
  `/home/CPANEL_USER/plank.tanggang.life`;
- the standalone drand relayer is packaged with every release;
- `plank.love` still serves the earlier Cloudflare Worker and has not completed
  the InMotion hostname cutover;
- GitHub's scheduled drand workflow remains an active fallback until the
  24-hour InMotion verification gate disables it; and
- production's `shared/.env.production` still needs `RPC_URL` appended (a
  private provider endpoint, e.g. Alchemy) — without it, server-side chain
  reads fall back to the public Robinhood Chain RPC, which is rate-limited.

The target public hostname is `plank.love`. The application directory does not
need to move when the hostname changes.

## 1. Runtime architecture

```text
Cloudflare DNS / proxy / WAF
             |
             v
InMotion cPanel Apache + Passenger
             |
             +-- Next.js 16 standalone server on Node.js 22.22.3
             +-- local cPanel PostgreSQL
             +-- cPanel cron -> standalone drand relayer

GitHub Actions
             |
             +-- build, test, package, SSH upload
             +-- migration, activation, health, rollback
             +-- manual data-cutover and relayer operations
```

Docker is the local verification environment. InMotion shared hosting does not
run Docker, Redis, Valkey, PM2, `cloudflared`, or a custom reverse proxy.

The SQL store is not a custody or execution engine. Makers sign Seaport orders
in their wallets and fulfillment occurs on-chain. PostgreSQL stores and
indexes the signed orders, shared application state, and expensive snapshots.

## 2. Branch and release authority

- `master` is the deployment branch — the source of truth for what is live.
- `dev` is the working branch. Pull requests target `dev`; merging `dev` into
  `master` ships.
- Pushes to `master` deploy when `INMOTION_DEPLOY_ENABLED=true`.
- Every release is an immutable Git commit SHA.

See [RELEASES.md](RELEASES.md) for versioning, ruleset, and rollback policy.

## 3. Local Docker verification

Create a local secret file:

```powershell
Copy-Item .env.docker.example .env.docker.local
```

Set a unique local `POSTGRES_PASSWORD`, then build and start:

```powershell
docker compose --env-file .env.docker.local `
  -f docker-compose.inmotion.yml up -d --build

docker compose --env-file .env.docker.local `
  -f docker-compose.inmotion.yml ps
```

The migration container applies pending SQL before the app starts. Verify:

```powershell
curl.exe --fail http://127.0.0.1:3000/api/health
curl.exe --fail http://127.0.0.1:3000/market
```

The health response must contain:

```json
{"ok":true,"storage":"postgres"}
```

PostgreSQL data remains in the `postgres_data` Docker volume across app
rebuilds and restarts.

## 4. PostgreSQL

Create the database and application user with **PostgreSQL Database Wizard**,
then grant the user all privileges on that database. cPanel prefixes the
database and user names with the account username.

```dotenv
DURABLE_KV_BACKEND=postgres
PGHOST=localhost
PGPORT=5432
PGDATABASE=CPANEL_PREFIX_plank
PGUSER=CPANEL_PREFIX_plankapp
PGPASSWORD=replace-with-the-real-database-password
PGPOOL_MAX=4
PGSSLMODE=disable
```

Keep the password only in the server environment file. `PGPOOL_MAX=4` limits
each Passenger process to a small pool suitable for shared hosting.

PostgreSQL stores:

- indexed signed marketplace orders;
- served-order attribution;
- durable KV compatibility values, hashes, and sets;
- rarity and vault-activity snapshots; and
- transactional Boards state.

Blockchain ownership, vault inventory, shares, reserves, pending redemption,
and settlement remain on-chain.

## 5. Dedicated deployment SSH key

Generate a dedicated GitHub deployment key on a trusted workstation. Do not
reuse or download a personal private key already stored in cPanel.

```powershell
ssh-keygen -t ed25519 `
  -f "$env:USERPROFILE\.ssh\plank_inmotion_deploy" `
  -C "github-actions-plank-inmotion"
```

Import only the `.pub` file under **cPanel → Manage SSH Keys**, then authorize
it. Store the private file's complete contents as the GitHub Actions secret
`INMOTION_SSH_KEY`.

Test the key. InMotion shared hosting commonly uses port 2222:

```powershell
ssh -i "$env:USERPROFILE\.ssh\plank_inmotion_deploy" `
  -p 2222 CPANEL_USER@SERVER_HOSTNAME
```

Verify the server host-key fingerprint through the account or InMotion support
before trusting it. Store the verified `known_hosts` line in
`INMOTION_HOST_KEY`; do not blindly trust an unverified `ssh-keyscan` result.

## 6. Server layout

The stable root is:

```text
/home/CPANEL_USER/plank.tanggang.life
├── current -> releases/<COMMIT_SHA>
├── incoming/
├── releases/
├── shared/
│   ├── .env.production
│   ├── backups/
│   ├── drand-relayer.lock
│   └── runtime-secrets/
│       ├── uniswap-api-key
│       └── relayer.env
├── logs/
│   ├── passenger.log
│   └── drand-relayer.log
├── tmp/
│   └── restart.txt
├── passenger.js
└── passenger.cjs
```

Initial directories:

```bash
app_dir="$HOME/plank.tanggang.life"
mkdir -p "$app_dir"/{incoming,releases,shared,tmp,logs}
mkdir -p "$app_dir/shared/runtime-secrets"
chmod 700 "$app_dir/shared" "$app_dir/shared/runtime-secrets"
```

Copy `.env.inmotion.example` to:

```text
/home/CPANEL_USER/plank.tanggang.life/shared/.env.production
```

Fill it directly on the server:

```bash
chmod 600 "$HOME/plank.tanggang.life/shared/.env.production"
```

CI does not upload or overwrite that file.

### Admin allowlist

`PLANK_ADMIN_ADDRESSES` gates every `/admin` mutation. It is read at request
time, not baked into the bundle, so it belongs in `.env.production` and **not**
in the workflow's build env or a repository variable — it is deliberately not a
`NEXT_PUBLIC_*` value.

```bash
printf 'PLANK_ADMIN_ADDRESSES=0xAAA…,0xBBB…\n' \
  >> "$HOME/plank.tanggang.life/shared/.env.production"
touch "$HOME/plank.tanggang.life/tmp/restart.txt"
```

Comma-separated, case-insensitive, no spaces required. Passenger picks it up on
the restart; no redeploy is needed to add or revoke a wallet.

Leaving it unset is not "no admins": `lib/admin-auth.ts` falls back to the two
treasury wallets from `lib/constants.ts`. Setting it explicitly is what lets a
signer be added or removed without a code change.

## 7. Passenger application

In **cPanel → Setup Node.js App**:

```text
Node.js version:          22.22.3
Application mode:         Production
Application root:         plank.tanggang.life
Application URL:          plank.tanggang.life
URL path:                 blank
Application startup file: passenger.js
Passenger log file:       /home/CPANEL_USER/plank.tanggang.life/logs/passenger.log
```

The release installs the CommonJS launcher as `passenger.js` and
`passenger.cjs`. It loads stable shared configuration, resolves the active
release, and starts Next.js' generated standalone server. Passenger supplies
the port and owns the process lifecycle.

Use cPanel's virtual-environment command to identify the Node executable:

```bash
which node
node --version
```

Store the absolute path as `INMOTION_NODE_BIN`.

## 8. GitHub Actions configuration

The workflow uses the GitHub Environment `inmotion-staging`.

### Actions secrets

- `INMOTION_HOST`
- `INMOTION_PORT`
- `INMOTION_USER`
- `INMOTION_SSH_KEY`
- `INMOTION_HOST_KEY`
- `UNISWAP_API_KEY`
- `RELAYER_PRIVATE_KEY`
- `CRON_SECRET` only while the legacy HTTP cron endpoint remains
- `VAULT_DISPATCH_TOKEN` — the fine-grained PAT (`actions: write` on this repo
  only) that `/admin` uses to dispatch a V3 vault deploy. **Note the name.**
  GitHub rejects any secret or variable beginning with `GITHUB_`, so the value
  the application reads as `GITHUB_DISPATCH_TOKEN` cannot be stored under that
  name here. Run this workflow with `operation=set-dispatch-token` to install
  it into the server's `.env.production` under the application's name; that
  job is the only way to move the value, since a stored Actions secret cannot
  be read back by the API, the UI, or a repository admin.

Optional repository *variables* (not secrets — neither is sensitive):
`VAULT_DISPATCH_REPO`, `VAULT_DISPATCH_REF`. Unset means the application's own
defaults apply.

The workflow can resolve repository or environment secrets. Environment-scoped
secrets are preferred because they restrict deployment credentials to jobs
that declare `environment: inmotion-staging`.

The PostgreSQL password remains only in the server's `.env.production`.

### Repository variables

- `INMOTION_DEPLOY_ENABLED=true`
- `INMOTION_APP_DIR=/home/CPANEL_USER/plank.tanggang.life`
- `INMOTION_NODE_BIN=/absolute/path/to/node`
- `INMOTION_HEALTH_URL=https://plank.tanggang.life` until domain cutover
- `NEXT_PUBLIC_SITE_URL=https://plank.tanggang.life` until domain cutover
- every other `NEXT_PUBLIC_*` value from `.env.inmotion.example`

`NEXT_PUBLIC_*` values are build inputs, not runtime secrets.

**A `NEXT_PUBLIC_*` flag that a SERVER module reads needs both halves.** Next
inlines these into the client bundle at build time, so the build env is enough
for anything only the browser reads. It is not enough for a flag read in a
server module (`lib/referral-server.ts`, `lib/moonpay-server.ts`): the
standalone server evaluates `process.env.NEXT_PUBLIC_X` at runtime on the box,
where the variable does not exist unless the deploy writes it into
`shared/.env.production`. The symptom is a status route reporting `false` after
a build that clearly had the flag set to `true`, with the panel — which gates
on that route, not on its own bundled copy — staying hidden. The deploy now
stages those flags into the server env; add new ones to that list, not only to
the build env block.

### Enabling referral attribution

One repository variable, no secrets — the feature needs only Postgres, which
the server already has:

- `NEXT_PUBLIC_REFERRAL_ENABLED=true`, then redeploy. The deploy bakes it into
  the client bundle *and* writes it into `shared/.env.production` for the
  server side — `lib/referral-server.ts` reads it at runtime, so the build
  alone leaves `/api/referral/status` reporting `false` and the panel hidden.

Migration `010_referral_attribution.sql` applies automatically on activation.

**Understand before enabling:** attribution is permanent by construction. The
first claim for a wallet wins, every row is signed by the wallet it names, and
no code path updates a row. Enabling starts writing records that only an admin
revoke can clear.

The correction path is `DELETE /api/admin/referral` — admin-signed, action-
logged, and deliberately not wired into any UI. It **revokes** an attribution;
it cannot redirect one. After a revoke the wallet is unattributed and can only
gain a new referrer through the normal signed flow, which preserves the
property that every row on file was signed by the wallet it names. Use it when
someone confirms an invite in error, rather than editing the table by hand.

## 9. Automatic CI/CD behavior

Pull requests to `dev` and `master` run:

- locked dependency installation;
- deployment-critical lint;
- TypeScript;
- PostgreSQL migrations against a disposable service;
- marketplace and contract tests;
- PostgreSQL integration tests;
- production Next.js build; and
- standalone drand relayer bundling.

A push to `master` packages `.next/standalone`. When
`INMOTION_DEPLOY_ENABLED=true`, the deploy job:

1. uploads an immutable release named by commit SHA;
2. installs the GitHub-managed Uniswap key as a mode-`600` runtime secret;
3. runs pending PostgreSQL migrations with server-side credentials;
4. atomically changes the `current` release symlink;
5. touches `tmp/restart.txt` so Passenger reloads;
6. checks PostgreSQL and the exact deployment SHA;
7. confirms the live trade API loaded its server credential;
8. renders `/market`; and
9. restores the previous application symlink if health fails.

GitHub builds the application. The shared server does not run `npm ci` or
compile Next.js.

## 10. Domain cutover to `plank.love`

Do not move `/home/CPANEL_USER/plank.tanggang.life`. The directory is a stable
application identifier even after the public hostname changes.

### A. Detach the old Cloudflare Worker

In the `plank.love` Cloudflare zone:

1. Open **Workers & Pages → plank-love → Settings → Domains & Routes**.
2. Remove the `plank.love` and `www.plank.love` custom domains from that
   Worker.
3. Confirm those locked Worker DNS records disappear before creating new
   records.

Do not delete the Worker until rollback is no longer needed.

### B. Register the hostname in cPanel

In **cPanel → Domains → Create A New Domain**:

- domain: `plank.love`;
- document root: the existing
  `/home/CPANEL_USER/plank.tanggang.life`; and
- do not create a second database or duplicate application directory.

If cPanel offers **Share document root**, use the option that maps the new
hostname to the existing application root.

The existing Node app may need its Application URL changed from
`plank.tanggang.life` to `plank.love`. Keep the Application root unchanged.
Make that URL change only after cPanel recognizes the new domain.

### C. Create Cloudflare DNS and origin TLS

Create:

```text
A      @      <INMOTION_ORIGIN_IP>   DNS only   Auto
CNAME  www    plank.love             DNS only   Auto
```

Use DNS-only while cPanel AutoSSL validates and issues the origin certificate.
Verify:

```bash
curl --fail https://plank.love/api/health
curl --fail https://plank.love/market
```

The health response must report PostgreSQL and the expected deployed SHA. If
the hostname shows a default "It works" page, the domain is not attached to
the Passenger application yet.

After direct HTTPS works:

1. set Cloudflare SSL/TLS to **Full (strict)**;
2. enable the Cloudflare proxy;
3. repeat the health and market checks; and
4. inspect browser console and wallet connection on desktop and mobile.

A Cloudflare Tunnel is not part of this design. Shared cPanel hosting does not
provide a managed, continuously supervised `cloudflared` connector or stable
private Passenger port.

### D. Change application and CI URLs

Only after the new hostname is healthy:

```bash
gh variable set NEXT_PUBLIC_SITE_URL \
  --body https://plank.love \
  --repo YellowJacketTour/robinwood-plank

gh variable set INMOTION_HEALTH_URL \
  --body https://plank.love \
  --repo YellowJacketTour/robinwood-plank
```

Update the server's `NEXT_PUBLIC_SITE_URL` for consistency, then deploy the
current `master` SHA. Because public values are compiled into browser
bundles, an env-file edit without a rebuild is insufficient.

If a legacy cPanel cron still calls:

```text
/api/market/vault/settle-random
```

change its hostname only after the new endpoint returns the expected
authorization result. Do not print its bearer secret while editing or testing.

Add a redirect from `plank.tanggang.life` to `plank.love` last, after GitHub's
health check no longer depends on the old hostname.

## 11. Storage: PostgreSQL only (historical note)

**PostgreSQL is the only datastore.** There is no KV service, no Upstash, no
Redis. Do not add one, and do not write code against `KV_REST_API_URL`,
`KV_REST_API_TOKEN`, `@vercel/kv`, or `REDIS_URL`.

### How the cutover happened

The app was originally built against Upstash (Vercel KV) by an earlier
contributor. All marketplace data — the KV values, hash fields and set members
now living in `plank_kv_values`, `plank_kv_hash_fields` and
`plank_kv_set_members` — was migrated into PostgreSQL on InMotion in a single
transactional replacement, verified by reconciling destination row counts
against a read-only inventory of the source and by recording live V1/V2 vault
chain state on both sides of the switch. A mode-`600` `pg_dump` was taken first.

The migration tooling that performed it (`scripts/migrate-upstash-to-*.mjs`,
`scripts/lib/upstash-*.mjs`, the `inventory` / `cutover` workflow operations and
their tests) has since been **deleted** — the cutover is done and cannot
meaningfully be re-run. The table names still read "Redis-compatible" because
the schema deliberately preserved KV semantics during the move; that is a
description of the column shape, not a live dependency.

The legacy Redis and Upstash branches inside `lib/market/durable-kv.ts` are
likewise unused (`DURABLE_KV_BACKEND=postgres` in every environment) and are
slated for removal. They are retained for now only to avoid touching the
signed-order storage path in the same change.

Restores come from `pg_dump` backups (§13), not from the old KV service.

## 12. InMotion drand relayer

Every release contains:

```text
/home/CPANEL_USER/plank.tanggang.life/current/ops/drand-relayer/relay-drand.mjs
```

Dispatch `operation=provision-relayer`. The job:

1. transfers `RELAYER_PRIVATE_KEY` without printing it;
2. writes `shared/runtime-secrets/relayer.env`;
3. enforces directory mode `700` and file mode `600`;
4. refuses the key if it appears in Passenger's `.env.production`;
5. runs the relayer once and verifies every vault in `RELAY_VAULT_ADDRESSES`;
6. replaces old relayer cron lines while preserving unrelated jobs;
7. installs one managed one-minute cron through `current`; and
8. verifies that cron appended a structured status.

Managed entry:

```cron
* * * * * /usr/bin/flock -n /home/CPANEL_USER/plank.tanggang.life/shared/drand-relayer.lock /ABSOLUTE/NODE/BIN --env-file=/home/CPANEL_USER/plank.tanggang.life/shared/runtime-secrets/relayer.env /home/CPANEL_USER/plank.tanggang.life/current/ops/drand-relayer/relay-drand.mjs >> /home/CPANEL_USER/plank.tanggang.life/logs/drand-relayer.log 2>&1
```

The key is a dedicated gas-only wallet. It has no custody or contract-admin
authority. Owners must retain an offline backup.

`RELAY_VAULT_ADDRESSES` is the single source of truth for both relayers and
must contain every configured production vault, currently V3, V2, and V1, in
comma-separated form. Provisioning and scheduled relay fail closed if the
variable is missing, so a vault cannot silently be left out.

The GitHub scheduled workflow may overlap temporarily because submission and
settlement are permissionless and designed to be safe on repeated runs.
After at least 24 hours, dispatch:

```text
operation=verify-relayer
confirmation=DISABLE_GITHUB_RELAY
```

The verifier requires:

- at least 90% of expected one-minute successful runs;
- every configured vault in every structured status;
- no actionable or error state left behind;
- no fatal run in the 24-hour window; and
- a recent latest status.

Only then does the job disable `.github/workflows/relay-drand.yml` at the
repository level.

After the standalone cron is verified, remove any older HTTP curl settlement
cron so there is one production scheduler.

## 13. Maintenance and backups

Configure a daily cPanel cron using the cPanel Node executable:

```bash
/ABSOLUTE/NODE/BIN \
  --env-file=/home/CPANEL_USER/plank.tanggang.life/shared/.env.production \
  /home/CPANEL_USER/plank.tanggang.life/current/scripts/postgres-maintenance.mjs
```

This removes expired KV rows and expired orders.

### Market data refresh (required)

Every market snapshot — the royalty sales catalog, vault activity, rarity, the
trait index, the collection index — used to be rebuilt only by whichever user
request happened to find the key missing, or by a set of hand-run seed scripts
that still wrote to the pre-PostgreSQL datastore and therefore changed nothing
the app could see (§11). Those scripts are deleted; this cron replaces them.
Without it the sale surfaces drift stale and cold rebuilds land on user
requests.

Incremental, every 2 minutes — sales catalog and vault activity:

```cron
*/2 * * * * /usr/bin/flock -n /home/CPANEL_USER/plank.tanggang.life/shared/market-refresh.lock /ABSOLUTE/NODE/BIN --env-file=/home/CPANEL_USER/plank.tanggang.life/shared/.env.production /home/CPANEL_USER/plank.tanggang.life/current/scripts/refresh-market-data.mjs >> /home/CPANEL_USER/plank.tanggang.life/logs/market-refresh.log 2>&1
```

`flock -n` is non-blocking: if a run is still in flight when the next tick
fires, the new attempt exits immediately instead of queuing, so a shorter
interval can never pile up overlapping runs — it just self-limits back down
to "as often as a pass actually takes" on any tick where the previous one
ran long.

Full rebuild, once daily off-peak — adds rarity, traits and the collection index:

```cron
17 4 * * * /usr/bin/flock -n /home/CPANEL_USER/plank.tanggang.life/shared/market-refresh-full.lock /ABSOLUTE/NODE/BIN --env-file=/home/CPANEL_USER/plank.tanggang.life/shared/.env.production /home/CPANEL_USER/plank.tanggang.life/current/scripts/refresh-market-data.mjs --full >> /home/CPANEL_USER/plank.tanggang.life/logs/market-refresh.log 2>&1
```

`flock` matters: a full sales rebuild can run several minutes, and overlapping
runs would duplicate the upstream load the refresh exists to avoid. The script
exits non-zero only when every target fails, so one flaky upstream does not turn
a routine run red.

Verify after the first run:

```bash
tail -n 50 "$HOME/plank.tanggang.life/logs/market-refresh.log"
```

Expect `[refresh] backend=postgres` — if it says anything else, the cron is not
seeing the same storage the app reads, and its writes will be invisible.

### RPC budget

`GET /api/market/rpc-usage` reports outbound JSON-RPC calls and compute units
for the responding Passenger worker, with a projected monthly total against the
30M-CU provider free tier. It is per-process, so multiply by worker count. Use
it to attribute a rising bill to a specific code path instead of guessing from
the provider dashboard.

Use cPanel database backups and periodically test a restore. A release rollback
does not roll back database migrations or data.

Recommended checks:

```bash
tail -n 100 "$HOME/plank.tanggang.life/logs/passenger.log"
tail -n 100 "$HOME/plank.tanggang.life/logs/drand-relayer.log"
readlink "$HOME/plank.tanggang.life/current"
```

Do not output `.env.production`, `relayer.env`, crontab bearer values, or
runtime secret files during diagnostics.

## 14. Production acceptance

Before moving public traffic:

- `/api/health` reports `ok`, PostgreSQL, and the expected SHA.
- Root, `/market`, `/gallery`, `/learn`, `/mint`, and `/launch` render.
- Mobile and desktop wallet connection work.
- Existing migrated listings and offers appear.
- A new signed listing remains after a Passenger restart.
- Concurrent listings do not overwrite each other.
- Boards state remains consistent across repeated Passenger requests.
- IPFS image and metadata proxies work.
- The Uniswap API key is not present in browser assets or responses.
- `RPC_URL` is set to a private provider endpoint in `shared/.env.production`
  so server-side chain reads do not depend on the rate-limited public RPC.
- V1, V2, and V3 vault stats, held inventory, activity, and SSE update.
- Random redemption is idle or settled with no actionable request.
- Passenger logs show no restart loop or database-pool errors.
- PostgreSQL is not remotely exposed.
- A failed test release can restore the previous application symlink.
- Cloudflare Full (strict) works after proxying.
- The old hostname is redirected only after the new health URL is active.

## 15. Troubleshooting

### Default "It works" page

The hostname reaches Apache but is not attached to the Passenger app. Check the
cPanel domain document root and Node application URL. Do not create a second
copy of the app.

### Health returns 503

Check the Passenger log, `.env.production` permissions, PostgreSQL values, and
whether migrations applied. `/api/health` intentionally fails when no durable
backend is available.

### Health shows the previous SHA

Check the `current` symlink and `tmp/restart.txt`. Cloudflare and browser caches
must not be used as deployment proof; query `/api/health` with no-cache.

### `/market` loads but data APIs fail

Check PostgreSQL connectivity, the last-known-good snapshot rows, upstream RPC
limits, and Passenger request timeouts. Do not delete durable snapshots as a
first troubleshooting step.

### Relayer workflow remains active

This is expected until `verify-relayer` proves the full 24-hour window. Do not
disable the GitHub fallback only because a single InMotion run succeeded.
