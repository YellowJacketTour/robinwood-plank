# Starter location visual review

Remastering is deferred until after playability and public play. Existing source art remains the production material.

The Hero of Dreams template audit enumerated 512 DMap slots, including 256 named locations and 6,698 authored screens across 62 maps. This is metadata coverage of one quest, not visual approval of every screen or every Zelda source. Twelve shortlisted locations were captured with `review-starter-maps.mjs` and inspected on September 13, 2026. Screenshots and capture results are in `work/starter-map-review/`.

## Selected direction

Use daytime Palm Island as the source basis for the starter neighborhood, with the home exterior at DMap 2, screen 75 (0x4B). Its visible house, blue shoreline, palms and open approach are more welcoming than the autumn/purple-water prototype. This selects an art and geography basis; it does not approve the original encounters or make the location production-ready.

Create an adjacent cultivated garden using compatible source ground and borders. Keep the house approach and public path clear of planting footprints. The six-member party needs a staging area that cannot block the entrance. Link's House at DMap 26, screen 112 supplies a domestic interior reference, but its narrow entrance must be checked for party admission before adoption.

| Reviewed location | Visible evidence | Decision |
|---|---|---|
| Palm 2/75 | House marked Link, beach, palms, open foreground; red actors present | Preferred home exterior basis; classify/remove hostile encounter behavior before onboarding |
| Palm 2/74 | Beach, monument, several actors | Later neighborhood promenade, not first planting bed |
| Palm 2/76 | Raised grass, narrow stair approach, water on edges | Later exploration; unsuitable for a six-creature first spawn |
| Palm 2/59 | Raised coast; test spawn appears in water | Reject direct spawn; requires authored safe landing |
| Palm 2/91 | Larger house, lawn and approach, actors | Possible neighbor/community building; inspect doors and traversal |
| Palm 2/69 and 2/85 | Mostly black/incomplete visible terrain | Reject despite apparently open metadata; zero enemies is not proof of usable terrain |
| TreeTop 207/86 | Green woods, dense trees and narrow paths | Later woodland village; not preferred first home clearing |
| Link's House 26/112 | Furnished interior, narrow corridor | Domestic reference; requires safe entrance/exit and companion policy |
| Hyrule 3/106 | Open landing, stairs, dock and water | Public-world arrival candidate after movement/travel teaching |
| Slashy Joe 73/112 | Hazardous-looking water/channel and busy actors | Reject for gentle opening |
| Ruto's House 8/116 | Contained training floor, fountain, actors | Optional supervised training after basic movement |

## Integration requirements

Do not simply redirect the live URL. The existing tutorial hardcodes dmap4/screen63, arrival16,72 and three bed anchors. Move terrain, native script checks, camera region bounds, resource contact mapping, account geometry and arrival receipt together. Preserve saved inventory and home identity independently of these art coordinates.

Start with a sheltered home scene, parent-gift narrative, then the first supported farming cycle. Burning Heart requires a distinct conserved crop/charm identity before replacing Oran dialogue. Do not relabel an Oran yield. A public exit must preserve account progression and return to the same private home; a pretty source map does not establish multiplayer admission.

Before cutover: validate walkable spawn and doors, inspect all adjacent seams, classify the original NPC/enemy slots, test all farm stages and party paths, and verify that reconnect restores the right location. Retain the existing live build until this coupled migration passes. Current live spawn is unchanged by this review.
