# Rolling marketplace statistics integrity

The public CryptoPunks collection API returned two 24-hour sales and null native volume on September 9, 2026. Its stored activity exposed prices of 28.16 and 30 ETH but no currency label. The shared aggregator and activity formatter omitted the zero-address representation of native currency. Both now accept it; stablecoin amounts remain outside native volume.

Rolling windows also change when no new sale arrives. An independent, provider-free lane is registered for every chain. Its bounded sweep revisits ledger-owned projections older than five minutes, oldest first, as well as observations that lag new trades. The aggregator clears expired ledger projections without overwriting vendor-owned observations. Missing local observations do not establish zero trading across the market. Case-insensitive index prefilters preserve indexed lookup performance while exact comparisons keep non-EVM identities separate.

The same aggregation excludes future timestamps, compares EVM self-trade addresses without case sensitivity, preserves case-sensitive non-EVM identities, and deduplicates a stream sale against a Seaport fill only for the same transaction, collection and token. Native volume and sales counts intentionally differ for payments in other currencies.

Regression coverage uses PostgreSQL: native, zero-address, wrapped and stablecoin payments; duplicate and self-trade exclusion; future timestamps; and a quiet collection whose entire observed history ages out. No production fixtures are inserted.

Percentage change still requires priced observations in both comparison windows. CryptoPunks' public local ledger had six sales, with the previous four on September 7 before the prior comparison window. This repair does not pretend that missing history is a percentage change or that the observed ledger is complete. Native CryptoPunks event backfill remains a separate ingestion gap.

The failed deployment log identified the exact guard failure: `/dev/fd/62: No such file or directory`. The jailed production host cannot use Bash process substitution. PID enumeration now uses a here-string, which needs no `/dev/fd` pathname. Worker identification reads Linux process argv from `/proc`, resolves relative script paths against the owning process's cwd, and canonicalizes deployment symlinks; wide `ps` is the fallback when `/proc` is hidden. Only same-user managed scripts inside the deployment are signaled. Waiting diagnostics report match counts, never command lines or environment values.
