# InMotion cPanel Passenger deployment

This runbook deploys the `inmotion` branch to InMotion shared hosting using:

- `plank.tanggang.life`
- cPanel Node.js 22.22.3 and Passenger
- Local cPanel PostgreSQL
- Cloudflare DNS and TLS
- GitHub Actions build, migration, release, health check, and rollback

Docker is only the local verification environment. The shared server does not
run Docker, Redis, Valkey, PM2, or a custom reverse proxy.

Never commit or send database passwords, wallet private keys, API keys, SSH
private keys, or seed phrases.

## 1. Runtime architecture

```text
Cloudflare
    |
    v
plank.tanggang.life
    |
    v
InMotion cPanel / Passenger
    |
    +-- Next.js 16 standalone server (Node 22.22.3)
    |
    +-- PostgreSQL on localhost
          +-- indexed signed marketplace orders
          +-- served-order attribution
          +-- expiring cache values
          +-- transactional Boards state
```

The SQL store is not a custody or trade-execution engine. Makers sign Seaport
orders in their wallets and fulfillment occurs on-chain. PostgreSQL stores and
indexes those signed orders so Passenger workers share one authoritative book.

## 2. Local Docker verification

Create a local secret file:

```powershell
Copy-Item .env.docker.example .env.docker.local
```

Set a unique local `POSTGRES_PASSWORD`, then build and start:

```powershell
docker compose --env-file .env.docker.local -f docker-compose.inmotion.yml up -d --build
docker compose --env-file .env.docker.local -f docker-compose.inmotion.yml ps
```

The migration container applies pending SQL before the app starts. Verify:

```powershell
curl.exe --fail http://127.0.0.1:3000/api/health
curl.exe --fail http://127.0.0.1:3000/market
```

PostgreSQL data remains in the `postgres_data` Docker volume across app
rebuilds and restarts.

## 3. Domain and Cloudflare

In cPanel, add `plank.tanggang.life` under **Domains** before creating the
Node.js application. It must appear in the Application URL dropdown.

cPanel creates the subdomain's separate document-root directory at
`/home/CPANEL_USER/plank.tanggang.life`. Use that same directory as the
Passenger application root and CI release root. The web document root and the
Passenger application root are separate settings, but aligning them avoids an
unnecessary second application directory.

In Cloudflare:

1. Add the `plank` DNS record pointing to the InMotion account's assigned
   address.
2. Start DNS-only while cPanel provisions the hostname and certificate.
3. After direct HTTPS works, use Cloudflare SSL/TLS **Full (strict)** and
   enable the proxy if desired.

Do not use the path form `tanggang.life/plank`; the application is designed for
the subdomain root.

## 4. PostgreSQL

Create the database and application user with **PostgreSQL Database Wizard**,
then grant the user all privileges on that one database. cPanel prefixes both
names with the account username.

Keep these non-secret values for setup:

```dotenv
PGHOST=localhost
PGPORT=5432
PGDATABASE=CPANEL_PREFIX_plank
PGUSER=CPANEL_PREFIX_plankapp
PGPOOL_MAX=4
PGSSLMODE=disable
```

Store the password only in the server environment file. `PGPOOL_MAX=4` limits
each Passenger process to a small pool suitable for shared hosting.

## 5. Dedicated deployment SSH key

Do not reuse or download a personal private key already stored in cPanel.
Generate a dedicated GitHub deployment key on a trusted workstation:

```powershell
ssh-keygen -t ed25519 `
  -f "$env:USERPROFILE\.ssh\plank_inmotion_deploy" `
  -C "github-actions-plank-inmotion"
```

Import only the `.pub` file under **cPanel → Manage SSH Keys**, then authorize
it. Store the private file's complete contents later as the GitHub environment
secret `INMOTION_SSH_KEY`.

Test the key using the InMotion hostname. Shared hosting commonly uses port
2222:

```powershell
ssh -i "$env:USERPROFILE\.ssh\plank_inmotion_deploy" `
  -p 2222 CPANEL_USER@SERVER_HOSTNAME
```

Verify the server host-key fingerprint through the account or InMotion support
before trusting it. Store the verified `known_hosts` line in
`INMOTION_HOST_KEY`; do not blindly trust an unverified `ssh-keyscan` result.

## 6. Server directories and secrets

Over SSH:

```bash
mkdir -p "$HOME/plank.tanggang.life"/{incoming,releases,shared,tmp,logs}
chmod 700 "$HOME/plank.tanggang.life/shared"
```

Copy `.env.inmotion.example` to:

```text
/home/CPANEL_USER/plank.tanggang.life/shared/.env.production
```

Fill it directly on the server and apply:

```bash
chmod 600 "$HOME/plank.tanggang.life/shared/.env.production"
```

The file is not uploaded or overwritten by CI. It contains the PostgreSQL
password and all runtime-only secrets. `NEXT_PUBLIC_*` values are also
configured as GitHub repository variables because Next.js embeds them during
the build.

## 7. Create the Passenger application

In **cPanel → Setup Node.js App → Create Application**:

```text
Node.js version:          22.22.3
Application mode:         Production
Application root:         plank.tanggang.life
Application URL:          plank.tanggang.life
URL path:                 blank
Application startup file: passenger.cjs
Passenger log file:       /home/CPANEL_USER/plank.tanggang.life/logs/passenger.log
```

The first CI release installs `passenger.cjs`. It loads the stable shared env
file, resolves the active release, and starts Next.js' generated standalone
server. Passenger supplies the port and owns the process lifecycle.

After creating the application, cPanel displays a command for entering its
Node virtual environment. Use it to determine the Node executable and verify:

```bash
which node
node --version
```

The resulting absolute executable path becomes the GitHub repository variable
`INMOTION_NODE_BIN`.

## 8. GitHub configuration

Create a GitHub Environment named `inmotion-staging`.

Environment secrets:

- `INMOTION_HOST`
- `INMOTION_PORT` (normally `2222`)
- `INMOTION_USER`
- `INMOTION_SSH_KEY`
- `INMOTION_HOST_KEY`

Repository variables:

- `INMOTION_DEPLOY_ENABLED` — leave `false` until first-deploy preparation is
  complete
- `INMOTION_APP_DIR` — absolute path such as
  `/home/CPANEL_USER/plank.tanggang.life`
- `INMOTION_NODE_BIN` — absolute Node 22.22.3 executable shown by cPanel
- `INMOTION_HEALTH_URL=https://plank.tanggang.life`
- Every `NEXT_PUBLIC_*` value from `.env.inmotion.example`

The PostgreSQL password, relayer private key, Uniswap API key, and cron secret
remain only in the server's `.env.production`.

## 9. CI/CD behavior

Pull requests to `inmotion` or `master` run:

- Locked dependency install
- Deployment lint
- TypeScript
- Marketplace and contract tests
- Production Next.js build

A push to `inmotion` packages `.next/standalone`. When
`INMOTION_DEPLOY_ENABLED` is exactly `true`, the deploy job:

1. Uploads an immutable release named by commit SHA.
2. Runs pending PostgreSQL migrations with server-side credentials.
3. Atomically changes the `current` release symlink.
4. Touches `tmp/restart.txt` so Passenger reloads.
5. Checks PostgreSQL through `/api/health` and renders `/market`.
6. Restores the previous release automatically if health checks fail.

The workflow builds on GitHub, not the shared server.

## 10. Existing Upstash data

Open Seaport orders are off-chain. If the current site has live listings or
offers, obtain the existing Upstash credentials before cutover.

Inventory without writing:

```bash
node --env-file=.env.production scripts/migrate-upstash-to-postgres.mjs
```

During an approved write freeze:

```bash
node --env-file=.env.production \
  scripts/migrate-upstash-to-postgres.mjs --apply
```

The importer maps listings and offers into indexed SQL rows, imports served
order hashes, and copies expiring cache keys. Existing destination rows are
not overwritten unless `--overwrite` is explicitly supplied.

## 11. Maintenance and backups

Configure a daily cPanel Cron Job using the cPanel Node executable:

```bash
/ABSOLUTE/NODE/BIN \
  --env-file=/home/CPANEL_USER/plank.tanggang.life/shared/.env.production \
  /home/CPANEL_USER/plank.tanggang.life/current/scripts/postgres-maintenance.mjs
```

This removes expired cache entries and orders. Use cPanel's database backup
facilities and periodically test a restore. A release rollback does not roll
back database migrations or data.

## 12. Acceptance

Before enabling public traffic:

- Root, `/market`, `/gallery`, `/learn`, `/mint`, and `/launch` render.
- Mobile and desktop wallet connection work.
- Existing migrated listings appear.
- A new signed listing remains after a Passenger restart.
- Concurrent listings do not overwrite each other.
- Boards state remains consistent across repeated Passenger requests.
- IPFS image and metadata proxies work.
- Uniswap quote/swap routes do not expose the API key.
- Vault stats, held inventory, activity, and SSE update.
- Passenger logs contain no repeated restart or database-pool errors.
- PostgreSQL is not remotely exposed.
- CI health failure successfully restores the prior release.
