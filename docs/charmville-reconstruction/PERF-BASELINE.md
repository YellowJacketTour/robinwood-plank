# Native runtime performance baseline

## Measurement

Run `node scripts/charmville/measure-runtime-performance.mjs` from the repository. Optional first argument selects the output directory; default is `work/runtime-performance`. Each viewport gets a separate fresh Playwright browser context. The script navigates the native homestead URL, explicitly clicks Enter the world, waits for the quest's `CHARMVILLE_HOMESTEAD_ACTIVE` console marker, and samples browser animation-frame callbacks for three seconds. It saves JSON and screenshots.

This is a single local baseline, not a universal device performance result. Environment: Windows, Node v24.13.0, headless Chromium151.0.7922.34, Intel Core i9-14900KF, 32 logical CPUs, approximately32GiB RAM. Device scale factor1. No touch/mobile emulation, CPU throttle or network throttle. A narrow viewport is not a physical phone. Browser contexts are fresh; the server filesystem and process-level caches can remain warm.

## Observed results

| Metric | 390×844 viewport | 1100×950 viewport |
|---|---:|---:|
| Navigation wall time to load | 442ms | 426ms |
| Enter click to quest-active marker | 3,827ms | 3,590ms |
| CDP completed-request encoded bytes | 70,544,621 | 70,544,621 |
| Completed requests | 220 | 220 |
| rAF callback median interval | 16.665ms | 16.665ms |
| rAF callback p95 interval | 16.670ms | 16.670ms |
| rAF callback rate | approximately60/sec | approximately60/sec |
| Uncaught page errors | 0 | 0 |
| Failed requests | 0 | 0 |

The callback cadence is **not measured engine FPS**, rendering cost, collision throughput, multiplayer capacity or input latency. An engine can miss useful simulation work while the browser still schedules callbacks. The quest marker establishes script activation, not completion of every asset or proof that the first rendered frame is interactive.

CDP byte totals cover completed requests through the measurement window; they exclude incomplete streams and are not a production-CDN benchmark. Resource Timing separately records body sizes. This test used localhost, so the startup number must not be extrapolated to mobile WAN delivery.

## Measured delivery concentration

The largest individual resource bodies in the first sample were:

| Resource | Encoded body bytes |
|---|---:|
| zplayer.wasm | 19,668,200 |
| zplayer.data | 8,875,915 |
| Homestead.qst.gz | 5,976,029 |
| Acoustic Brite Piano patch | 2,352,159 |
| French Horn patch | 2,300,193 |
| Steel Guitar patch | 2,073,583 |

For these entries, observed encoded and decoded body sizes were equal. The `.qst.gz` filename does not establish compression: this local server historically serves decoded quest bytes under that name because that is what the loader expects. Do not recompress or alter the quest without verifying the loader path.

The approximately70.5MB startup transfer is the clearest measured delivery concern. Appropriate next experiments are versioned caching and verified HTTP content encoding for eligible assets, followed by instrumenting whether the whole MIDI patch bank is necessary before first play. These are proposals, not optimizations performed here. Audio deferral must preserve the actual music behavior and not silently remove instruments.

## Next measurement gates

Repeat multiple cold and warm runs, collect median and tail startup times, test real low-end hardware, and separately profile engine simulation/render time and input-to-visible-response latency. Measure network-throttled delivery without confusing it with CPU-throttled play. Add representative crowded-world and combat workloads only after those systems run authoritatively; the current empty-start measurement does not establish MMO scalability.

No runtime optimization was made as part of this baseline. The script passed ESLint, both quest-active markers were observed, and the saved error arrays were empty. Raw evidence and screenshots are in `work/runtime-performance/baseline.json`, `390x844.png` and `1100x950.png`.

## Measured HTTP compression follow-up

The local static server now negotiates gzip for eligible large WASM, data, quest and MIDI files. It compresses lazily and retains at most32MiB/128 compressed entries keyed by path, modification time and size. Files above32MiB, small files, unsupported encodings and Range requests retain the identity path. Original bytes on disk are unchanged. HEAD reports the selected representation length without a body; responses vary on Accept-Encoding.

Live raw-HTTP checks decoded gzip and compared it byte-for-byte with identity delivery for WASM, data, quest and a MIDI patch. HEAD, Content-Length and Range bypass checks passed. Two focused helper tests and ESLint passed.

Afterward, both fresh-context samples received50,020,966 completed-request bytes instead of70,544,621: about29.1% less. Quest activation after Enter was3,836ms at390×844 and4,025ms at1100×950. These single localhost samples do not show a startup-time improvement. Both still had zero page errors and failed requests. rAF remained approximately60 callbacks/sec, which is not engine FPS.

Raw follow-up evidence is in `work/runtime-performance-gzip/baseline.json`. Reproduce transport checks with `node scripts/charmville/verify-runtime-encoding.mjs`. The change demonstrably reduces transferred bytes; compression work and decompression can offset that advantage on a fast local connection. A WAN/device benchmark remains necessary.
