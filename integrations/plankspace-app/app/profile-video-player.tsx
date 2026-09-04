"use client";

import { useEffect, useMemo, useRef } from "react";
import { parseYouTubeVideoIds } from "./profile-video-links";

export default function ProfileVideoPlayer({
  links,
  title,
}: {
  links: string;
  title: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ids = useMemo(() => parseYouTubeVideoIds(links), [links]);
  const firstId = ids[0];
  const remaining = ids.slice(1);
  const playlist = remaining.length
    ? `&playlist=${remaining.join(",")}`
    : "";
  const src = firstId
    ? `https://www.youtube-nocookie.com/embed/${firstId}?autoplay=1&mute=0&playsinline=1&rel=0&enablejsapi=1${playlist}`
    : "";

  useEffect(() => {
    if (!src) return;
    const play = () =>
      frame.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func: "playVideo", args: [] }),
        "*",
      );
    const accepted = () => {
      play();
      window.setTimeout(play, 250);
      window.setTimeout(play, 1000);
    };
    window.addEventListener("plankspace:terms-accepted", accepted);
    return () => window.removeEventListener("plankspace:terms-accepted", accepted);
  }, [src]);

  if (!firstId) return <p className="public-empty">No featured video yet.</p>;

  return (
    <div className="profile-video-player">
      <div className="video-frame">
        <iframe
          ref={frame}
          src={src}
          title={`${title} — ${ids.length} saved video${ids.length === 1 ? "" : "s"}`}
          loading="eager"
          sandbox="allow-scripts allow-same-origin allow-presentation"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </div>
    </div>
  );
}
