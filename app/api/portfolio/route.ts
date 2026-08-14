import { hasPostgresConfig } from "@/lib/postgres";
import { verifyWalletProof, type WalletProof } from "@/lib/wallet-proof";
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

export const PORTFOLIO_PROOF_DOMAIN = "portfolio-read";

/**
 * WHAT THIS ROUTE WILL AND WILL NOT TELL A STRANGER.
 *
 * Looking up another wallet is a deliberate product feature — PortfolioView
 * has a search box for exactly that — so this is not gated wholesale. But it
 * used to return the full accounting view for any address on request: cost
 * basis, realized PnL, fee drag, unrealized PnL. That is not "public because
 * the chain is public". Every raw transfer is on-chain, yes, but this is our
 * INDEXED, COHORT-MATCHED, cost-attributed reconstruction of them, served as
 * JSON to anyone who asks. The gap between "derivable by someone willing to
 * build an indexer" and "returned by a GET" is the entire distance between
 * theoretically public and practically published, and on a financial app
 * that gap is what makes a wallet a target.
 *
 * So the line is drawn at provenance, not sensitivity-by-feel:
 *
 *  - PUBLIC — what the chain already answers directly. Share balance, the
 *    vault's current NAV, and shares x NAV. Anyone with an RPC endpoint has
 *    these already; withholding them protects nothing.
 *  - OWNER ONLY — what WE computed and nothing on-chain states: cost basis,
 *    average cost, realized and unrealized PnL, fee drag, and the unmatched
 *    accounting fields.
 *
 * Ownership is proven with a wallet signature over this route's own domain,
 * passed in a header rather than the query string so it never lands in an
 * access log or a shared URL. This is the first owner-only READ in the
 * codebase — every other use of lib/wallet-proof.ts gates a write.
 */
function readProofHeader(req: Request): WalletProof | null {
  const raw = req.headers.get("x-plank-portfolio-proof");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    if (
      typeof parsed.address !== "string" ||
      typeof parsed.timestamp !== "number" ||
      typeof parsed.signature !== "string"
    ) {
      return null;
    }
    return { address: parsed.address, timestamp: parsed.timestamp, signature: parsed.signature };
  } catch {
    // A malformed proof is treated as absent, never as an error: the summary
    // view still renders, so a broken signer degrades to less data rather
    // than a dead page.
    return null;
  }
}

function isOwner(req: Request, wallet: string): boolean {
  const proof = readProofHeader(req);
  if (!proof) return false;
  const address = wallet.toLowerCase();
  const verdict = verifyWalletProof(
    PORTFOLIO_PROOF_DOMAIN,
    "read",
    JSON.stringify({ wallet: address }),
    proof
  );
  return verdict.ok && verdict.address === address;
}

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
    const owner = isOwner(req, wallet);

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

        // Chain-derivable: a share balance, the vault's own NAV, and their
        // product. Public because withholding them protects nothing.
        const summary = {
          vaultAddress: pos.vaultAddress,
          vaultName: vaultName(pos.vaultAddress),
          vaultShortName: vaultShortName(pos.vaultAddress),
          sharesHeldWei: pos.sharesHeld.toString(),
          updatedAt: pos.updatedAt,
          currentNavPerShareWei: navString,
          navSource,
          currentValueWei: nav > ZERO ? marketValueWei(pos, nav).toString() : null,
        };
        if (!owner) return summary;

        // Ours, not the chain's — cost attribution and the PnL derived from
        // it. Only ever returned to a wallet that just proved it owns this
        // address.
        return {
          ...summary,
          costBasisWei: pos.costBasisWei.toString(),
          avgCostPerShareWei: avgCostPerShareWei(pos).toString(),
          realizedPnlWei: pos.realizedPnlWei.toString(),
          realizedProceedsWei: pos.realizedProceedsWei.toString(),
          realizedCostWei: pos.realizedCostWei.toString(),
          feeDragWei: pos.feeDragWei.toString(),
          // Honesty fields (pen-tested math, do not hide when nonzero) — see
          // portfolio-pnl.ts CohortPosition doc comment. Owner-visible: they
          // exist so the owner is told when our accounting is incomplete.
          unmatchedSharesWei: pos.unmatchedSharesWei.toString(),
          unmatchedProceedsWei: pos.unmatchedProceedsWei.toString(),
          eventCount: pos.eventCount,
          unrealizedPnlWei: nav > ZERO ? unrealizedPnlWei(pos, nav).toString() : null,
        };
      })
    );

    // `owner` is echoed so the client can render "connect to see your cost
    // basis" rather than silently showing a stranger's-eye view of the
    // viewer's own wallet and looking broken.
    return publicJson({ wallet: wallet.toLowerCase(), owner, positions });
  } catch (error) {
    return publicError(error, "Failed to load portfolio.");
  }
}
