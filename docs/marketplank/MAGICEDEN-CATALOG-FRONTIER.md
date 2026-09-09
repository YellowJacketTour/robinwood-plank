# Magic Eden catalog frontier recovery

Live probes on 2026-09-09 found offset 30000 succeeds and 30020 fails with a misleading multiple-of-20 validation message. The paging metadata advertised 37,941 collections. The documented maximum limit of 500 returned 500 real records at offset 30000; offset 30500 still failed.

The scanner now requests 500 per page and one page per worker invocation, retaining the prior 500-record batch bound with 25 times fewer catalog HTTP requests for full batches. Old 20-row cursors round down to the containing page, so the transition cannot skip records. Each completed page checkpoints independently; a later HTTP failure does not rewind successful work.

The verified rejected frontier is stored as incomplete with its advertised total and offset. It waits six hours before starting another head scan. No rejected page is treated as an empty successful catalog or exhaustive Solana coverage. Other failures still surface normally. The additional reachable tail is up to 480 source records; how many are new to this app requires production measurement.

Primary API reference: https://docs.magiceden.io/reference/get_collections

A PostgreSQL integration test verifies completed-page persistence after HTTP 503, cursor conversion, truthful boundary state, no requests while parked, and head rescan after the deadline.
