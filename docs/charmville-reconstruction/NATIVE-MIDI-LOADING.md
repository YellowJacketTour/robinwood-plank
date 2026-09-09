# Native MIDI instrument loading

The local web player had Timidity configuration files but no instrument patches in its Emscripten filesystem. The original `.pat` files already existed under the reference runtime's `timidity/` directory. Timidity tried relative paths and `/etc/` paths, emitted missing-file messages, and never made HTTP requests itself.

The local reference server now derives `/midi-bank.json` from the existing `zc.cfg`. Before starting WASM, the wrapper fetches its 191 distinct patches with six concurrent requests, then mounts their unchanged bytes under `/etc/`. Root directory aliases point to those same instruments so the first relative lookup also succeeds, without duplicating the bank. The manifest records each patch's byte count and SHA-256. Startup reports instrument progress and fails if a fetch fails, times out, or has a truncated body. Manifest and patch fetch deadlines are 15 and 30 seconds respectively.

This default bank costs **35,413,432 bytes (33.8 MiB)** in transfers and filesystem storage before music can start. This is a local reference-player repair, not a production streaming-audio architecture. Alternate Timidity configurations are not covered by this loader. No new soundfont, substitute instrument, MIDI arrangement, or remote audio download was introduced.

Run `node scripts/charmville/verify-midi-bank.mjs` with port 3021 active to verify that the native scene starts, the default bank is mounted, and no missing-patch messages or failed instrument requests occur. This checks loading, not perceived musical fidelity, loudness, latency, or mobile audio quality. Production work needs measured caching/streaming and listening tests on actual devices.
