# Private game API admission coverage

Source audit: 2026-09-13. This is code coverage evidence, not a remote deployment or penetration-test certificate. No production credentials, migrations, or configuration were changed by this audit.

All paths below are under `/api/charmville`. Authorization runs in the backing server function, not merely in a client menu. Private admission means an approved, live PlankSpace session plus an explicit configured admin/wallet allowlist or a current, unrevoked profile grant. Production defaults closed.

| Route family | Methods | Server admission boundary |
|---|---|---|
| `[handle]` | GET, POST | `readYard` → viewer admission; mutation actor → admission |
| `[handle]/access` | GET, POST | `homeActor` → admission; separate owner/home rights remain required |
| `world/actor`, `world/presence`, `world/resources`, `world/encounter`, `world/capture`, `world/battle` | GET, POST | `homeActor` → admission before gameplay state/commands |
| `world/battle/assist` | POST | `homeActor` → admission, then nearby-party permissions |
| `companions`, `companions/vitals`, `companions/rest`, `creature-roster` | GET, POST | `homeActor` → admission |
| `journey` | GET | `homeActor` → admission |
| `tutorial` | GET, POST | `homeActor` → admission |
| `session` | GET | `readGameSession` → current admission |
| `exchange` | GET, POST | viewer admission for reads; transaction actor admission for mutations |
| `reputation` | GET | viewer admission before scoped post/reaction search |
| `social` | GET, POST | approved session + admission before feed/owned basket/pin transaction |
| `spectate/[handle]` | GET, PUT | viewer admission plus current host admission, then audience policy |
| `runtime-session` | POST | approved session + admission before issuing short-lived HttpOnly ticket |
| `invites` | GET, POST | approved session + explicit Charmville admin role |
| `invites/redeem` | POST | deliberate enrollment exception: approved session, enabled deployment, valid single-use invitation and current issuer admin authority; no pre-existing admission grant required |
| `local-playtest` | POST | deliberate local fixture exception: development mode + localhost/origin + explicitly matched isolated database; never enabled for production |
| `local-playtest/party` | GET, POST | same local fixture gate, then `homeActor` and trusted synthetic-account marker; unavailable capabilities response contains no game/account state |

## Corrections made in this audit

Previously public read entrypoints (`readYard`, `readExchange`, `searchPineReputation`, `spectatorView`) now perform their admission query inside the transaction that reads their data. This removes the separate connection/snapshot between admission and data access.

Both `spectatorView` and `broadcastAuthority` now recheck the host's admission. An admitted viewer cannot continue resolving a revoked host's broadcast policy just because the viewer remains admitted.

The two targeted coverage tests pass: denied viewers cannot reach game data queries across the four read functions; revoked hosts cannot reach spectator policy reads through either resolver. Targeted ESLint passed. These tests exercise the real functions with database test doubles; they do not replace PostgreSQL or remote verification.

## Socket and native-artifact boundaries

`scripts/charmville/serve-world-socket.mjs` remains loopback-only. It authenticates through the protected `world/actor` endpoint, forwards each movement command there, and rereads protected actor/encounter state on its tick loops. Revoked admission therefore denies subsequent commands/reads and closes the connection; it is not a durable admission cache.

`broadcastAuthority` calls `homeActor` for the connection-bound account and checks host admission and viewing settings every resolution. No public media relay is implied by this helper.

`openProtectedRuntimeArtifact` validates the current ticket, original session and current admission before opening manifest files, including HEAD. A protected route must use this composition boundary; independently served old ports, copied public assets, CDN mirrors and browser-cached bytes are not retroactively protected by this helper.

## Remaining release checks

- Verify the actual remote reverse proxy does not expose old native ports or an unguarded static game copy.
- Verify private API denial and authorized success on the deployed domain, including logout, expired grants and websocket disconnection.
- Verify cache/CDN behavior does not serve authenticated assets to anonymous callers.
- Public PlankSpace login/social routes are intentionally outside this game-admission inventory. Admission does not replace content visibility, home permission, block lists, ownership or economic authorization.
- Revoked actors may remain in already delivered client snapshots until authoritative refresh/presence expiry. Immediate eviction and peer-list filtering are a separate multiplayer propagation acceptance check.
