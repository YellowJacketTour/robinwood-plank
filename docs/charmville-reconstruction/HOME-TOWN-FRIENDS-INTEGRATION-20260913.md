# Home, shared area and friends integration — 2026-09-13

## Implemented this pass

- Journey panel clearly identifies current home/shared meadow and exposes return-home, friends and exchange navigation without calling the meadow Kakariko.
- Friends panel offers nearby account home visits through existing server authorization, accepted-place play actions and return-home navigation. Presence does not imply an invitation.
- Native authored arrival emits a run-bound readiness receipt. The observer rejects stale receipts and retains compatibility with older packages lacking the receipt. Embedded account placement still requires its correction acknowledgment.
- Explicit family acceptance API uses the existing atomic entitlement. Default disabled and production activation prohibited until the rest of the Burning Heart chain is accepted.

## Evidence and limits

Same existing browser tab22 on localhost3018, synthetic profile25: visited Public meadow from home, returned through the new Journey Return home action, observed retained Oran harvest count1. Development hot reload remounted the adventure after Friends extraction; loaded and entered the same tab again successfully. Inspected the new Friends menu and returned to play. No second account visit was completed in this pass.

Native quest compiled and headless startup verified; observer tests10 passed. Integrated TypeScript passed. Four focused friend destination/family request tests passed with no skips. Agent isolated database checks cover entitlement concurrency and home authorization. The pre-existing world-presence test fixture lacks an admission-grants migration and is not a passing acceptance gate.

The new native arrival receipt is source-compiled but not yet packaged into the served runtime. Local navigation UI is running; production remains unchanged. No new deployment claimed.

## Required next gates

- Two-account invitation, denied visit, permitted tending and return journey with unchanged ownership and independent progress.
- Package and live-verify arrival receipt with current native intro fix.
- Complete distinct Burning Heart art/protocol, bed selection, balances, harvest and explicit social pin before activation.
- Inspect and author actual Kakariko destination geometry, collision, services and reciprocal admission. Current shared meadow is not the completed town.
- Complete release checks before deployment; preserve private runtime packaging and gated access.
