# PIN-gated Plank game laboratory

> Entry flow superseded on 2026-08-28. The WebAuthn material below documents
> the first laboratory release; active testers now choose a username and use a
> one-use invitation. Each player chooses a personal four-digit PIN, while the
> host claims a personal six-digit PIN through a high-entropy setup URL. This adds audited,
> simulation-only controls.

## Official infrastructure, unofficial game

The laboratory deliberately runs inside the same supported delivery envelope
as RobinWood: the Next.js Passenger release, the official append-only migration
runner, the existing local PostgreSQL service, immutable SHA releases, pre-
migration backup, atomic activation, and Cloudflare edge. It does not introduce
another host, database, process supervisor, Redis service, or custody boundary.

That infrastructure reuse does **not** make the game official or valuable.
Every laboratory table is namespaced `playtest_*`; every balance is a test
credit; no route has a deployer, relayer, wallet, contract-write, faucet, or
mainnet settlement capability. `PLANK_PLAYTEST_ENABLED` defaults to `false`,
and disabled pages return not-found while mutations fail closed before storage.

## Security boundary

`/playtest` is a PIN-gated simulation surface. A hardened server session authenticates a
tester to the laboratory; it is not a wallet, transaction signer,
custody key, faucet entitlement, or authority over a production contract.
Simulation APIs must call `currentPlaytestIdentity()` independently. Hiding a
button or redirecting a page is never authorization.

WebAuthn parsing and cryptographic verification are delegated to the maintained
SimpleWebAuthn implementation. The server supplies a random, single-use,
five-minute challenge and verifies exact origin, RP ID, and user verification.
PostgreSQL stores COSE public keys and signature counters.

Sessions are opaque 256-bit random references. Only their SHA-256 hashes are
stored. Cookies are `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`, scoped
to `/`, and expire after twelve hours. Logout revokes server state.

## Production configuration

The normal InMotion deploy applies migrations `084_playtest_passkeys.sql` and
`085_playtest_live_rooms.sql` through `scripts/migrate-postgres.mjs`. Configure
the following GitHub repository variables and secret before releasing:

- variable `PLANK_PLAYTEST_ENABLED=true`;
- variable `PLANK_PLAYTEST_ORIGIN=https://plank.love` (or the currently
  verified canonical HTTPS origin until DNS cutover);
- variable `PLANK_PLAYTEST_RP_ID` matching that origin's registrable RP host;
- secret `PLANK_PLAYTEST_BOOTSTRAP_HASH` containing the SHA-256 digest of a
  high-entropy, one-use host setup credential.

The deployment workflow transfers these through `shared/runtime-secrets`,
atomically upserts `shared/.env.production` at mode `600`, runs the normal
pre-migration backup and migration gate, and restarts Passenger. Raw invitation
codes never enter GitHub, the release archive, command arguments, or logs.

Equivalent resulting runtime configuration:

```dotenv
PLANK_PLAYTEST_ORIGIN=https://plank.love
PLANK_PLAYTEST_RP_ID=plank.love
PLANK_PLAYTEST_BOOTSTRAP_HASH=<sha256-hex>
PLANK_PLAYTEST_ENABLED=true
```

Generate a high-entropy bootstrap credential once. The host uses its private
setup URL before invitations are issued; after the first claim, the database
transaction permanently closes bootstrap. Personal four/six-digit PINs are
scrypt-derived with independent salts and are never deployment configuration.
One safe PowerShell workflow for the bootstrap credential is:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$invite = [Convert]::ToBase64String($bytes)
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($invite))).ToLower()
```

Send `$invite` out-of-band and configure only `$hash`. The database uniqueness
constraint makes an invitation single-account under concurrent attempts.
Removing an unused hash prevents future registration. To revoke a tester, set
`playtest_users.disabled_at` and revoke their active session rows.

## Local production-parity check

Use PostgreSQL through Docker, apply all migrations, and configure:

```dotenv
PLANK_PLAYTEST_ORIGIN=http://localhost:3000
PLANK_PLAYTEST_RP_ID=localhost
PLANK_PLAYTEST_ENABLED=true
```

WebAuthn permits HTTP only for loopback development. Never configure an HTTP
public origin. Verify registration, logout, discoverable-credential sign-in,
challenge expiry/replay, invite reuse, disabled users, and separate browsers.

## Simulation-engine integration contract

Every room read, join, bet, cash-out, tick, settlement, replay, and export route
must authorize the cookie server-side and then verify room membership. The
deterministic engine should consume the same integer inputs and emit the same
accounting events as the contract reference model. Simulated balances and IDs
must remain in namespaced tables and be visibly labelled `SIMULATION — NO VALUE`.

Cookie-authenticated mutations require an exact `Origin` match against
`PLANK_PLAYTEST_ORIGIN`. Room commands carry UUID idempotency keys, lock the
room row, append an event, and update the snapshot in one PostgreSQL
transaction. After a timeout, refresh the snapshot/event log instead of
blindly repeating an economic command.

## Multiplayer room rehearsal

1. Register at `/playtest`, enter `/playtest/game`, and create a room.
2. Give the eight-character locator to already invited/passkey-enrolled
   friends. The code is not an authentication secret.
3. Each tester commits test credits and an auto-lock target. At least the
   policy minimum number of funded seats must exist before launch.
4. The owner launches. Public state contains the commitment and absolute
   start/crash timestamps while reveal and crash multiplier remain hidden.
5. Players lock manually. The UI acknowledges input immediately but labels a
   multiplier accepted only after the server transaction commits.
6. After the deadline any member can act as keeper. The laboratory Powerboard
   branch is derived from the already committed reveal, so the keeper cannot
   choose it after seeing the crash. Hosts retain explicit outcome buttons only
   for directed edge-case testing. PFSS, Heartwood, Powerboard, balances,
   reveal, and receipts update atomically.
7. Repeat indefinitely and inspect the append-only event history.

The laboratory crash mapping is deliberately a deterministic 1x–100x coverage
fixture, not the mainnet randomness distribution. Its protected-principal
split, lottery fee, and thresholds remain explicit experimental policy until
exact production constants are ratified.

Do not enable mainnet writes from this surface. A later mainnet UI may reuse
presentation and transaction construction, but wallets must sign each exact
on-chain action through the normal wallet boundary.

### Synthetic participant population

The six-digit host opens **SIM CONTROLS → SYNTHETIC PARTICIPANTS** between
rounds. Add 1–100 at a time (up to 500 active per table) using a named profile
or the mixed research distribution. Each CPU identity appears in the common
roster with its strategy and bankroll. Select any one bot, any checkbox batch,
or **SELECT ALL** to change its preset, stake/target bounds, enabled state, and
reference bankroll; balance reset is explicit and off by default. **REMOVE
SELECTED** removes only the selected laboratory actors after confirmation.

At launch, enabled bots make server-authoritative commitments from their own
balances before reveal generation. They cannot see or alter the crash. Their
wagers earn epoch-isolated linear Powerboard tickets exactly like human test
wagers. Invitees see the same CPU commitments, locks, settlements, jackpot
winner, and balances, but the simulation controls are not rendered for them
and every mutation is rejected server-side without the host role.

## Launch gate

- external WebAuthn and session review;
- PostgreSQL concurrency tests for invitation and ceremony consumption;
- CSRF review for every state-changing route;
- passkey recovery and revocation operator procedure;
- Cloudflare rate limits on ceremony endpoints;
- simulation-versus-contract differential tests;
- accessible status/error states and 390 px viewport review;
- explicit legal/compliance approval before real-value availability.

Primary references: W3C WebAuthn Level 3 §13.4, SimpleWebAuthn server
documentation, and the OWASP Session Management Cheat Sheet.
