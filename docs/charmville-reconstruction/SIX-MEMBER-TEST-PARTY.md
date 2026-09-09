# Six-member local test party

The local-only test interface now provisions Treecko, Torchic, Mudkip, Pikachu, Eevee and Poochyena through the authenticated server. A trusted local-playtest marker is required; a similar-looking handle is insufficient. An unmarked account opens a separate newly created test profile rather than receiving creatures. Provisioning is bounded and repeat-safe. Existing user accounts are not overwritten.

The six members have unique persistent entity IDs. Pikachu uses level 11 for its supported source Quick Attack; other test members follow their configured level-5 policy. Source first-frame portraits and preserved walking sprites are used. Local test entitlement is not capture, XP, raid completion or production asset issuance.

Verified browser checks:

- `verify-new-test-profile.mjs`: removes the marker only from its newly created isolated synthetic account, opens a new test profile through the real UI, reloads it successfully and verifies the original account still has no companion. No fake wallet response filtering is used for this switch.
- `verify-test-party-panel.mjs`: provisions through UI, verifies six unique IDs and species, selects all slots, reloads the same roster, follows all six and reads the actual native filesystem projection. Relaxed trail produces `277|280|283|25|133|286|26`; Close trail produces the same six IDs with spacing 18.
- `verify-party-battle-switch.mjs`: switches the real battle to Pikachu, consumes a turn with the wild response, preserves its attack PP and does not damage the wild creature through the switch. Its original source portrait appears.

Close and Relaxed are trail-spacing presets on the walked route, not tactical formations or AI. Reversals and close spacing can still overlap sprites. Native visual screenshot checks are separate from the authenticated projection check. This is locally verified functionality, not production-quality multi-device animation, raids, capture, XP or full combat AI.
