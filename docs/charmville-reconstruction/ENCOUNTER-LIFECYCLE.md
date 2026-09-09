# Authenticated encounter inspection

The contextual Play panel uses the real `/api/charmville/world/encounter` service. One authored level-2 Poochyena at cell (4,9) is persisted per region. The server supplies HP, mode, revision, controller and legal actions. The panel appears for a nearby player or the current controller, preserving the source portrait's first frame.

Available lifecycle actions are claim, enter-turn, return-world and release. Player labels are Meet Poochyena, Inspect, Return to world and Leave encounter. Inspect changes the persisted presentation mode; it is not an implemented turn-based battle. There are no attack, capture, damage or reward controls. HP remains server-owned, and an action request supplies no damage or success probability.

`verify-encounter-panel.mjs` passed using a real synthetic private account and actor service: claim, inspect, return and release changed the persisted mode/controller as expected. Keyboard activation and 390px source-portrait presentation were verified; no attack/capture buttons were present. `work/encounter-mobile.png` records the inspected UI. TypeScript and focused lint passed.

Requests use UUID, encounter revision and actor epoch. Ambiguous responses retain the request for retry. Only server-returned legal actions are exposed. The component hides when inactive and resets transient display on activation; the world keys it to the wallet identity. This does not certify live combat, creature world animation, capture ownership, HP/status handoff through actual attacks or multiplayer battle resolution.

Next acceptance is source-backed move behavior under server authority: validated targets, turn/action timing, atomic HP/status changes, interruptions, receipts and source animations. Lifecycle inspection alone does not advance combat maturity.
