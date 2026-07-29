"use client";

import { useEffect, useMemo, useState } from "react";
import { resolveIpfsUrl, ipfsGatewayCandidates } from "@/lib/ipfs";
import { ensureArtCached } from "@/lib/art-cache";

export default function NftImage({
  imageUri,
  alt,
  className,
  priority = false,
  tokenId,
}: {
  imageUri: string;
  alt: string;
  className?: string;
  priority?: boolean;
  tokenId?: string | number;
}) {
  // Canonical path: same-origin proxy only (ORB-safe). Fallbacks still go
  // through resolveIpfsUrl so we never paint raw gateway URLs in <img>.
  const candidates = useMemo(() => {
    if (!imageUri) return [] as string[];
    if (imageUri.startsWith("/api/ipfs/")) return [imageUri];
    if (imageUri.startsWith("data:")) return [imageUri];
    // Build proxy chain from raw gateway candidates.
    const raw = ipfsGatewayCandidates(imageUri);
    const proxied = raw.map((u) =>
      u.startsWith("/api/ipfs/") || u.startsWith("data:") ? u : resolveIpfsUrl(u)
    );
    // Dedupe
    return [...new Set(proxied.filter(Boolean))];
  }, [imageUri]);

  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    setIndex(0);
    setFailed(false);
  }, [imageUri]);

  useEffect(() => {
    if (!failed || !imageUri) return;
    const timer = window.setTimeout(() => {
      setIndex(0);
      setFailed(false);
      setRetryTick((n) => n + 1);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [failed, imageUri]);

  const src = candidates[Math.min(index, Math.max(0, candidates.length - 1))] || "";

  useEffect(() => {
    if (!src || !tokenId) return;
    void ensureArtCached(String(tokenId), src);
  }, [src, tokenId]);

  if (!imageUri || candidates.length === 0) {
    return (
      <div
        className={`flex items-center justify-center bg-wood-950/80 text-4xl ${className ?? ""}`}
        aria-hidden="true"
      >
        🪵
      </div>
    );
  }

  if (failed) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-1 bg-wood-950/80 text-foreground/50 ${className ?? ""}`}
        aria-hidden="true"
      >
        <span className="text-3xl">🪵</span>
        <span className="text-[0.6rem] font-bold uppercase tracking-wide">retrying art…</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- multi-candidate fallback needs native onError
    <img
      key={`${src}-${retryTick}`}
      src={src}
      alt={alt}
      className={className}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      onError={() => {
        if (index + 1 < candidates.length) {
          setIndex((value) => value + 1);
        } else {
          setFailed(true);
        }
      }}
    />
  );
}
