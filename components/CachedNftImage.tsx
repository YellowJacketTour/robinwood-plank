"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { resolveIpfsUrl, ipfsGatewayCandidates } from "@/lib/ipfs";
import { ensureArtCached } from "@/lib/art-cache";

type Props = {
  /** Proxy path, ipfs://, or http gateway URL. */
  imageUrl: string | null | undefined;
  tokenId?: string;
  alt: string;
  fill?: boolean;
  className?: string;
  sizes?: string;
  priority?: boolean;
  vault?: boolean;
  owned?: boolean;
  listed?: boolean;
};

function toProxyCandidates(imageUrl: string): string[] {
  if (!imageUrl) return [];
  if (imageUrl.startsWith("/api/ipfs/") || imageUrl.startsWith("data:")) return [imageUrl];
  const raw = ipfsGatewayCandidates(imageUrl);
  const proxied = raw.map((u) =>
    u.startsWith("/api/ipfs/") || u.startsWith("data:") ? u : resolveIpfsUrl(u)
  );
  return [...new Set(proxied.filter(Boolean))];
}

/**
 * Instant-paint NFT image: same-origin proxy, Cache API warm, multi-candidate
 * onError fallback (ORB-safe). Use for fence, vault grid, cards.
 */
export default function CachedNftImage({
  imageUrl,
  tokenId,
  alt,
  fill,
  className,
  sizes,
  priority,
  vault,
  owned,
  listed,
}: Props) {
  const candidates = useMemo(
    () => (imageUrl ? toProxyCandidates(imageUrl) : []),
    [imageUrl]
  );
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setIndex(0);
    setFailed(false);
  }, [imageUrl]);

  const src = candidates[Math.min(index, Math.max(0, candidates.length - 1))] || null;

  useEffect(() => {
    if (!src || !tokenId) return;
    void ensureArtCached(tokenId, src, { vault, owned, listed });
  }, [src, tokenId, vault, owned, listed]);

  if (!imageUrl || candidates.length === 0) {
    return (
      <div
        className={`flex items-center justify-center bg-wood-950/80 text-foreground/30 ${className ?? ""}`}
        aria-hidden
      >
        {tokenId ? `#${tokenId}` : "🪵"}
      </div>
    );
  }

  if (failed || !src) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-0.5 bg-wood-950/80 text-foreground/40 ${className ?? ""}`}
        aria-hidden
      >
        <span className="text-sm">🪵</span>
        {tokenId ? <span className="text-[0.5rem]">#{tokenId}</span> : null}
      </div>
    );
  }

  const onError = () => {
    if (index + 1 < candidates.length) setIndex((i) => i + 1);
    else setFailed(true);
  };

  if (fill) {
    return (
      <Image
        src={src}
        alt={alt}
        fill
        sizes={sizes ?? "120px"}
        className={className}
        priority={priority}
        unoptimized
        onError={onError}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={src}
      src={src}
      alt={alt}
      className={className}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      onError={onError}
    />
  );
}
