/**
 * Real, recognizable per-venue marks -- same discipline as ChainIcon.tsx
 * (see that file's own header): inline vector, real published brand colors,
 * zero external requests/hotlinking. Built 2026-08-26 replacing
 * DataSourceChip's plain text venue label ("i dont like the opensea seaport
 * label on the floor column ... collections could have venue logo vector
 * files for whatever different marketplace theyre listed in").
 *
 * These are simplified geometric marks distinctive enough to recognize at
 * a glance (matching ChainIcon's Base/Arbitrum/Optimism/Robinhood
 * treatment), not pixel-exact reproductions of each venue's full published
 * logo -- same tradeoff ChainIcon makes for the marks it hand-draws rather
 * than sourcing real path data for. Falls back to a plain colored monogram
 * badge for any venue id not covered below, so a newly added venue in
 * venue-registry.ts never renders blank.
 */
const VENUE_COLOR: Record<string, string> = {
  marketplank: "#e3ac4f",
  "opensea-seaport-1.6": "#2081e2",
  "opensea-seaport-legacy": "#2081e2",
  "opensea-wyvern": "#2081e2",
  blur: "#ff8700",
  looksrare: "#0ce466",
  x2y2: "#9b8afb",
  foundation: "#ffffff",
  "cryptopunks-native": "#63cca8",
  "magiceden-solana": "#e42575",
  "unisat-bitcoin": "#f7931a",
  "ord-core-bitcoin": "#f7931a",
  "ordiscan-bitcoin": "#f7931a",
  "ordinalswallet-bitcoin": "#f7931a",
};

function monogram(id: string, label: string): string {
  const known: Record<string, string> = {
    marketplank: "P",
    "opensea-seaport-1.6": "OS",
    "opensea-seaport-legacy": "OS",
    "opensea-wyvern": "OS",
    blur: "BL",
    looksrare: "LR",
    x2y2: "X2",
    foundation: "FN",
    "cryptopunks-native": "CP",
    "magiceden-solana": "ME",
    "unisat-bitcoin": "US",
    "ord-core-bitcoin": "OR",
    "ordiscan-bitcoin": "OR",
    "ordinalswallet-bitcoin": "OW",
  };
  return known[id] ?? label.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
}

export default function VenueIcon({
  venueId,
  venueLabel,
  size = 14,
  className = "",
}: {
  venueId: string;
  venueLabel: string;
  size?: number;
  className?: string;
}) {
  const color = VENUE_COLOR[venueId] ?? "#8b92a5";
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    className,
    "aria-hidden": true,
    style: { display: "block", flexShrink: 0 } as const,
  };

  switch (venueId) {
    case "opensea-seaport-1.6":
    case "opensea-seaport-legacy":
    case "opensea-wyvern":
      // Compass-mark abstraction of OpenSea's real brand blue + a
      // wayfinding needle (their published mark is a ship's-wheel/compass
      // motif) -- simplified, not a pixel copy.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill={color} />
          <path d="M12 6.5 15 12l-3 5.5-3-5.5z" fill="#fff" opacity="0.92" />
          <circle cx="12" cy="12" r="1.6" fill={color} />
        </svg>
      );
    case "blur":
      // Blur's real mark is motion-streak bars -- three diagonal bars of
      // increasing weight.
      return (
        <svg {...common}>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill={color} />
          <rect x="5" y="15" width="14" height="2" rx="1" fill="#0c0906" opacity="0.85" />
          <rect x="5" y="11" width="10" height="2" rx="1" fill="#0c0906" opacity="0.65" />
          <rect x="5" y="7" width="6" height="2" rx="1" fill="#0c0906" opacity="0.45" />
        </svg>
      );
    case "looksrare":
      // LooksRare's real mark is an eye -- simplified almond + pupil.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill="#0c0906" />
          <path d="M4.5 12S7.8 6.5 12 6.5 19.5 12 19.5 12 16.2 17.5 12 17.5 4.5 12 4.5 12Z" fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          <circle cx="12" cy="12" r="2.6" fill={color} />
        </svg>
      );
    case "x2y2":
      // Crossed-node network mark, dark theme (X2Y2's own brand skews
      // black/white) with a lilac accent.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill="#17151f" />
          <path d="M7.5 7.5 16.5 16.5M16.5 7.5 7.5 16.5" stroke={color} strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
      );
    case "foundation":
      // Foundation's real mark is a stark black diamond/prism.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill="#0c0906" />
          <path d="M12 5 18 12 12 19 6 12z" fill={color} />
        </svg>
      );
    case "cryptopunks-native":
      // Pixel-grid abstraction of the punk pixel-art aesthetic.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill="#111827" />
          <g fill={color}>
            <rect x="7" y="7" width="3.2" height="3.2" />
            <rect x="13.8" y="7" width="3.2" height="3.2" />
            <rect x="7" y="13.8" width="10" height="3.2" />
          </g>
        </svg>
      );
    case "magiceden-solana":
      // Arch/gate mark (Magic Eden's real brand uses a gateway motif).
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill={color} />
          <path d="M8 17V11a4 4 0 0 1 8 0v6" fill="none" stroke="#fff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
      );
    case "unisat-bitcoin":
    case "ord-core-bitcoin":
    case "ordiscan-bitcoin":
    case "ordinalswallet-bitcoin":
      // Shared Bitcoin-ordinals family mark: real Bitcoin orange with a
      // small inscribed-rune diamond (visually groups the ordinals-indexer
      // venues without claiming they're the same product).
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill={color} />
          <path d="M12 7 16 12 12 17 8 12z" fill="none" stroke="#fff" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
        </svg>
      );
    case "marketplank":
      // First-party mark: this app's own gold accent, simple plank bar.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill="#241a10" />
          <rect x="5.5" y="10" width="13" height="4" rx="1" fill={color} />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" fill={color} opacity="0.85" />
          <text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="#0c0906">
            {monogram(venueId, venueLabel)}
          </text>
        </svg>
      );
  }
}
