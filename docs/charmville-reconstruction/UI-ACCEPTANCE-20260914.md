# Bag and Party UI acceptance — 2026-09-14

This is an implementation audit, not a claim of finished commercial quality. Live acceptance belongs to the shared playtest; source inspection alone does not prove rendered geometry, gamepad behavior, or visual continuity.

## Source and adaptation

Primary reference: [pret/pokeemerald item_menu.c](https://github.com/pret/pokeemerald/blob/master/src/item_menu.c), inspected locally at `../charmville-references/pokeemerald/src/item_menu.c`, `sDefaultBagWindows` (line 393). Emerald defines distinct item-list (15×16 tiles at 14,2), description (14×6 at 0,13), and pocket-name (8×2 at 4,1) windows. The useful principle is persistent spatial roles: art and pocket identity, selected item list, and contextual description. The web implementation adapts those roles to responsive sizing; it does not claim to reproduce Emerald's renderer.

## Implemented surfaces and source measurements

| Surface | Implemented rule | Evidence |
|---|---|---|
| Bag art | Original satchel SVG; selected actual item artwork stays in a separate display | `inventory-panel.tsx`, `public/charmville/items/satchel.svg` |
| Bag pockets | Charms and Seeds, each with remembered selection; real server quantities | `inventory-panel.tsx` |
| Bag controls | Pocket buttons and item rows minimum 44 CSS px | `inventory-panel.module.css` |
| Bag list | Vertical scroll limited to 222 CSS px; names wrap; quantities remain separate | same stylesheet |
| Small Bag | At viewport ≤420px: 100px artwork column, remaining-width list, 64px item image | same stylesheet |
| Detail overflow | Shrinkable description column; long names and quantities wrap | same stylesheet |
| Party density | Occupied slots minimum 72px, empty slots 44px; all six slots remain present | `companion-panel.module.css` |
| Party identity | Real sprite, name, level, numeric HP and HP bar; following status per slot | `companion-panel.tsx` |
| Party detail | 104px minimum portrait area; selected creature's actual detail/care/organize controls | Party stylesheet/component |
| Small Party | Existing container-based roster/detail pages below 580px; detail has Return to party | same files |

## Input continuity

- Bag left/right changes pockets; up/down selects items; Home/End selects first/last.
- Up from the first item returns to its pocket. Down from the last reaches Refresh; Up from Refresh returns to the last item. Empty-pocket Down reaches Refresh. When Refresh is disabled, focus returns to the pocket.
- Tab remains native. No wallet, inventory mutation, or item use is performed by inspection.
- The shared `use-menu-gamepad.ts` sends navigation key events and respects `defaultPrevented`; controller behavior must still be checked on hardware or the existing controller harness.
- Party selection, care, following, formation, and custody logic were not replaced by this visual pass.

## Live acceptance checklist

These are checks to perform, not claimed passes:

- At 320px viewport width, open both pockets with actual inventory; confirm no horizontal clipping, readable quantities, and visible focused row.
- Inspect an empty pocket and populated pocket by keyboard/controller; reach Refresh and return without touching the mouse.
- At six occupied party slots, inspect every member's HP/name, open detail, return, and confirm selection persists.
- Reopen the menu while walking; confirm game input resumes only after closing, and world camera/location remain unchanged.
- Exercise long item names, large quantities, no inventory, disabled Refresh, and reduced viewport height.
- Compare Bag and Party inside the same shell: same frame/paper colors, selection treatment, art emphasis, and Back behavior.

Targeted ESLint passed for Bag and Party after the input/overflow changes. Type checking is recorded in the accompanying implementation result. No browser measurement or screenshot is fabricated here.
