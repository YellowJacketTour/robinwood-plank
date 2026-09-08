# Charmville art tooling

The original Stalk and Splinter models are authored by `render_crops.py`. They use no downloaded mesh.
Reference-library terrain has separate attribution in `public/images/charmville/CREDITS.html`.

## Rebuild

Install or unpack Blender 4.5.9 LTS. Blender is authoring tooling only; Next/Passenger does not run it.

```powershell
& "<path-to-blender.exe>" --background --python scripts/charmville/render_crops.py -- --output public/images/charmville/original --frames 8
node scripts/charmville/pack-crops.mjs
npx tsx --test test/market/charmville-isometric.test.ts
```

`--species stalk` or `--species splinter` renders a single model for local iteration; use the default
`all` before publishing so manifest.json contains both species. Rendering is deterministic in geometry;
GPU/CPU and Blender version changes can affect raster output. Review the actual pixels after rebuilding.

Every stage uses the same camera, frame canvas and ground anchor. Render files and .blend sources are
kept; atlases are horizontal eight-frame strips. Do not treat unrelated random source variants as animation.
Open `public/images/charmville/original/preview.html` to compare stages and pause the animation.

## Browser check

Run the app on a local database with the normal migrations applied. Set CHARMVILLE_TEST_DATABASE_URL
to that isolated localhost database and CHARMVILLE_TEST_BASE_URL to the local dev server. Then run:

```powershell
node scripts/charmville/verify-browser.mjs
```

The script rejects remote hosts, creates a synthetic session/profile, exercises the real board, and
removes its fixture rows. It does not use a real wallet or post to foreign platforms. Screenshots are
written to `.charmville-isometric-*.png` for inspection, not automatically committed.
