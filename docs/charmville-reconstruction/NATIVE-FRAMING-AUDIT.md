# Native framing audit

The accepted host handshake now selects a compact native rail: Game menu, Controls & settings, and the start button while loading. The duplicate brand disappears only in accepted host mode; standalone retains its original title and controls. Settings overlay the canvas instead of increasing header height. Repeated host-ready messages cause no repeated resize.

The remaining wide-screen gutters are not an unloaded map. Reviewed upstream main.js `canvasSize` fits a fixed virtual aspect using min(viewport width / virtual width, available height / virtual height). Our adapter deliberately sets that surface to 768 by 690. Native `src/zc/render.cpp` lines146–163 uses the game framebuffer dimensions, fits against height plus six pixels, preserves aspect ratio, optionally rounds scale to integer, then centers the result. The six-pixel allowance remains inside the native framebuffer presentation. On a wide browser, aspect containment necessarily leaves side space.

Removing these gutters by CSS stretching changes sprite proportions; CSS cover crops the game/HUD and makes pointer mapping incorrect. True additional world visibility needs a separately verified native world viewport and overlay coordinate change. This increment does not alter camera projection, collisions, framebuffer allocation, game state or black pixels within source artwork. Parent outer-frame layout remains independently owned by the React shell.

Validation: hosted shell idempotence, compact crop HUD, native canvas adapter and complete pinned bridge relocation tests. Local live visual acceptance is still required after package assembly. No runtime package assembled by this change.
