type PlankMascotProps = {
  className?: string;
};

/**
 * PLACEHOLDER ART: hand-rolled SVG mascot (a wooden plank wearing a Robin
 * Hood hat) standing in for real commissioned artwork. Swap the <svg> body
 * below with the final mascot illustration when it's ready.
 */
export default function PlankMascot({ className = "" }: PlankMascotProps) {
  return (
    <svg
      viewBox="0 0 240 320"
      role="img"
      aria-label="RobinWood mascot: a wooden plank character wearing a Robin Hood feathered hat, smiling"
      className={className}
    >
      <ellipse cx="120" cy="300" rx="70" ry="14" fill="black" opacity="0.35" />
      <rect x="55" y="90" width="130" height="190" rx="22" fill="#7a4d26" stroke="#3d2513" strokeWidth="6" />
      <g stroke="#5c3a1e" strokeWidth="4" opacity="0.6">
        <line x1="65" y1="120" x2="175" y2="120" />
        <line x1="65" y1="160" x2="175" y2="160" />
        <line x1="65" y1="200" x2="175" y2="200" />
        <line x1="65" y1="240" x2="175" y2="240" />
      </g>
      <circle cx="90" cy="150" r="8" fill="#2a1a0f" />
      <circle cx="150" cy="150" r="8" fill="#2a1a0f" />
      <path d="M85 200 Q120 225 155 200" stroke="#2a1a0f" strokeWidth="7" fill="none" strokeLinecap="round" />
      <circle cx="70" cy="190" r="12" fill="#c9784f" opacity="0.6" />
      <circle cx="170" cy="190" r="12" fill="#c9784f" opacity="0.6" />
      <path d="M40 95 Q120 30 200 95 Q120 70 40 95Z" fill="#1a4a30" stroke="#0d1f16" strokeWidth="5" />
      <path d="M150 55 Q185 30 205 45 Q180 55 165 70Z" fill="#d9a441" stroke="#a9781f" strokeWidth="3" />
      <circle cx="120" cy="98" r="10" fill="#d9a441" stroke="#a9781f" strokeWidth="3" />
    </svg>
  );
}
