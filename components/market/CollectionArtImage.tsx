"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { resolveIpfsUrl, withImageWidth, isIpfsGatewayUrl, ORB_PRONE_ART_HOSTS } from "@/lib/ipfs";
import { imageSrcFallbacks, isInscriptionArtUrl } from "@/lib/market/collection-art";

function isPoisonedImageSrc(src: string | null): boolean {
  if (!src) return true;
  const trimmed = src.trim().toLowerCase();
  return trimmed === "" || trimmed === "null" || trimmed === "undefined";
}

function PlankPlaceholder() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-wood-900 via-wood-800 to-wood-900">
      <svg viewBox="0 0 24 24" className="h-7 w-7 text-gold-400/70" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="9" width="20" height="6" rx="1" />
        <line x1="2" y1="12" x2="22" y2="12" strokeOpacity="0.4" />
        <circle cx="6" cy="10.5" r="0.5" fill="currentColor" stroke="none" />
        <circle cx="18" cy="13.5" r="0.5" fill="currentColor" stroke="none" />
      </svg>
      <span className="text-[0.55rem] font-black uppercase tracking-wider text-gold-400/50">Art pending</span>
    </div>
  );
}

/** Same-origin, high-res-first collection/token art. Hero walks large→fallback; never invents. */
export default function CollectionArtImage({
  src,
  alt,
  onFail,
  width = 512,
  priority = false,
  variant = "tile",
  extras = [],
}: {
  src: string | null;
  alt: string;
  onFail?: () => void;
  width?: number;
  priority?: boolean;
  variant?: "hero" | "tile" | "thumb";
  extras?: Array<string | null | undefined>;
}) {
  const candidates = [
    ...imageSrcFallbacks(src),
    ...extras.flatMap((u) => (u ? imageSrcFallbacks(u) : [])),
  ].filter((u, i, a) => a.indexOf(u) === i);
  const [idx, setIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  // Bounded, real retry for a transient upstream failure (e.g. our own
  // on-chain image proxy hitting a momentarily rate-limited/jailed RPC
  // provider under scroll-burst load) -- flagged live 2026-08-24: far-down
  // tiles were stuck permanently at "Art pending" after one failed load,
  // even though the SAME url would succeed a moment later on a manual
  // refresh. Exhausting every candidate now retries the full list once
  // more after a short backoff before giving up for real; a genuinely
  // dead/poisoned src still fails fast on the second pass.
  const [retryTick, setRetryTick] = useState(0);
  const extraKey = extras.filter(Boolean).join("|");
  useEffect(() => {
    setIdx(0);
    setFailed(false);
    setRetryTick(0);
  }, [src, extraKey]);
  const current = candidates[idx] ?? null;
  if (failed || !current || isPoisonedImageSrc(current)) {
    return <PlankPlaceholder />;
  }
  let orbHost = false;
  try {
    orbHost = ORB_PRONE_ART_HOSTS.has(new URL(current).hostname.toLowerCase());
  } catch {
    orbHost = false;
  }
  const shouldProxy =
    current.startsWith("/api/ipfs/") || current.startsWith("ipfs://") || isIpfsGatewayUrl(current) || orbHost;
  const baseResolvedSrc = shouldProxy ? withImageWidth(resolveIpfsUrl(current), width) || current : current;
  // A retry pass appends a real cache-busting query param so the browser
  // (and any intermediate cache) actually re-issues the request instead of
  // replaying the same failed response.
  const resolvedSrc = retryTick > 0
    ? `${baseResolvedSrc}${baseResolvedSrc.includes("?") ? "&" : "?"}retry=${retryTick}`
    : baseResolvedSrc;
  const sizes =
    variant === "hero" ? "(min-width: 1024px) 60vw, 100vw" : variant === "thumb" ? "48px" : "(min-width: 1280px) 16vw, 45vw";
  const pixel = isInscriptionArtUrl(current);
  return (
    <Image
      key={resolvedSrc}
      src={resolvedSrc}
      alt={alt}
      fill
      sizes={sizes}
      className={`${variant === "hero" ? "object-cover" : "object-contain"} transition-transform duration-300 ease-out group-hover:scale-[1.04] ${pixel ? "[image-rendering:pixelated]" : ""}`}
      unoptimized
      priority={priority}
      loading={priority ? undefined : "lazy"}
      onError={() => {
        if (idx + 1 < candidates.length) {
          setIdx(idx + 1);
          return;
        }
        if (retryTick < 1) {
          // One bounded retry pass, after a short real delay, before
          // giving up for good -- covers the transient-RPC-jail case
          // instead of permanently blanking a tile a manual refresh would
          // have fixed.
          window.setTimeout(() => {
            setIdx(0);
            setRetryTick((n) => n + 1);
          }, 1500);
          return;
        }
        setFailed(true);
        onFail?.();
      }}
    />
  );
}
