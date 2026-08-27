import { allChainPlugins, chainsMissingL1Coverage } from "@/lib/market/multichain/chain-plugin";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Real, current per-chain data-source capability matrix for /admin's
 * System section -- external research brief's own "a chain is a plugin
 * row" framing, exposed as a real, live, callable audit instead of a
 * one-time comment. Derived live from the actual chain registries
 * (foreign-chain-registry.ts, non-evm-chains.ts, evm-log-scan.ts) on every
 * call -- see chain-plugin.ts's own header for why this is a read-only
 * DERIVED view, never a second, independent source of chain truth.
 *
 * `gaps`: every chain with real L2 (book/listings) coverage but no L1
 * (membership) coverage at all -- the exact shape of gap Robinhood Chain
 * was in until 2026-08-27 (fixed: HyperSync now covers it, live-verified
 * against real hostnames). Empty right now; surfaces the NEXT such gap
 * automatically if one is ever added without full parity, instead of
 * needing another research pass to rediscover it.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "admin-chain-coverage", limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  try {
    const plugins = allChainPlugins();
    const gaps = chainsMissingL1Coverage();
    return publicJson({
      fetchedAt: new Date().toISOString(),
      chains: plugins,
      gaps: gaps.map((g) => g.chainSlug),
    });
  } catch (err) {
    return publicError(err, "Could not read the chain coverage matrix.");
  }
}
