# InMotion VPS deployment

This runbook deploys plank.love as a standalone Next.js 16 container with a
private, persistent Valkey service. It is intended for an InMotion VPS or
dedicated server with root access. It is not a shared-hosting Passenger
runbook.

No private key or API secret belongs in Git, a Docker image, or a support
message. Store runtime secrets only in `/opt/plank-love/.env.inmotion` on the
VPS and in GitHub's encrypted environment secrets where CI/CD needs them.

## 1. Information required before touching the account

Provide these non-secret facts:

- Exact InMotion product/plan name.
- VPS operating system and version.
- Whether the server is managed through cPanel/WHM.
- Whether root SSH is enabled.
- Server CPU architecture (`uname -m`), RAM, disk, and public IP.
- Whether Docker Engine and Docker Compose v2 are already installed.
- Which web server currently owns ports 80/443: nginx, Apache, cPanel nginx,
  or none.
- Whether `plank.love` DNS is still managed through Cloudflare.
- Whether the GitHub repository/package will be public or private.
- Whether the first VPS cutover should keep the existing Upstash store before
  moving data into Valkey.

Do not send SSH private keys, Redis passwords, wallet keys, API keys, or seed
phrases. Those will be placed directly in the appropriate secret stores.

## 2. Deployment model

```text
Internet / Cloudflare DNS
        |
        v
InMotion nginx or cPanel reverse proxy (TLS)
        |
        v
127.0.0.1:3000 -> Next.js standalone container
                         |
                         v
                 private Docker network
                         |
                         v
              Valkey + persistent volume
```

The application port binds to loopback by default. Valkey has no published
host port. The `app` filesystem is read-only except for:

- `/app/.next/cache` — persistent Next image/ISR cache.
- `/app/data` — the legacy Boards JSON state.
- `/tmp` — bounded in-memory temporary storage.

Valkey uses append-only persistence (`appendfsync everysec`) plus RDB
snapshots in the `valkey_data` Docker volume.

## 3. First server setup

The exact package-install commands depend on the VPS OS and cPanel status.
After Docker is installed, verify:

```bash
docker version
docker compose version
```

Create the deployment directory and check out the `inmotion` branch so a
manual image build has the complete Docker build context:

```bash
sudo install -d -m 0750 /opt/plank-love
sudo chown "$USER":"$USER" /opt/plank-love
git clone --branch inmotion --single-branch \
  https://github.com/YellowJacketTour/robinwood-plank.git \
  /opt/plank-love
cd /opt/plank-love
```

If `/opt/plank-love` already exists, clone to a temporary directory and copy
the checkout into it, preserving the server-owned `.env.inmotion`; do not
clone over a non-empty deployment directory.

Create the real environment file:

```bash
cp .env.inmotion.example .env.inmotion
chmod 600 .env.inmotion
openssl rand -base64 48
```

Put the generated value in `VALKEY_PASSWORD`. Fill all other public settings
and server secrets directly on the VPS. Validate without printing resolved
secret values into CI logs:

```bash
docker compose \
  --env-file .env.inmotion \
  -f docker-compose.inmotion.yml \
  config --quiet
```

## 4. Local image build and first boot

For the initial manual deployment:

```bash
cd /opt/plank-love
docker compose \
  --env-file .env.inmotion \
  -f docker-compose.inmotion.yml \
  build app

docker compose \
  --env-file .env.inmotion \
  -f docker-compose.inmotion.yml \
  up -d
```

Check containers and loopback health:

```bash
docker compose \
  --env-file .env.inmotion \
  -f docker-compose.inmotion.yml \
  ps

curl --fail --show-error http://127.0.0.1:3000/api/trade/status
curl --fail --show-error http://127.0.0.1:3000/market
```

Do not change public DNS until the local health checks, logs, order reads,
IPFS proxy, Uniswap status, and vault SSE stream have all been tested.

## 5. Reverse proxy and TLS

`deploy/inmotion/nginx.plank.love.conf.example` is a starting point for a
plain nginx VPS. It:

- Proxies the site to loopback port 3000.
- Preserves the original host/protocol/client headers.
- Limits request bodies at the proxy.
- Disables buffering for `/api/market/vault/stream`.
- Allows the stream to live slightly longer than the app's 290-second cycle.

If cPanel/WHM manages nginx or Apache, do not overwrite its generated vhost.
The final include path and reload commands must be selected after the account
layout is known.

## 6. Order-book cutover without data loss

Open Seaport orders are off-chain. They exist in the current Upstash store,
not in Git and not reconstructably on-chain.

The safest cutover is two phases:

1. Deploy the VPS with `DURABLE_KV_BACKEND=upstash` and the existing
   `KV_REST_API_URL` / `KV_REST_API_TOKEN`. Both old and new hosts then share
   one order book during DNS propagation.
2. After all traffic reaches the VPS, schedule a brief write freeze, copy the
   data to Valkey, switch `DURABLE_KV_BACKEND=redis`, restart the app, and
   verify counts before removing Upstash credentials.

Inventory the source keys without writing:

```bash
docker compose \
  --env-file .env.inmotion \
  -f docker-compose.inmotion.yml \
  --profile tools run --rm kv-migrate
```

During the approved write freeze, copy into an empty destination:

```bash
docker compose \
  --env-file .env.inmotion \
  -f docker-compose.inmotion.yml \
  --profile tools run --rm kv-migrate \
  node scripts/migrate-upstash-to-redis.mjs --apply
```

The migration refuses to overwrite an existing destination key. `--overwrite`
must be added explicitly if replacement is intentional. It copies only
`plank:market:*` string, hash, and set keys and preserves positive TTLs.

After verifying the new book, set:

```dotenv
DURABLE_KV_BACKEND=redis
KV_REST_API_URL=
KV_REST_API_TOKEN=
```

Then recreate only the app:

```bash
docker compose \
  --env-file .env.inmotion \
  -f docker-compose.inmotion.yml \
  up -d --no-build app
```

Remove real Upstash credentials from the VPS after rollback is no longer
needed.

## 7. Backups

The Valkey volume is production data. A Docker volume on the same VPS is not
a backup. At minimum:

1. Trigger and verify a Valkey background save.
2. Archive the `valkey_data` volume.
3. Encrypt and copy the archive off the VPS.
4. Test a restore into a separate Valkey instance.

The exact backup destination will be chosen from InMotion Backup Manager,
object storage, or another off-server system after the account is known.

Before any backup:

```bash
docker compose \
  --env-file .env.inmotion \
  -f docker-compose.inmotion.yml \
  exec -T valkey sh -c \
  'valkey-cli --no-auth-warning -a "$VALKEY_PASSWORD" BGSAVE'
```

## 8. GitHub Actions CI/CD

`.github/workflows/inmotion.yml` performs:

- Locked `npm ci`.
- Deployment/storage lint, TypeScript, marketplace/contract tests, and a
  production build.
- A versioned Docker image build and push to GHCR.
- Optional SSH deployment to InMotion.
- Container health verification after rollout.

CI runs immediately. Production deployment remains disabled until repository
variable `INMOTION_DEPLOY_ENABLED` is exactly `true`.

Repository variables:

- `INMOTION_DEPLOY_ENABLED`
- `INMOTION_APP_DIR` (normally `/opt/plank-love`)
- Every `NEXT_PUBLIC_*` build value used in `.env.inmotion.example`

GitHub environment secrets for `inmotion-production`:

- `INMOTION_HOST`
- `INMOTION_PORT` (usually `22`)
- `INMOTION_USER`
- `INMOTION_SSH_KEY`
- `INMOTION_HOST_KEY` (trusted `known_hosts` line, not an unverified scan)
- `GHCR_READ_TOKEN` for a private image package
- `GHCR_READ_USER`

The server's `.env.inmotion` remains authoritative for runtime-only secrets.
They are not passed to `docker build`.

The repository-wide `npm run lint` currently has a pre-existing error
baseline outside this deployment work. CI gates the files introduced or
changed for InMotion while still requiring the full TypeScript, test, and
production-build checks.

## 9. Rollback

Every image is tagged with its commit SHA. To roll back:

```bash
cd /opt/plank-love
export PLANK_IMAGE=ghcr.io/OWNER/REPO:PREVIOUS_SHA
docker compose \
  --env-file .env.inmotion \
  -f docker-compose.inmotion.yml \
  pull app
docker compose \
  --env-file .env.inmotion \
  -f docker-compose.inmotion.yml \
  up -d --no-build app
```

Changing the image does not roll back or delete Valkey data. Storage rollback
is a separate, explicit recovery operation.

## 10. Production acceptance

Before calling the move complete:

- Root, `/market`, `/gallery`, `/learn`, `/mint`, and `/launch` render.
- Mobile and desktop wallet connection work.
- An existing listing is visible after the store migration.
- A new signed listing persists across an app container restart.
- IPFS image and metadata proxies return expected content.
- Uniswap status/quote routes behave without exposing the API key.
- Vault stats, held inventory, activity, and SSE update.
- Random redemption has a working relayer/settle path.
- Valkey is unreachable from the public Internet.
- TLS, DNS, logs, health checks, backup, and rollback are verified.
