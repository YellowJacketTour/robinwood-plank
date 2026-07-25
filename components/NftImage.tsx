"use client";

import { useEffect, useMemo, useState } from "react";
import { ipfsGatewayCandidates } from "@/lib/ipfs";

export default function NftImage({
  imageUri,
  alt,
  className,
  priority = false,
}: {
  imageUri: string;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
  const candidates = useMemo(() => ipfsGatewayCandidates(imageUri), [imageUri]);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    setIndex(0);
    setFailed(false);
  }, [imageUri]);

  // If every gateway failed, soft-retry after a short pause (new pins propagate)
  useEffect(() => {
    if (!failed || !imageUri) return;
    const timer = window.setTimeout(() => {
      setIndex(0);
      setFailed(false);
      setRetryTick((n) => n + 1);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [failed, imageUri]);

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

  const src = candidates[Math.min(index, candidates.length - 1)];

  return (
    // eslint-disable-next-line @next/next/no-img-element -- IPFS multi-gateway fallback needs native onError
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
