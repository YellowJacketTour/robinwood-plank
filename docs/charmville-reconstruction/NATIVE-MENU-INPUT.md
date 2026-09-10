# Native Game menu input

Keyboard arrows and the controller adapter now use the same visible spatial geometry for the Game menu. Left/right stay on the current row; up/down choose an enabled control below/above with column preference. Disabled Capture therefore leaves its actual grid hole rather than reindexing every following choice. Back remains reachable. If availability disables the focused Capture button, focus moves to Back; closing the menu returns focus to the canvas.

Opening releases held native inputs. The controller now also gates native actions immediately when a confirmation closes the dialog in the same polling frame, preventing that confirmation from becoming a sword press before the next frame notices the modal closed. A neutral controller state is required before gameplay resumes.

Gameplay remapping accepts only the four face buttons0–3. Choosing an occupied face swaps assignments, maintaining unique actions. Invalid, reserved or duplicated saved mappings fall back to defaults. Menu South-confirm/East-back remain fixed, as do D-pad, Start, View and shoulders; this is not a global controller-remapping system.

`verify-menu-spatial.mjs` uses the actual runtime shell and controller JavaScript in a browser DOM fixture: keyboard spatial movement, disabled holes, dynamically disabled focus, Back, held-key release, synthetic controller closing without sword leakage, touch tapping and reserved saved-map sanitization pass. `verify-menu-controller.mjs` also passes the existing modal/select/reconnect checks. Physical gamepads have not been tested; the standard Gamepad API device is synthesized. Native integration is separately exercised by `verify-unified-menu.mjs`.
