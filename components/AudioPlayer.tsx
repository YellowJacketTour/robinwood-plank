"use client";

import { useEffect, useRef, useState } from "react";

const TRACK_SRC = "/audio/addiction.mp3";

/**
 * Single background-audio instance, mounted once in the root layout so it
 * survives client-side navigation instead of restarting per page.
 * Browsers block unmuted autoplay without a prior gesture — starts muted
 * when that happens and unmutes itself on the visitor's first tap/click.
 */
export default function AudioPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    let cancelled = false;

    const tryUnmutedPlay = async () => {
      try {
        audio.muted = false;
        await audio.play();
        if (!cancelled) setMuted(false);
      } catch {
        // Autoplay-with-sound blocked — fall back to muted autoplay, then
        // unmute on the visitor's first interaction anywhere on the page.
        try {
          audio.muted = true;
          await audio.play();
          if (!cancelled) setMuted(true);
        } catch {
          /* ignore — some browsers block even muted autoplay */
        }

        const unmuteOnGesture = () => {
          if (cancelled) return;
          audio.muted = false;
          void audio.play();
          setMuted(false);
          window.removeEventListener("pointerdown", unmuteOnGesture);
          window.removeEventListener("keydown", unmuteOnGesture);
        };
        window.addEventListener("pointerdown", unmuteOnGesture, { once: true });
        window.addEventListener("keydown", unmuteOnGesture, { once: true });
      }
    };

    void tryUnmutedPlay();

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    const next = !audio.muted;
    audio.muted = next;
    setMuted(next);
  };

  return (
    <>
      <audio ref={audioRef} src={TRACK_SRC} loop preload="auto" />
      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted ? "Unmute background music" : "Mute background music"}
        aria-pressed={muted}
        title={muted ? "Unmute" : "Mute"}
        className="fixed bottom-4 right-4 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-gold-500/30 bg-wood-950/60 text-gold-300/70 opacity-60 backdrop-blur-sm transition hover:opacity-100 hover:text-gold-300"
      >
        <span aria-hidden="true" className="text-sm">
          {muted ? "🔇" : "🔊"}
        </span>
      </button>
    </>
  );
}
