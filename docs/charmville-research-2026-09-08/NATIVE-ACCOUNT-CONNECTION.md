# Account identity for the shared world

The account entrance now resolves an approved PlankSpace session through
`GET /api/charmville/session`. The response contains the stable PostgreSQL
profile ID, handle and session expiry. It does not contain a wallet, token,
inventory, region permission or permission to settle game rewards.

The endpoint hashes the bearer and checks current session expiry and profile
approval in PostgreSQL. Revocation or moderation changes take effect on the
next request. Responses are private and uncached. Error responses do not
include database details.

`createGameAccountClient` is used by the account entrance after its existing
profile-creation/approval checks. It uses a fixed relative endpoint,
same-origin fetch and refuses redirects. Credentials remain in its closure;
the module does not write browser storage, URLs, quest variables or messages.
The existing wallet authentication subsystem still owns its pre-existing
saved-session storage. Wallet changes and unmount invalidate in-flight
identity results, including transports that ignore abort.

## Remaining runtime integration

The reference adventure at localhost:3021 remains separate from the account
application at localhost:3017. Do not pass its bearer through a query string,
postMessage, the guest WebSocket or quest script variables. Its local reward
counters are not evidence for minting or inventory deposits.

Host the account-aware game shell on the application origin with a narrow
server API for action intents. Keep the runtime trust boundary explicit:
source quest code and arbitrary community scripts must not receive account
credentials. If embedded as an untrusted frame, sandbox it without same-origin
script privileges, and broker only explicit capabilities and validated
messages; do not give it a generic authenticated fetch bridge. The present
native runtime has not yet been adapted to that boundary.

The approved profile ID identifies the account. Home admission separately
uses `/api/charmville/{handle}/access`; neither knowing the ID nor possessing
a stale identity response grants entry, harvest, build or storage rights.
Every mutation must resolve current credentials and permissions server-side.
Passkey playtest UUIDs must not be merged with profile bigint IDs by display
name. Multi-wallet linking needs its own verified linking workflow.

Tests cover actual isolated PostgreSQL identity resolution, expired and
revoked sessions, pending profiles, credential-safe request configuration,
and delayed results after disconnect. This is an implemented account endpoint
and entrance integration, not an authenticated native MMO transport.
