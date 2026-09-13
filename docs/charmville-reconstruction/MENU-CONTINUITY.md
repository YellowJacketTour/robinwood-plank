# Menu continuity

The interface should behave like part of the game: a stable illustrated selection area, a readable description, remembered position, and predictable confirm/back controls. Theme changes must replace presentation without changing inventory custody or available actions.

The [Emerald item-menu source](https://github.com/pret/pokeemerald/blob/master/src/item_menu.c) separates background/window layout, bag sprites, list cursors, pocket positions and context actions. Its lesson for Charmville is structural: selection and artwork must remain synchronized, and available actions must reflect the actual context. A generic grid of equally weighted links does not provide that hierarchy.

The [Solarus DX repository](https://github.com/solarus-games/zsdx) is an archived reference and points to its successor on GitLab. Treat repository provenance and revision as part of asset/reference records; do not assume every old mirror represents current behavior.

For the current native wrapper, the unified menu retains its existing destinations. Party, inventory, exchange and friends still route to account surfaces; this work must not label those as fully integrated native panels. Gear opens native equipment. Charmdex is a discovery catalogue and does not represent owned balances. Throw-ball availability must remain controlled by the host encounter state.

Menu artwork uses existing local Emerald reference icons under `public/charmville/reference-items/pokeemerald/graphics/items/icons`. The runtime serves only seven explicitly named PNGs through `/menu-art/`; arbitrary repository files are not exposed. These are reference assets, not newly authored artwork.

Charmdex now remembers the selected entry while expanding results, selects artwork/details when an entry receives focus, and handles directional selection through the existing menu-action event. Search fields retain text-editing behavior. Confirm/back and disabled choices must be checked in the live browser, not inferred from markup.

Acceptance remains feature-specific: readable compact and wide layouts, no hidden essential action, meaningful disabled-state explanation, stable focus on reopen, visible selected artwork, correct destination, and return to game without a stuck movement key. This document does not certify the entire interface as finished.
Live review: illustrated menu rendered with local PNG artwork and readable selection/help areas on the existing narrow viewport. ArrowDown skipped disabled Gear and selected Inventory with its corresponding description. Escape restored canvas focus. Review caught browser automatic dialog focus overwriting the remembered choice; the opener now snapshots that choice before showModal. Charmdex ArrowRight changed both selection and detail heading. Full gamepad hardware, broad responsive sizes and account destination integration remain unverified.
Voice notebook now uses the same device frame and illustrated paper panels, with separate record, caption and save steps. Live narrow-viewport review confirmed readable controls and existing disabled initial states. Recording/transcription functions were not changed or exercised during visual review; no microphone was opened.
The matching Charmdex device surface is now served and visually reviewed in tab21 at the narrow viewport: header art, search/category band, selected glyph grid, reference detail page and return/footer controls. Entries remain references rather than fabricated holdings. Voice notebook Escape was verified to return focus to Game menus. No browser close command was issued.
