# Companion health and Oran consumption

The source catalogue now covers 386 species. Owned creature health uses the source HP formula with level 5, one server-generated HP IV persisted per creature, and HP EV 0. Initial HP is full; the player cannot submit damage, invent HP, or reroll the IV by refreshing. This is a deliberately bounded starter-health policy, not a complete trained-creature statistics system.

`/api/charmville/companions/vitals` returns owned creature health and available Oran quantity. Consuming one Oran restores up to 10 HP, using the source item's effect. The request includes an idempotent UUID, owned creature ID and expected health revision. Full-health and fainted creatures cannot consume the item through this healing action. No damage or combat API is introduced.

Verification separates three kinds of evidence:

- Real account browser: starter selection/reload displays level and HP; initial HP equals max HP and Feed is disabled.
- Synthetic browser injury fixture: a simulated lost feed response retries the same UUID, receives the original successful healing result, updates HP and remaining berry quantity, and disables feeding at full HP. This does not injure a user creature or prove live combat.
- PostgreSQL service checks: actual consumption/health transactions, duplicate receipt handling and rejected cases verify the authoritative service independently of mocked presentation. Fixtures remain isolated test data.

The compact party detail card presents source-backed level and HP only, with explanations for full health, fainting and missing Oran supply. It does not show invented attack/defense stats or an unwired battle button. Party storage, clinic/revival gameplay, training, combat, capture and shared creature AI remain incomplete. Peer-facing presentation is not certified by this work.

Evidence: `scripts/charmville/verify-companion-panel.mjs`, `scripts/charmville/verify-companion-vitals.mjs`, the companion vitals API and PostgreSQL tests. The narrow-screen screenshot is `work/companion-vitals-mobile.png`.
