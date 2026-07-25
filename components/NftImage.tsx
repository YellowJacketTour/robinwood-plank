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

  useEffect(() => {
    setIndex(0);
    setFailed(false);
  }, [imageUri]);

  if (!imageUri || failed || candidates.length === 0) {
    return (
      <div
        className={`flex items-center justify-center bg-wood-950/80 text-4xl ${className ?? ""}`}
        aria-hidden="true"
      >
        🪵
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- IPFS multi-gateway fallback needs native onError
    <img
      src={candidates[Math.min(index, candidates.length - 1)]}
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
