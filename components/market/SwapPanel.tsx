import { MARKET_VAULT_ADDRESS } from "@/lib/constants";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";

/**
 * Phase 2 — NFTX-style vault buy/sell. Renders a scoped notice until a vault
 * contract is deployed for at least one collection (SPEC.md §6).
 */
export default function SwapPanel() {
  const hasVault = MARKET_VAULT_ADDRESS !== null;

  if (!hasVault) {
    return (
      <p className="rounded-lg border border-dashed border-gold-500/30 bg-wood-900/40 px-4 py-8 text-center text-sm text-foreground/60">
        Instant swap opens once a liquidity vault exists for {MARKET_COLLECTIONS[0]?.name ?? "a collection"}. Phase 2 — see the build scope.
      </p>
    );
  }

  return (
    <div className="wood-ledger space-y-3 p-3">
      <p className="text-sm text-foreground/75">
        Deposit a plank, receive a fungible pool share instantly — or swap ETH for a share and
        redeem a random plank (or pay a premium to pick one).
      </p>
      {/* Wired to the vault contract once MARKET_VAULT_ADDRESS is set. */}
    </div>
  );
}
