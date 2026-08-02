import { CHAIN } from "@/lib/constants";

/**
 * A block-explorer link for a 0x address — every address rendered anywhere
 * in the admin console should be one (owner direction, 2026-08-02). Always
 * resolves the host from `CHAIN.blockExplorers.default.url`, never a
 * hardcoded explorer host (DESIGN.md/lib/constants.ts note this is
 * chain-config, not a literal — wallet_addEthereumChain seeds it into
 * wallets, so it has to stay one source of truth).
 *
 * `short`: render a shortened address (0x1234…abcd) as the link text — for
 * dense tables/chips. The full address is always still available via the
 * `title` attribute, so it can be read or copied character-by-character —
 * matching the /learn "Stay safe" card's full-address-plus-explorer-
 * affordance pattern, just collapsed into one element for density. Omit
 * `short` to render the full untruncated address as the link, the same
 * pattern Footer.tsx uses for the $PLANK contract link.
 */
export function ExplorerAddress({
  address,
  short = false,
  className = "",
}: {
  address: string;
  short?: boolean;
  className?: string;
}) {
  return (
    <a
      href={`${CHAIN.blockExplorers.default.url}/address/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      aria-label={`View ${address} on ${CHAIN.blockExplorers.default.name}`}
      className={`font-mono transition-colors hover:text-gold-300 hover:underline ${className}`}
    >
      {short ? shortenAddress(address) : address}
    </a>
  );
}

export function shortenAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
