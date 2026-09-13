# Source-backed bounded battle turns

The authenticated encounter now supports a narrow real turn service at `/api/charmville/world/battle`. An owned roster starter uses its supported source move: Treecko Pound, Torchic Scratch or Mudkip Tackle; Poochyena uses Tackle. The service persists HP and PP and returns a turn result including damage, miss and critical-hit observations. These results come from the server, not UI-supplied damage or RNG.

The contextual encounter panel shows original first-frame source portraits, HP, source move names, PP and readable committed-turn results. Fainted companions and zero-PP moves cannot be selected. A synchronous pending-command guard prevents duplicate clicks; an ambiguous response retains the exact request UUID and payload for retry. The successful turn emits only a read-only refresh notification: the Party panel re-fetches authoritative health and does not trust event data.

`verify-battle-panel.mjs` passed against the actual service. It commits a real turn, drops its HTTP response, retries the identical request, and verifies one turn/one PP debit and the same HP outcome. Switching to Party shows the newly persisted HP without manual refresh. Source portrait and narrow-screen result presentation were inspected. TypeScript and focused lint passed.

This is a locally connected limited turn battle, not native real-time sword combat or a complete Emerald engine. Full source move coverage, status effects, native attack animations, capture, rewards, revival, AI and PvP remain absent. Portraits are not presented as attack animations. Test-generated accounts and source-backed RNG outcomes do not imply injuries were fabricated for user accounts.
