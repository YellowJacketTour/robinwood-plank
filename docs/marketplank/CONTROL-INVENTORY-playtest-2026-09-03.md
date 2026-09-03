# PlankCrash playtest — player control inventory (2026-09-03)

Surface: `public/arcade/crash.html` served inside the `/playtest/game` iframe (`body[data-playtest="true"]`).
Verified by `test/e2e-playtest/control-inventory.spec.ts` against the real Next.js dev server + real PostgreSQL:
ONE host (desktop 1280×720 → 1920×1080) + ONE guest (iPhone emulation 390×844 → 430×932, touch, DSF 3),
three automatic rounds (round 1 host-launched, rounds 2–3 auto-launched from the settled intermission), every
row measured per phase: PRESENT (visible), REACHABLE (≥44 px min dimension on mobile, centre point not covered by
another element via `elementFromPoint`, LOCK centre inside the bottom 45 % of the mobile viewport during flight,
critical controls inside the viewport without scrolling), FUNCTIONAL (server-side effect asserted through the
room snapshot: seat committed with exact stake/target/auto-lock, `acceptedTargetBps` granted, `nextRoundSeats`).

Phases: **L** lobby · **C** committed (pre-launch, or queued in the intermission) · **F** flight · **K** locked · **S** settled/receipt · **I** intermission.
Verdicts are BEFORE → AFTER this session's fixes (✅ pass · ❌ gap · — n/a).

| Control / accessory | Element (crash.html) | Phases | Mobile placement | Desktop placement | PRESENT-MOBILE | PRESENT-DESKTOP | REACHABLE | FUNCTIONAL |
|---|---|---|---|---|---|---|---|---|
| Stake chips 500 / 1K / 5K / 10K credits | `#stakeRow .chip[data-amt]` | L C F K I (disabled outside the betting window) | deck below stage | deck bottom-centre | ✅→✅ | ✅→✅ | ❌→✅ (31 px tall on phones → 44 px) | ✅→✅ (5,000 committed) |
| Custom stake entry | `#privateCustomStake` (new) | L C F K I | deck stake row | deck stake row | ❌→✅ | ❌→✅ | —→✅ | ❌→✅ (1,234 committed exactly; min = policy `minimumStake`) |
| Balance readout | `#privateBalanceReadout` (new; before only `#btnSub` while betting-open) | L C F K I | deck under the stake quote | same | ❌→✅ | ❌→✅ | —→✅ | ❌→✅ (server balance every snapshot) |
| Auto-lock toggle | `#privateAutoLockChip` | L C F K I (refuses after launch) | deck auto row | deck auto row | ✅→✅ | ✅→✅ | ❌→✅ (31 px → 44 px; on desktop the DISMISSED reveal card's `.private-result-next` still intercepted taps → pointer events scoped to `.result-card.show`) | ✅→✅ (pre-launch disarm = server amendment; mid-flight refused) |
| Cash-out target input | `#autoTargetInput` | L C F K I | deck auto row | deck auto row | ✅→✅ | ✅→✅ | ❌→✅ (35 px → 44 px) | ❌→✅ (pre-launch change now re-commits `requestedTargetBps`; before it silently diverged from the server seat) |
| REPEAT last bet | `#autoToggle` | L C F K I | deck auto row | deck auto row | ✅→✅ | ✅→✅ | ❌→✅ (33 px → 44 px) | ❌→✅ (never re-committed in the settled intermission — rounds ≥2 never pass through `lobby`; now queues the same stake/target, proven in `nextRoundSeats` for rounds 2 and 3) |
| COMMIT + pending→committed feedback + rejection reason | `#primaryBtn` (`betting-open`), `#btnSub`, toast | L I | deck (sticky in thumb zone) | deck | ✅→✅ | ✅→✅ | ❌→✅ (below the fold and under the table-sheet bar on 390×844 → `html` is the phone scroller, sticky primary, auto-scroll on phase change; toasts made click-through) | ✅→✅ (`PLACING BET…` → `READY FOR ROUND n`; server message toasted) |
| Committed-state indicator (stake + armed target through countdown) | `#primaryBtn` (`waiting`) + `#btnSub` | C I | deck | deck | ✅→✅ | ✅→✅ | ✅→✅ | ❌→✅ (`1,234 cr committed · target 2.50× · auto-lock off` from the server seat; button `READY FOR ROUND n` in the lobby too) |
| Manual LOCK showing the live lagged multiplier | `#primaryBtn` (`live-hold`) | F | deck thumb zone | deck | ✅→✅ | ✅→✅ | ❌→✅ (centre y ≈ 0.9·vh on 390/430) | ❌→✅ (label was static `LOCK CLAIM WEIGHT NOW`; worse, a quiet flight left the button stuck at `WAITING FOR LAUNCH…` because the ignition-hold state was only re-evaluated on a new snapshot → now frame-derived `LOCK NOW · x.xx×` from the lagged clock) |
| Lock feedback pending → LOCKED x× / too-late | `#primaryBtn` (`cashed`) + `#btnSub` + toast | F K | deck | deck | ✅→✅ | ✅→✅ | ✅→✅ | ✅→✅ (grant toast = server `acceptedTargetBps`; crash-beat-the-tap falls closed, no LOCK re-offered) |
| Post-lock state (locked at x×, no further lock) | `#primaryBtn` disabled + `#btnSub` `Locked at x.xx×` | K | deck | deck | ✅→✅ | ✅→✅ | ✅→✅ | ✅→✅ (an executed auto target also flips to LOCKED per frame) |
| Round result / receipt (crash ×, own lock, payout, net) | `#resultCard.private-result.show` | S | full-screen sheet | centred card | ✅→✅ | ✅→✅ | ✅→✅ | ✅→✅ |
| Countdown to next launch | `#privateIntermissionCountdown` + `#substatus` | I | stage top-centre | stage top-centre | ✅→✅ | ✅→✅ | ✅→✅ | ✅→✅ (`nextLaunchAt`) |
| My next-round commitment queued | `#primaryBtn` `READY FOR ROUND n` + `#btnSub` | I | deck | deck | ✅→✅ | ✅→✅ | ✅→✅ | ❌→✅ (**server**: `nextRoundSeats` queried `room.current_round + 1` on a pg bigint STRING → `"11"`, so the queue was always empty; fixed in `lib/playtest-rooms.ts`) |
| Who else is committed / queued (readiness, auto targets) | `#privateRoster .private-player` | L C F K I | table sheet (`#privateTableToggle`, fixed bottom) | right panel | ✅→✅ | ✅→✅ | ✅→✅ | ❌→✅ (queued players never listed — same server bug; also said "auto-lock armed" for manual lockers → now "manual lock") |
| Auto-launch / "commitments close at launch" notice | `#substatus` | I | stage | stage | ✅→✅ | ✅→✅ | ✅→✅ | ✅→✅ |
| Table / players sheet toggle | `#privateTableToggle` | L C F K I | fixed bottom bar | — (panel always open) | ✅→✅ | — | ✅→✅ | ✅→✅ |
| Phase guide | `#privatePhaseGuide` | L C F K I | table sheet | panel | ✅→✅ | ✅→✅ | ✅→✅ | ✅→✅ |
| Invite code + copy link | `#privateJoinCode`, `#privateCodeCopy` → `#privateInvite` | L C F K I | table sheet | panel | ✅→✅ | ✅→✅ | ✅→✅ | ❌→✅ (guests were offered COPY LINK that only errors "Host account required" → disabled `HOST SHARES LINK`; the host control issues the real link) |
| New table | `#privateNewTable` | L C F K I | table sheet (admin) | panel (admin) | ✅ | ✅ | ✅ | ✅ |
| Leave table | `#privateLeaveTable` | L C F K I | table sheet | panel | ✅→✅ | ✅→✅ | ✅→✅ | ✅→✅ |
| Powerboard status (prize, funded %, my weight / odds) | `#pbStat` (`#pbTickets`, `#pbJackpot`) → `#pbPopover` | L C F K I | topbar | topbar | ✅→✅ | ✅→✅ | ❌→✅ (chip < 44 px on phones) | ✅→✅ |
| Vault / RTP / pool header | `#vaultStat`, `#rankStat`, `#poolStat` | L C F K I | topbar (pool hidden on phones) | topbar | ✅→✅ | ✅→✅ | ✅→✅ | ✅→✅ |
| Sound toggle | `#sfxBtn` (+ `#privateSound` in menu) | L C F K I | topbar gear | topbar gear | ✅→✅ | ✅→✅ | ❌→✅ (38 px → 44 px) | ✅→✅ (`aria-pressed` flips) |
| How-to-play / game menu / system & math | `#privateHowButton`, `#privateMenuButton`, `a[href*=plankcrash-system]` | L C F K I | table sheet | panel | ✅→✅ | ✅→✅ | ✅→✅ | ✅→✅ |

## Run notes

**BEFORE (master 8189c2d, first runs of the spec):** commit via the button ended on `WAITING FOR LAUNCH…` with no stake/target shown;
no custom stake, no balance readout; on 390×844 the primary action sat below the fold behind the table-sheet bar; flight label
static and, on a quiet flight, stuck at `WAITING FOR LAUNCH…`; REPEAT did nothing in the intermission; `nextRoundSeats` empty
server-side (string concatenation); dismissed reveal card intercepted desktop taps; toasts intercepted phone taps; touch targets
31–38 px; guest COPY LINK errored.

**AFTER (run 12):** `1 passed (2.5m)`, `[control-inventory] 0 gap(s)` across lobby / committed / flight / locked / settled /
intermission on m390, m430, d1280, d1920; manual lock granted at the displayed multiplier (round 1 m390, round 3 m390; the
d1920 tap in round 2 raced a ~2 s flight and the UI fell closed as required); REPEAT queued rounds 2 and 3; custom stake 1,234
committed exactly; pre-launch target amendment re-committed; mid-flight auto-lock/target changes refused.

Observed once (run 11, not reproduced): the very first bet after a dev-server restart answered `404` although the room and both
memberships existed; the UI surfaced it honestly and fell back to `COMMIT`. Worth a follow-up look at `lockedRoom` right after boot.
