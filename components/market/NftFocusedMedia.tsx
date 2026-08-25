"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { resolveOriginalMediaUrl, withImageWidth, withOriginalMedia } from "@/lib/ipfs";

function isVideo(url: string, mediaType?: string | null): boolean {
  return /^video\//i.test(mediaType ?? "") || /\.(mp4|webm|ogg|mov)(?:$|[?#])/i.test(url);
}

/**
 * Focused, one-at-a-time NFT media player. The complete poster is painted
 * first and remains underneath until video can actually render a frame, so
 * slow IPFS/Arweave origins never expose a blank or half-painted card.
 */
export default function NftFocusedMedia({
  imageUrl,
  animationUrl,
  mediaType,
  alt,
  className = "object-contain",
}: {
  imageUrl: string | null | undefined;
  animationUrl?: string | null;
  mediaType?: string | null;
  alt: string;
  className?: string;
}) {
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    const id = window.setTimeout(() => setMotionAllowed(!reduced && !connection?.saveData), 0);
    return () => window.clearTimeout(id);
  }, []);

  const original = resolveOriginalMediaUrl(animationUrl);
  const playVideo = motionAllowed && failedUrl !== original && Boolean(original) && isVideo(original, mediaType);
  const playingFrame = readyUrl === original;
  const poster = withImageWidth(imageUrl, 1024) || withOriginalMedia(imageUrl);

  return (
    <div className="relative h-full w-full overflow-hidden bg-wood-950">
      {poster ? (
        <Image src={poster} alt={alt} fill sizes="(min-width: 640px) 40vw, 100vw" className={`${className} p-3`} unoptimized />
      ) : null}
      {playVideo ? (
        <video
          src={original}
          poster={poster || undefined}
          muted
          loop
          autoPlay
          playsInline
          preload="auto"
          aria-label={alt}
          onCanPlayThrough={() => setReadyUrl(original)}
          onError={() => setFailedUrl(original)}
          className={`absolute inset-0 h-full w-full bg-wood-950 object-contain transition-opacity duration-150 ${playingFrame ? "opacity-100" : "opacity-0"}`}
        />
      ) : null}
    </div>
  );
}
