# Burning Heart item presentation

`public/charmville/items/burning-heart.svg` is original code-authored SVG artwork
for this project, created 2026-09-13. No external artwork, fonts, executable SVG,
raster generation or remote references were used. The 32×32 stepped silhouette
uses red heart lobes, a golden flame and a green stem, matching the requested
native crop identity. It is a static inventory/social master, not a claim that
all native growth-stage animation frames are present or accepted.

`lib/charmville/item-display.ts` maps the distinct `burning-heart` identity to the
name, description and artwork. These display helpers do not add it to legacy
social spending or enable crop issuance. Inventory quantities come from the
existing account response, and zero or absent stock is never replaced by a
decorative generated balance.

The extracted `inventory-panel.tsx` provides separate seed/harvest pockets,
selectable item inspection, artwork, descriptions and the actual Grain balance.
Inspection is read-only; planting and pinning remain their own explicit workflows.
Unknown items retain their names and quantities without invented artwork.
The component has no activation, grant, transfer, or wallet-signing operations.

Acceptance still requires review in the live module at mobile/desktop widths,
including selection after refresh and inventory depletion. This source change
does not certify native plant appearance or production deployment.
