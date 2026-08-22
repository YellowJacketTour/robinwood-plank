import { useId } from "react";
import { chainBrandColor } from "@/lib/market/multichain/trading/foreign-chain-registry";

/**
 * Real, recognizable per-chain marks. Six of these (Ethereum, Bitcoin,
 * Solana, BNB, Avalanche, Polygon) use the REAL official brand path data --
 * flagged live 2026-08-20 ("the icons youve used are very low resolution",
 * meaning low visual fidelity, not literal raster resolution: this file was
 * always inline vector, but the ETH/SOL/AVAX/BNB/Polygon marks were
 * hand-approximated geometric stand-ins, not the actual published logos a
 * viewer already recognizes from every wallet/exchange they've used --
 * see this session's own research: token-icon recognition depends on
 * matching the real mark, a simplified substitute doesn't earn that). Path
 * data pulled from spothq/cryptocurrency-icons (MIT-licensed, the same
 * widely-used open icon set wallets/exchanges draw from), inlined here --
 * same zero-external-request, no-hotlinking discipline as before, just
 * accurate paths instead of approximated ones. Each of these six already
 * bakes in its own real official color and circular backing, so they skip
 * chainBrandColor()/BACKDROP_CHAINS entirely (that machinery still serves
 * the remaining hand-drawn marks below: Base, Arbitrum, Optimism, and
 * Robinhood Chain's own real feather mark, none of which this icon set
 * covers -- it's a coin set, not an L2/appchain set).
 *
 * Base's filled circle, Arbitrum's arrow, Optimism's ring), not
 * hotlinked third-party logo files -- same "no hotlinking" discipline
 * chainGlyph's own header already documents, just upgraded from a bare
 * letter/dot to an actual recognizable shape. Colored via
 * chainBrandColor() (each chain's real published brand color), transparent
 * background so it drops cleanly onto any card surface, light or dark.
 *
 * Renders as a plain inline vector mark -- no external image request, so
 * there's no broken-image state to guard against. Strokes on the
 * outline-based marks (Arbitrum's ring, Optimism's ring+ellipse) use
 * vector-effect="non-scaling-stroke" so the line stays a crisp, visible
 * weight at the 10px corner-badge call sites instead of thinning toward
 * invisibility as the 24-unit viewBox scales down. Hover/lift treatment
 * lives on each caller's own interactive wrapper (filter pill, filter row)
 * -- this component stays a static mark so those transitions aren't
 * duplicated here.
 *
 * Backdrop: marks that are just strokes/bars with no fill (Arbitrum,
 * Optimism, Robinhood) get a dark solid-circle backing (BACKDROP_CHAINS) --
 * flagged live 2026-08-19 ("solana and polygon and optimism need to be
 * easier to see... black background behind all transparent logo symbols")
 * because a transparent mark on a similarly-dark card background reads as
 * almost invisible. Ethereum/Polygon/BNB/Solana/Bitcoin/Avalanche no longer
 * need this: each now renders its own real official mark (see this file's
 * top header), and every one of those bakes in its own solid circular
 * backing already, same as Base always did.
 */
const BACKDROP_CHAINS = new Set(["arb-mainnet", "opt-mainnet", "robinhood"]);
export default function ChainIcon({ chainSlug, size = 20, className = "" }: { chainSlug: string; size?: number; className?: string }) {
  const color = chainBrandColor(chainSlug);
  // Unique per rendered instance -- multiple ChainIcon instances share one
  // page (a ranked table can render dozens), so a hardcoded gradient id
  // would collide and every instance after the first would silently
  // render whichever definition happened to win the ID race.
  const gradientId = `solana-gradient-${useId()}`;
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
  const backdrop = BACKDROP_CHAINS.has(chainSlug) ? (
    <circle cx="12" cy="12" r="10.5" fill="#0c0906" />
  ) : null;

  // These six render the real spothq/cryptocurrency-icons path data at its
  // own native 0-32 viewBox (not this file's usual 0-24) and own baked-in
  // official color -- no backdrop, no chainBrandColor() fill, both already
  // built into the real mark itself.
  const real = { width: size, height: size, viewBox: "0 0 32 32", className, "aria-hidden": true, style: { display: "block", flexShrink: 0 } } as const;
  switch (chainSlug) {
    case "eth-mainnet":
      return (
        <svg {...real}>
          <circle cx="16" cy="16" r="16" fill="#627EEA" />
          <g fill="#FFF">
            <path fillOpacity="0.602" d="M16.498 4v8.87l7.497 3.35z" />
            <path d="M16.498 4L9 16.22l7.498-3.35z" />
            <path fillOpacity="0.602" d="M16.498 21.968v6.027L24 17.616z" />
            <path d="M16.498 27.995v-6.028L9 17.616z" />
            <path fillOpacity="0.2" d="M16.498 20.573l7.497-4.353-7.497-3.348z" />
            <path fillOpacity="0.602" d="M9 16.22l7.498 4.353v-7.701z" />
          </g>
        </svg>
      );
    case "polygon-mainnet":
      return (
        <svg {...real}>
          <circle cx="16" cy="16" r="16" fill="#6F41D8" />
          <path
            fill="#FFF"
            d="M21.092 12.693c-.369-.215-.848-.215-1.254 0l-2.879 1.654-1.955 1.078-2.879 1.653c-.369.216-.848.216-1.254 0l-2.288-1.294c-.369-.215-.627-.61-.627-1.042V12.19c0-.431.221-.826.627-1.042l2.25-1.258c.37-.216.85-.216 1.256 0l2.25 1.258c.37.216.628.611.628 1.042v1.654l1.955-1.115v-1.653a1.16 1.16 0 00-.627-1.042l-4.17-2.372c-.369-.216-.848-.216-1.254 0l-4.244 2.372A1.16 1.16 0 006 11.076v4.78c0 .432.221.827.627 1.043l4.244 2.372c.369.215.849.215 1.254 0l2.879-1.618 1.955-1.114 2.879-1.617c.369-.216.848-.216 1.254 0l2.251 1.258c.37.215.627.61.627 1.042v2.552c0 .431-.22.826-.627 1.042l-2.25 1.294c-.37.216-.85.216-1.255 0l-2.251-1.258c-.37-.216-.628-.611-.628-1.042v-1.654l-1.955 1.115v1.653c0 .431.221.827.627 1.042l4.244 2.372c.369.216.848.216 1.254 0l4.244-2.372c.369-.215.627-.61.627-1.042v-4.78a1.16 1.16 0 00-.627-1.042l-4.28-2.409z"
          />
        </svg>
      );
    case "arb-mainnet":
      return (
        <svg {...common}>
          {backdrop}
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
          {backdrop}
          <circle cx="12" cy="12" r="10.5" fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
          <ellipse cx="8.7" cy="12" rx="2.2" ry="3.2" fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <path d="M13.5 15.2 16.3 8.8h1.5l-2.8 6.4z" fill={color} />
        </svg>
      );
    case "bnb-mainnet":
      return (
        <svg {...real}>
          <circle cx="16" cy="16" r="16" fill="#F3BA2F" />
          <path
            fill="#FFF"
            d="M12.116 14.404L16 10.52l3.886 3.886 2.26-2.26L16 6l-6.144 6.144 2.26 2.26zM6 16l2.26-2.26L10.52 16l-2.26 2.26L6 16zm6.116 1.596L16 21.48l3.886-3.886 2.26 2.259L16 26l-6.144-6.144-.003-.003 2.263-2.257zM21.48 16l2.26-2.26L26 16l-2.26 2.26L21.48 16zm-3.188-.002h.002V16L16 18.294l-2.291-2.29-.004-.004.004-.003.401-.402.195-.195L16 13.706l2.293 2.293z"
          />
        </svg>
      );
    case "avax-mainnet":
      return (
        <svg {...real}>
          <circle cx="16" cy="16" r="16" fill="#E84142" />
          <path
            fill="#FFF"
            d="M11.518 22.75H8.49c-.636 0-.95 0-1.142-.123A.77.77 0 017 22.025c-.012-.226.145-.503.46-1.055l7.472-13.193c.318-.56.48-.84.682-.944a.77.77 0 01.698 0c.203.104.364.384.682.944l1.536 2.686.008.014c.343.6.517.906.593 1.226a2.26 2.26 0 010 1.066c-.076.323-.249.63-.597 1.24l-3.926 6.95-.01.017c-.346.606-.52.913-.764 1.145a2.284 2.284 0 01-.93.54c-.319.089-.675.089-1.387.089zm7.643 0h4.336c.64 0 .962 0 1.154-.126a.768.768 0 00.348-.607c.011-.219-.142-.484-.443-1.005l-.032-.054-2.172-3.722-.025-.042c-.305-.517-.46-.778-.657-.879a.762.762 0 00-.693 0c-.2.104-.36.377-.678.925l-2.165 3.722-.007.013c-.317.548-.476.821-.464 1.046a.777.777 0 00.348.606c.188.123.51.123 1.15.123z"
          />
        </svg>
      );
    case "solana-mainnet":
    case "solana":
      // Real official Solana brand gradient (solana.com/branding,
      // confirmed live 2026-08-20) -- purple #9945FF to green #14F195,
      // replacing the flat spothq bright-green fill flagged live the
      // same day as too low-contrast/hard to see. Diagonal stop
      // positions match Solana's own published logomark gradient angle.
      return (
        <svg {...real}>
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#9945FF" />
              <stop offset="100%" stopColor="#14F195" />
            </linearGradient>
          </defs>
          <circle fill="#131022" cx="16" cy="16" r="16" />
          <path
            fill={`url(#${gradientId})`}
            d="M9.925 19.687a.59.59 0 01.415-.17h14.366a.29.29 0 01.207.497l-2.838 2.815a.59.59 0 01-.415.171H7.294a.291.291 0 01-.207-.498l2.838-2.815zm0-10.517A.59.59 0 0110.34 9h14.366c.261 0 .392.314.207.498l-2.838 2.815a.59.59 0 01-.415.17H7.294a.291.291 0 01-.207-.497L9.925 9.17zm12.15 5.225a.59.59 0 00-.415-.17H7.294a.291.291 0 00-.207.498l2.838 2.815c.11.109.26.17.415.17h14.366a.291.291 0 00.207-.498l-2.838-2.815z"
          />
        </svg>
      );
    case "bitcoin-mainnet":
    case "bitcoin":
      return (
        <svg {...real}>
          <circle cx="16" cy="16" r="16" fill="#F7931A" />
          <path
            fill="#FFF"
            d="M23.189 14.02c.314-2.096-1.283-3.223-3.465-3.975l.708-2.84-1.728-.43-.69 2.765c-.454-.114-.92-.22-1.385-.326l.695-2.783L15.596 6l-.708 2.839c-.376-.086-.746-.17-1.104-.26l.002-.009-2.384-.595-.46 1.846s1.283.294 1.256.312c.7.175.826.638.805 1.006l-.806 3.235c.048.012.11.03.18.057l-.183-.045-1.13 4.532c-.086.212-.303.531-.793.41.018.025-1.256-.313-1.256-.313l-.858 1.978 2.25.561c.418.105.828.215 1.231.318l-.715 2.872 1.727.43.708-2.84c.472.127.93.245 1.378.357l-.706 2.828 1.728.43.715-2.866c2.948.558 5.164.333 6.097-2.333.752-2.146-.037-3.385-1.588-4.192 1.13-.26 1.98-1.003 2.207-2.538zm-3.95 5.538c-.533 2.147-4.148.986-5.32.695l.95-3.805c1.172.293 4.929.872 4.37 3.11zm.535-5.569c-.487 1.953-3.495.96-4.47.717l.86-3.45c.975.243 4.118.696 3.61 2.733z"
          />
        </svg>
      );
    case "robinhood":
      // Real Robinhood Chain feather mark -- flagged live 2026-08-19
      // ("robinhood chain logo needs robinhood feather not rw"). Path data
      // is the actual official mark, downloaded once (dark/white variant)
      // from Robinhood Chain's own Blockscout explorer config
      // (robinhoodchain.blockscout.com/assets/configs/network_icon_dark.svg
      // -- first-party, same real-Robinhood-API-as-source pattern
      // lib/market/robinhood-assets.ts already uses for token logos), then
      // inlined here as JSX -- not hotlinked, not a runtime image request,
      // same zero-external-request discipline as every other mark in this
      // file. Original path's viewBox was 30x30; scaled/centered into this
      // file's 24x24 space via the transform below rather than editing the
      // path's own coordinates.
      return (
        <svg {...common}>
          {backdrop}
          <g transform="translate(2.6 2.6) scale(0.773)" fill={color}>
            <path d="M3.173 30h.662c.12 0 .24-.06.28-.16C9.112 17.12 14.549 10.82 17.96 7.047c.14-.16.08-.28-.12-.28h-6.1a.689.689 0 0 0-.561.28l-4.374 5.417c-.642.803-.802 1.545-.802 2.608v5.537c-1.425 3.993-2.328 6.701-2.99 9.15-.04.156.02.24.16.24ZM25.182.808c-.943-1.003-5.197-1.043-7.163-.28-.41.158-.802.427-.983.581-1.806 1.545-3.01 2.77-4.153 3.973-.14.14-.08.28.12.28h6.762c.622 0 .983.362.983.984v7.624c0 .2.16.26.28.08l4.073-5.317c.663-.862.863-1.123 1.044-2.327.24-1.765.1-4.474-.963-5.598Zm-8.728 20.224 2.79-4.595c.06-.12.08-.26.08-.36V8.411c0-.2-.141-.28-.282-.12C14.85 12.967 11.58 17.882 8.55 23.8c-.077.149.02.281.2.221l6.26-1.926c.706-.216 1.103-.501 1.444-1.063Z" />
          </g>
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
