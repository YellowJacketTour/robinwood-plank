import { hasPostgresConfig } from "@/lib/postgres";
import { publicError, publicJson, rateLimit } from "@/lib/security";
import { getWalletCohortPositions } from "@/lib/market/portfolio-store";
import { avgCostPerShareWei, marketValueWei, unrealizedPnlWei } from "@/lib/market/portfolio-pnl";
import { currentNavPerShareWei } from "@/lib/market/portfolio-nav-history";
import { vaultName, vaultShortName } from "@/lib/market/vault-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// tsconfig targets ES2017, so `0n` literal syntax is a compile error — the
// rest of this codebase writes bigint constants as BigInt(...) for the same
// reason (see lib/market/vault.ts, lib/market/vault-stats.ts).
const ZERO = BigInt(0);

/**
 * Wallet portfolio across every vault: precomputed CohortPositions
 * (lib/market/portfolio-pnl.ts, built by scripts/refresh-market-data.ts's
 * "portfolio" step — see migration 008_portfolio_pnl.sql) marked to market
 * against each vault's CURRENT NAV (never last-trade price, per
 * portfolio-pnl.ts's module doc comment).
 *
 * Positions are a cache: this route never recomputes from raw events on
 * request (that would defeat the point of persisting them), so a wallet's
 * very first trade is only reflected after the next cron pass.
 */
export async function GET(req: Request): Promise<Response> {
  const limited = rateLimit(req, { key: "portfolio:lookup", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const url = new URL(req.url);
  const wallet = (url.searchParams.get("wallet") || "").trim();
  if (!HEX_ADDRESS.test(wallet)) {
    return publicJson({ error: "invalid_wallet", message: "Provide ?wallet=0x…" }, 400);
  }

  if (!hasPostgresConfig()) {
    return publicJson({
      wallet: wallet.toLowerCase(),
      positions: [],
      note: "Portfolio store unavailable (Postgres not configured).",
    });
  }

  try {
    const stored = await getWalletCohortPositions(wallet);

    const positions = await Promise.all(
      stored.map(async (pos) => {
        let navString = "0";
        let navSource: "live" | "unavailable" = "unavailable";
        try {
          const nav = await currentNavPerShareWei(pos.vaultAddress);
          if (nav > ZERO) {
            navString = nav.toString();
            navSource = "live";
          }
        } catch {
          /* leave unavailable — UI shows last realized figures only */
        }
        const nav = BigInt(navString);

        return {
          vaultAddress: pos.vaultAddress,
          vaultName: vaultName(pos.vaultAddress),
          vaultShortName: vaultShortName(pos.vaultAddress),
          sharesHeldWei: pos.sharesHeld.toString(),
          costBasisWei: pos.costBasisWei.toString(),
          avgCostPerShareWei: avgCostPerShareWei(pos).toString(),
          realizedPnlWei: pos.realizedPnlWei.toString(),
          realizedProceedsWei: pos.realizedProceedsWei.toString(),
          realizedCostWei: pos.realizedCostWei.toString(),
          feeDragWei: pos.feeDragWei.toString(),
          // Honesty fields (pen-tested math, do not hide when nonzero) — see
          // portfolio-pnl.ts CohortPosition doc comment.
          unmatchedSharesWei: pos.unmatchedSharesWei.toString(),
          unmatchedProceedsWei: pos.unmatchedProceedsWei.toString(),
          eventCount: pos.eventCount,
          updatedAt: pos.updatedAt,
          currentNavPerShareWei: navString,
          navSource,
          currentValueWei: nav > ZERO ? marketValueWei(pos, nav).toString() : null,
          unrealizedPnlWei: nav > ZERO ? unrealizedPnlWei(pos, nav).toString() : null,
        };
      })
    );

    return publicJson({ wallet: wallet.toLowerCase(), positions });
  } catch (error) {
    return publicError(error, "Failed to load portfolio.");
  }
}
