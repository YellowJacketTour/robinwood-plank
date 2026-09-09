# Collection response latency and visible coverage

Collection identity previously waited for a cold on-chain supply correction; Solana also waited for a Magic Eden cache refresh. Listings started only after identity completed. Missing loading.tsx left dynamic navigation waiting for the server without an immediate transition.

The collection view requests projection=1 for stored identity/statistics, starts its listing request independently, and defers supply correction and demand work with Next after(). Normal API requests preserve the existing Solana live refresh behavior. Snapshot supply and market-stat reads run concurrently. A route loading boundary allows partial prefetch and immediate navigation feedback. The collection component is keyed by chain and collection so a navigation cannot retain the preceding collection's local state.

Metadata coverage previously disappeared at full name/image coverage even when terminal metadata verification was incomplete. It now remains visible for unmeasured or unfinished coverage and hides only when terminal and traits/confirmed-empty counters satisfy the existing completion threshold. Animation still uses real processing/change signals; presence or absence of animation is not a global synchronization claim.

Validation includes a rendered regression for CryptoPunks-shaped coverage (10,000 images, 9,995 traits, only 5,727 terminal fetches), fully completed metadata, and unknown coverage. No new provider credentials, personal tracking, or artificial progress is introduced.

## Shared refresh ownership

The browser cache previously used one global invalidation epoch for every URL: a commit invalidating tokens could discard a simultaneously arriving activity or collection response. Invalidation also detached the in-flight reference, allowing competing requests, and asynchronous cold IndexedDB reads could each start another fetch.

Request ownership now lives independently of cached entries. Each URL has its own generation; an invalidation queues one shared follow-up after the active request. Old callers receive the refreshed generation instead of publishing the stale response. Unrelated invalidations do not discard valid cache writes. Late IndexedDB reads/writes are fenced, and failed background refreshes retain last-good data without unhandled rejection. Tests exercise twenty concurrent cold callers, unrelated commits, and an invalidation arriving during a blocked request.

Collection commit bursts coalesce over two seconds, keeping ordinary single-page token refreshes below the token endpoint's forty-per-minute limit. This controls delivery work; it is not a claim that ingestion or provider discovery completes in two seconds.
