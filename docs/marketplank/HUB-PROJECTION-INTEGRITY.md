# Hub projection integrity

A live chain-filter request returned HTTP 500 with missing FROM-clause entry for table r. The page query filtered the rank table as r, but reused that predicate in a count query containing only catalog alias c. The count now uses its own catalog predicate. A real PostgreSQL regression executes every chain from the manifest and checks the returned total against the catalog.

The native sales endpoint independently reported four rolling-day sales and 0.0345 ETH while the hub showed missing fields. The hub previously swallowed a native ledger read failure and could cache that failure as null statistics. A failed native read now preserves the shared edge's last-good index rather than publishing false missing data. Chain-filtered pages that do not include the native row do not fail for that unrelated read.

The new realtime snapshot also respects source ownership: generic discovery snapshots cannot overwrite the native book's floor, supply, listed count, or holders. Native rolling sales are projected from the same permanent ledger as the native page. This corrects a latent delivery regression before claiming the new transport is verified.

Collection pages retain their last received data when a background refresh fails and explicitly mark the delay; they no longer replace an already populated page with a full-page error.
