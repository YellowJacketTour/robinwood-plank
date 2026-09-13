# Six-member local test party

The local-only test interface now provisions Treecko, Torchic, Mudkip, Pikachu, Eevee and Poochyena through the authenticated server. A trusted local-playtest marker is required; a similar-looking handle is insufficient. An unmarked account opens a separate newly created test profile rather than receiving creatures. Provisioning is bounded and repeat-safe. Existing user accounts are not overwritten.

The six members have unique persistent entity IDs. Pikachu uses level 11 for its supported source Quick Attack; other test members follow their configured level-5 policy. Source first-frame portraits and preserved walking sprites are used. Local test entitlement is not capture, XP, raid completion or production asset issuance.

Verified browser checks:

- `verify-new-test-profile.mjs`: removes the marker only from its newly created isolated synthetic account, opens a new test profile through the real UI, reloads it successfully and verifies the original account still has no companion. No fake wallet response filtering is used for this switch.
- `verify-test-party-panel.mjs`: provisions through UI, verifies six unique IDs and species, selects all slots, reloads the same roster, follows all six and reads the actual native filesystem projection. Relaxed trail produces `277|280|283|25|133|286|26`; Close trail produces the same six IDs with spacing 18.
- `verify-party-battle-switch.mjs`: switches the real battle to Pikachu, consumes a turn with the wild response, preserves its attack PP and does not damage the wild creature through the switch. Its original source portrait appears.

Close and Relaxed are trail-spacing presets on the walked route, not tactical formations or AI. Reversals and close spacing can still overlap sprites. Native visual screenshot checks are separate from the authenticated projection check. This is locally verified functionality, not production-quality multi-device animation, raids, capture, XP or full combat AI.


## Independent followers and revised Party device

The current Party interface sets walking independently for each owned member. It no longer turns all six followers on from one selected member’s button. The actual-account `verify-test-party-panel.mjs` provisions six unique test companions through the explicitly expanded Test party settings, enables slots 1 and 2 separately, reloads and verifies exactly two persisted followers, then checks their exact UUIDs and species in the native projection before any movement. Returning slot 2 to the party leaves only slot 1 walking. Keyboard activation is exercised.

The 390-pixel and desktop screenshots (`work/party-device-390.png`, `work/party-device-desktop.png`) were inspected after correcting a viewport-breakpoint layout that clipped the detail column inside a narrower shell panel. The verifier now checks internal grid width as well as document overflow. Summary, Care and Organize keep detailed actions separate; the visible walking state belongs to the selected creature. This validates per-member following and UI projection, not six autonomous combat agents.


## Keyboard focus ergonomics

Party slots now use a single roving Tab stop: arrow keys select using the rendered grid column count, Home/End select the first/last slot, and Tab leaves the group without traversing all six cards. Summary/Care/Organize use the same single-stop left/right and Home/End pattern. Selection remains visible and touch targets retain at least 44 pixels.

`verify-party-keyboard.mjs` passed actual-account checks at 390 pixels and a desktop viewport, including responsive grid navigation, real disabled full-health feeding, organization controls and persistent native iframe. `work/party-keyboard-390.png` was inspected. The keyboard checkpoint is now complemented by the parent-menu gamepad adapter verification below.


`verify-parent-gamepad.mjs` passes with a real local account and an injected standard-gamepad device: D-pad changes the selected Party slot and Care page, holding South triggers one click, East returns to Play, the parent fullscreen menu remains responsive, and focus inside the native iframe prevents parent input handling. `work/parent-gamepad-fullscreen.png` was inspected. This is browser-level device injection, not physical controller hardware certification.
