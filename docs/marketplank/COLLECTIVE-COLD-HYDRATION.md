# Collective cold hydration

Every visitor uses the same canonical resource cache and work queue. The old
cross-process cold path defeated that design: a process losing the refresh lease
called the provider anyway if no cached value existed. Six simultaneous cold
processes could therefore make six identical upstream walks.

The repaired path joins the shared refresh with bounded, backoff-paced database
reads. Warm and last-good snapshots remain immediately readable. An owned refresh
renews its numeric lease while it runs, without holding a pooled connection across
network I/O. Lease format remains compatible with the prior release.

Publication atomically consumes current ownership and writes the result. A displaced
or expired worker cannot publish an obsolete result or unlock its replacement.
A failed refresh keeps the stored last-good snapshot and labels it cached, including
its age. A cold join has a 30-second request bound; the shared refresh has a
90-second publication bound. These bound requests and ownership, not catalog size.
Long-running collection enumeration remains resumable work in the ingestion mesh.

Actual separate-process tests verify:
- Six cold processes: exactly one provider request, all receive the shared result.
- A refresh outliving its original 15-second lease renews and still costs one call.
- A displaced owner neither publishes stale data nor releases the new owner's lease.
- Upstream failure returns last-good data with truthful freshness metadata.

The live catalog snapshot also carries the complete stored 24h/7d/30d volume and
sales fields, floor change, and floor observation time. Atomic-unit strings remain
exact beyond JavaScript's safe integer range. EVM case variants merge into the
same displayed row while non-EVM identities remain case-sensitive. This uses the
existing five-second global burst coalescing instead of waiting for index polling.

No per-person fingerprint or hardware tracking is added. The fingerprint is the
shared resource identity: one visitor's completed hydration is available to all.
