import { chainBrandColor } from "@/lib/market/multichain/trading/foreign-chain-registry";

/**
 * Real, recognizable per-chain marks -- simplified geometric renditions of
 * each chain's own published brand shape (Ethereum's diamond, Bitcoin's ₿,
 * Solana's three parallel bars, BNB's diamond-cluster, Polygon's hexagon
 * pair, Base's filled circle, Arbitrum's arrow, Optimism's ring), not
 * hotlinked third-party logo files -- same "no hotlinking" discipline
 * chainGlyph's own header already documents, just upgraded from a bare
 * letter/dot to an actual recognizable shape. Colored via
 * chainBrandColor() (each chain's real published brand color), transparent
 * background so it drops cleanly onto any card surface, light or dark.
 *
 * Renders as a plain inline vector mark -- no external image request, so
 * there's no broken-image state to guard against. Strokes on the
 * outline-based marks (Arbitrum's ring, Optimism's ring+ellipse, the
 * Robinhood monogram frame) use vector-effect="non-scaling-stroke" so the
 * line stays a crisp, visible weight at the 10px corner-badge call sites
 * instead of thinning toward invisibility as the 24-unit viewBox scales
 * down. Hover/lift treatment lives on each caller's own interactive wrapper
 * (filter pill, filter row) -- this component stays a static mark so those
 * transitions aren't duplicated here.
 */
export default function ChainIcon({ chainSlug, size = 20, className = "" }: { chainSlug: string; size?: number; className?: string }) {
  const color = chainBrandColor(chainSlug);
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    className,
    "aria-hidden": true,
    // Block + no-shrink so the mark stays pixel-crisp and doesn't get
    // squeezed by flex siblings at the smaller call sites (10px thumbnail
    // corner badges) -- callers that already pass "shrink-0" in className
    // are unaffected, this just covers the ones that don't.
    style: { display: "block", flexShrink: 0 },
  } as const;

  switch (chainSlug) {
    case "eth-mainnet":
      return (
        <svg {...common}>
          <path d="M12 1.5 4.5 12.6 12 16.8l7.5-4.2z" fill={color} opacity="0.55" />
          <path d="M12 1.5 4.5 12.6 12 16.8V1.5z" fill={color} />
          <path d="M12 18.3 4.5 14l7.5 8.2 7.5-8.2z" fill={color} opacity="0.55" />
          <path d="M12 22.2V18.3L4.5 14z" fill={color} />
        </svg>
      );
    case "polygon-mainnet":
      return (
        <svg {...common}>
          <path
            d="M16.4 8.3c-.4-.2-.9-.2-1.3 0l-3 1.8-2 1.2-3 1.8c-.4.2-.9.2-1.3 0L3.4 11.6c-.4-.2-.6-.6-.6-1.1V8.1c0-.4.2-.8.6-1.1l2.4-1.4c.4-.2.9-.2 1.3 0l2.4 1.4c.4.2.6.6.6 1.1v1.8l2-1.2V6.9c0-.4-.2-.8-.6-1.1L7.8 3c-.4-.2-.9-.2-1.3 0L2.6 5.4c-.4.2-.6.6-.6 1.1v4.7c0 .4.2.8.6 1.1l3.9 2.4c.4.2.9.2 1.3 0l3-1.8 2-1.2 3-1.8c.4-.2.9-.2 1.3 0l2.4 1.4c.4.2.6.6.6 1.1v2.4c0 .4-.2.8-.6 1.1l-2.4 1.4c-.4.2-.9.2-1.3 0l-2.4-1.4c-.4-.2-.6-.6-.6-1.1v-1.8l-2 1.2v1.8c0 .4.2.8.6 1.1l3.9 2.4c.4.2.9.2 1.3 0l3.9-2.4c.4-.2.6-.6.6-1.1V9.7c0-.4-.2-.8-.6-1.1z"
            fill={color}
          />
        </svg>
      );
    case "arb-mainnet":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          <path d="m8 15 3-8h1.4l3 8h-1.6l-.7-2h-2.8l-.7 2z" fill={color} />
          <path d="M10.6 11.6h2.8l-1.4-3.8z" fill="var(--color-panel, #1a1410)" />
        </svg>
      );
    case "base-mainnet":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill={color} />
          <path d="M12 3.2A8.8 8.8 0 0 0 3.3 11h6.9c.3-2.6 1.2-4.6 1.8-4.6s1.5 2 1.8 4.6h6.9A8.8 8.8 0 0 0 12 3.2Z" fill="#fff" opacity="0.15" />
        </svg>
      );
    case "opt-mainnet":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
          <ellipse cx="8.7" cy="12" rx="2.2" ry="3.2" fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <path d="M13.5 15.2 16.3 8.8h1.5l-2.8 6.4z" fill={color} />
        </svg>
      );
    case "bnb-mainnet":
      return (
        <svg {...common}>
          <g fill={color}>
            <path d="m12 3 2.6 2.6L12 8.2 9.4 5.6z" />
            <path d="m6.4 8.6 2.6 2.6L6.4 13.8 3.8 11.2z" />
            <path d="m17.6 8.6 2.6 2.6-2.6 2.6-2.6-2.6z" />
            <path d="m12 12.4 2.6 2.6L12 17.6l-2.6-2.6z" />
            <path d="m12 15.8 2.6 2.6L12 21l-2.6-2.6z" />
          </g>
        </svg>
      );
    case "avax-mainnet":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill={color} />
          <path d="M9.9 15.9H7.2l3.5-6.1 1.35 2.35zM16.8 15.9h-3l-4.2-7.3.6-1.05a1.05 1.05 0 0 1 1.8 0l5.7 9.9h-1.7z" fill="#fff" />
        </svg>
      );
    case "solana-mainnet":
    case "solana":
      return (
        <svg {...common}>
          <g fill={color}>
            <path d="M5.5 15.6h13l-2.4 2.7h-13z" />
            <path d="M5.5 5.7h13l-2.4 2.7h-13z" />
            <path d="M5.5 10.65h13l-2.4 2.7h-13z" opacity="0.75" />
          </g>
        </svg>
      );
    case "bitcoin-mainnet":
    case "bitcoin":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill={color} />
          <path
            d="M10.7 6.6h.9v1.5c1.7.1 3 .9 3 2.4 0 .9-.5 1.5-1.2 1.8.9.3 1.5 1 1.5 2 0 1.6-1.4 2.4-3.3 2.5v1.5h-.9v-1.5h-.9v1.5h-.9v-1.5H7v-1.3h1c.4 0 .6-.2.6-.6V9.2c0-.3-.2-.5-.6-.5H7V7.4h1.9V6.6h.9v1.4h.9zm.2 3.6c.9 0 1.5-.3 1.5-1s-.6-1-1.5-1H9.9v2zm.2 3.9c1 0 1.7-.4 1.7-1.1s-.7-1.1-1.7-1.1H9.9v2.2z"
            fill="#fff"
          />
        </svg>
      );
    case "robinhood":
      return (
        <svg {...common}>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
          <text x="12" y="16" textAnchor="middle" fontSize="10" fontWeight="900" fill={color} fontFamily="inherit">
            RW
          </text>
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="5" fill={color} />
        </svg>
      );
  }
}
