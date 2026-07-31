"use client";

import { useEffect, useRef } from "react";
import { youTubeVideoId, type WoodAmpTrack } from "@/lib/woodamp-playlist";

/**
 * Embed panel for "embed-youtube" / "embed-soundcloud" tracks — the
 * providers' official iframe players, mounted inside the WoodAmp popout.
 *
 * Both players speak a postMessage protocol, so no provider SDK script is
 * loaded (CSP script-src stays 'self'; only frame-src allows the two hosts):
 * - YouTube: iframe embed with enablejsapi=1. We send the "listening"
 *   handshake and watch onStateChange for state 0 (ended) to auto-advance.
 *   The player must stay visible — YouTube's terms prohibit hidden playback,
 *   which is also why embeds only play while the popout is open.
 * - SoundCloud: the w.soundcloud.com widget. We subscribe to its "finish"
 *   event the same way SC.Widget does under the hood.
 *
 * Auto-advance is best-effort: if a provider changes its message shape, the
 * track simply doesn't auto-advance and the visitor taps next — playback
 * itself is never affected. Playback controls are the provider's own UI
 * inside the iframe.
 */
export default function WoodAmpEmbed({
  track,
  onEnded,
}: {
  track: WoodAmpTrack;
  onEnded: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  const isYouTube = track.source === "embed-youtube";
  const videoId = isYouTube ? youTubeVideoId(track.src) : null;

  const src = isYouTube
    ? videoId
      ? `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&autoplay=1&playsinline=1&rel=0`
      : null
    : `https://w.soundcloud.com/player/?url=${encodeURIComponent(track.src)}&auto_play=true&visual=false&show_comments=false&show_teaser=false&hide_related=true`;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !src) return;

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      if (typeof event.data !== "string") return;
      try {
        const data = JSON.parse(event.data) as {
          event?: string;
          info?: unknown;
          method?: string;
        };
        if (isYouTube) {
          // 0 = ended in the IFrame API's state enum.
          if (data.event === "onStateChange" && data.info === 0) {
            endedRef.current();
          }
        } else if (data.method === "finish") {
          endedRef.current();
        }
      } catch {
        // Not a player message.
      }
    };
    window.addEventListener("message", onMessage);

    const subscribe = () => {
      const target = iframe.contentWindow;
      if (!target) return;
      if (isYouTube) {
        target.postMessage(
          JSON.stringify({ event: "listening", id: "woodamp", channel: "widget" }),
          "https://www.youtube-nocookie.com"
        );
      } else {
        target.postMessage(
          JSON.stringify({ method: "addEventListener", value: "finish" }),
          "https://w.soundcloud.com"
        );
      }
    };
    iframe.addEventListener("load", subscribe);
    // The iframe may already be loaded by the time this effect runs.
    subscribe();

    return () => {
      window.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", subscribe);
    };
  }, [isYouTube, src]);

  if (!src) {
    return (
      <p className="rounded-lg border border-gold-500/25 bg-panel-strong px-3 py-2.5 text-[0.78rem] text-cream-muted">
        This link can&apos;t be embedded.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gold-500/25 bg-panel-strong">
      <iframe
        ref={iframeRef}
        key={track.id}
        src={src}
        title={`${track.title} — ${track.artist}`}
        width="100%"
        height={isYouTube ? 186 : 166}
        allow="autoplay; encrypted-media; picture-in-picture"
        sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
        className="block w-full"
      />
    </div>
  );
}
