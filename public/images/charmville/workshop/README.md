# Charmville original workshop

These are editable, original Blender models authored for the Charmville garden, with no borrowed game or collection artwork. The seed cottage, botanical trees and flower border share the existing scenery camera: 2:1 orthographic, 3.65 world-unit width, a 256 x 192 logical frame and ground anchor (128, 132.444). Their @3x images retain detail on high-density and enlarged displays. The contact shadow is transparent and part of the sprite; the glTF excludes the shadow catcher, camera and lights.

Rebuild from the repository root:

```powershell
& ../charmville-references/tooling/blender-4.5.9-windows-x64/blender.exe --background --threads 6 --python scripts/charmville/render_workshop.py -- --root public/images/charmville/workshop
```

For a logical rendered width W, display height is W * 0.75 and place top-left at (groundX - W * 0.5, groundY - W * 132.444 / 256). Prefer the @3x PNG as the image source with the same logical dimensions. Recommended cottage display width: 230-270 px. Tree display width: 200-240 px. Flower border: 180-240 px. Scenery depth sorting should use the ground anchor, never the image top-left.

The clover turf is a separate top-down 512 x 512 seamless material tile, with wrapped clover geometry. It should replace the previous high-frequency lawn pattern, not be composited over it.

The .blend files are authoring sources with named editable objects, shaders, lighting and camera; .glb is a future renderer transport, not a new economy or simulation. Procedural material microrelief is preserved in Blender; the glTF material is the corresponding base-color/roughness approximation and needs baking before a full realtime close-up renderer ships.
