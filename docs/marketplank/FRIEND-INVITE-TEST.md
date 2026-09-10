# Friend invite test

The invite gateway is a free, shared contract simulation on local chain 31337. Every guest gets a separate random wallet, 0.05 simulated ETH and 5,000 test PLANK. No deposit, external wallet, or purchase is needed. Balances have no cash value. The automatic rounds, capped crash settlements, vault accounting, numbered lottery and animations use the current local contract graph. Randomness and infrastructure remain local test mocks, not production drand.

Opening an invite starts repeating free bets at the minimum stake. Pause and Invite are visible in the control dock. A paused preference survives reload, and the same browser session retains its wallet. Stake, target, lottery collection and fuel controls use contract responses. The funded fuel prototype burns test PLANK; it does not buy better personal odds. Refill is available below 0.005 simulated ETH once per ten minutes.

## Operations

Keep the existing Hardhat node on loopback 8545 and `scripts/local-arcade-preview.ts` (keeper and preview, loopback 8765) running. Do not reset a node containing an active test. Run `npx tsx scripts/invite-arcade-preview.ts` with `PLANK_INVITE_STATE_DIR` set to a private scratch directory. It saves `invite-token.txt` there and listens only on loopback 8766. Point a test tunnel exclusively at 8766, with an explicit isolated tunnel config; never tunnel 8545 or 8765.

Share `https://<test-host>/#invite=<token>`. The game also has a Copy Invite button. The fragment is exchanged for a 24-hour HttpOnly, SameSite=Strict session; HTTPS sessions use Secure cookies. Tokens and guest keys must not be checked in. Restarting the gateway rotates the invite and clears its in-memory guest sessions. Closing the browser alone does not clear the session cookie. Quick tunnels change address when restarted, depend on this computer and its network, and are a temporary friend test rather than permanent hosting.

## Boundaries

- Local-chain check and test manifest are mandatory at startup. No mainnet configuration is accepted.
- Public RPC is capability-filtered. Only a guest's signed, round-bound game bets, own withdrawals and bounded fuel actions are admitted; the public stake cap matches the largest UI preset. Arbitrary signing, unlocked account transactions, admin, debug, node reset, time travel, impersonation and mint calls are rejected.
- Contract views and paginated event reads are restricted to the deployed graph. History begins at this deployment. Raw RPC and operator pages are not exposed.
- Joins, guest sessions, request bodies, batches, read volume and writes are bounded. This is a small invite test, not a large-scale hosting claim.
- The gateway does not change mainnet contracts or clear the launch gate. Its source changes require fresh release binding and external review before inclusion in a production release.

## Verification

`test/market/invite-rpc-policy.test.ts` covers the RPC capability boundary. `scripts/check-invite-play.mjs` plays two independent mobile/desktop guests through shared verified draws and confirms matching ball numbers. `scripts/check-invite-reconnect.mjs` checks wallet continuity, persistent pause and a completed fuel burn. `scripts/check-invite-release.mjs` checks the public HTTPS session boundary and actual simulated payout withdrawals. These accept `PLANK_INVITE_URL`, `PLANK_INVITE_TOKEN_FILE`, and `PLANK_INVITE_OUTPUT`; invite credentials are not written into their reports.
