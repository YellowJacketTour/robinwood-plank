"use client";

import { useState } from "react";

type Props = {
  symbol: string;
  logoURI?: string;
  size?: number;
  className?: string;
};

/**
 * Token icon with a graceful letter-avatar fallback.
 *
 * Checked live against the official Uniswap token list (tokens.uniswap.org):
 * of the 100 Robinhood Chain (chainId 4663) entries, ZERO carry a logoURI —
 * the field only shows up for tokens on major chains. So today every one of
 * these renders the fallback; the <img> path only activates the moment the
 * upstream list (or a future source) actually populates one — this never
 * fabricates artwork that doesn't exist upstream. A plain <img> is used
 * instead of next/image because the source host isn't (and can't usefully
 * be) known ahead of time — next/image would need a remotePatterns entry
 * per possible logo host for a field this chain's tokens don't populate.
 */
export default function TokenIcon({ symbol, logoURI, size = 20, className = "" }: Props) {
  const [failed, setFailed] = useState(false);
  const dim = `${size}px`;

  if (logoURI && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external, unconfigured host; see comment above
      <img
        src={logoURI}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`shrink-0 rounded-full bg-wood-900 object-cover ${className}`}
        style={{ width: dim, height: dim }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-gold-500/15 text-[0.6rem] font-black text-gold-300 ${className}`}
      style={{ width: dim, height: dim }}
    >
      {symbol.slice(0, 1)}
    </span>
  );
}
