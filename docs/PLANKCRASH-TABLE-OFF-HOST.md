# Running the PlankCrash table off the shared host (free)

The InMotion account hit its process/memory ceiling twice on 2026-09-14
(`fork: retry: Resource temporarily unavailable`; market-mesh at 2 GB), and the
table's three processes die with it. This runbook moves **chain + keeper +
invite gateway** to any machine you control (this workstation today, an
Oracle Always-Free / GCP e2-micro VM tomorrow) behind a **free Cloudflare
Tunnel**, while plank.love keeps every URL. Nothing here costs money.

## What is already prepared

| Piece | Where | State |
|---|---|---|
| Table runtime dir | `C:\Users\k1rby\plankcrash-table\` | `bin/anvil.exe` 1.8.1, `bin/cloudflared.exe` 2026.9.1, seeded `state/anvil-state.json` (TEST_RIG casino, fresh economy), `start-table.cmd`, `cloudflared.yml` |
| Keeper + gateway bundles | `.next/standalone/ops/plankcrash-table/*.mjs` (built from `dev`) | keeper honours `PLANK_PRACTICE_RPC_URL`; gateway honours `PLANK_INVITE_RPC_URL`/`STATE_DIR`/`PORT`/`PUBLIC_ORIGIN` |
| Site routing | `next.config.ts` + `inmotion.yml` | build-time `PLANK_INVITE_UPSTREAM` points `/table`, `/arcade/table.html`, `/api/invite/*`, the practice clock and the guest manifest at an external origin |
| Edge Worker (arcade assets off Passenger) | `edge/plankcrash-edge/` | dry-run validated; `npx wrangler deploy` |

## The three actions only you can take (each is blocked for the agent by policy)

1. **Create and run the tunnel** (uses the account whose cert is in `~/.cloudflared`; zone `gr0v3.online`):
   ```
   cd C:\Users\k1rby\plankcrash-table
   bin\cloudflared.exe tunnel create plank-table
   bin\cloudflared.exe tunnel route dns plank-table plank-table.gr0v3.online
   ```
   Put the printed tunnel UUID and credentials path into `cloudflared.yml`, then `start-table.cmd`
   (starts anvil :8547, keeper :8765, gateway :8766, tunnel). Check: `https://plank-table.gr0v3.online/api/invite/clock` → `{"nowMs":…}`.

2. **Point plank.love at it** (one repo variable + one site deploy):
   ```
   gh variable set PLANK_INVITE_UPSTREAM --body https://plank-table.gr0v3.online
   git push origin dev:master
   ```
   After the deploy, `https://plank.love/table` and `/api/invite/*` are served by the tunnel; the
   host's own table can be left to die or stopped (its cron line is harmless once nothing routes to it).

3. **Serve the arcade from the edge** (optional but removes Passenger from every asset request):
   ```
   cd edge/plankcrash-edge && node build.mjs && npx wrangler deploy
   ```

## Invite link
The gateway mints a new token on first start: `C:\Users\k1rby\plankcrash-table\state\invite-token.txt`.
Share `https://plank.love/table#invite=<token>`. (The host's old token is not carried over — the
state export was blocked by policy because it contains guest sessions.)

## Moving it to a free VM later
Same three processes under systemd, same `cloudflared.yml` with the VM's credentials file, same
`PLANK_INVITE_UPSTREAM`. Copy `state/` to carry the economy and the link.
