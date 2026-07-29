"use client";

import { useEffect, useRef, useState } from "react";

const TRACK_SRC = "/audio/sugar.mp3";
const MUTE_STORAGE_KEY = "plank-audio-muted";

/**
 * Single background-audio instance, mounted once in the root layout so it
 * survives client-side navigation instead of restarting per page.
 *
 * Starts muted on every fresh tab, on purpose — no surprise unmuted
 * autoplay attempt. The visitor's own choice to unmute is remembered in
 * localStorage and applied as the default for every OTHER tab/page load
 * from then on: a `storage` event listener means unmuting in one tab
 * unmutes any other plank.love tab open at the same time too, and a later
 * visit starts unmuted without asking again. Muting back is remembered the
 * same way.
 */
export default function AudioPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Only ever read localStorage after mount (useEffect) — reading it during
  // render would mismatch the server-rendered markup (SSR has no
  // localStorage) and trip a hydration warning.
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    const stored = window.localStorage.getItem(MUTE_STORAGE_KEY);
    // Absent key = first-ever visit = stay muted (the actual "start on
    // mute" default). Any stored value after that is the visitor's own
    // remembered choice, muted or not.
    const initialMuted = stored === null ? true : stored === "true";
    setMuted(initialMuted);

    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = initialMuted;
    // Playback itself can still be blocked by the browser without a prior
    // gesture even when muted=true; that's fine, the mute button still
    // reflects and controls the real intended state once a gesture unlocks it.
    void audio.play().catch(() => {});
  }, []);

  // Cross-tab sync: another open tab toggling the button should update
  // this one live, not just on the next full page load.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== MUTE_STORAGE_KEY || e.newValue === null) return;
      const next = e.newValue === "true";
      setMuted(next);
      const audio = audioRef.current;
      if (audio) {
        audio.muted = next;
        if (!next) void audio.play().catch(() => {});
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggleMute = () => {
    const audio = audioRef.current;
    const next = !muted;
    if (audio) {
      audio.muted = next;
      if (!next) void audio.play().catch(() => {});
    }
    setMuted(next);
    window.localStorage.setItem(MUTE_STORAGE_KEY, String(next));
  };

  return (
    <>
      {/* preload=none — preload=auto can hang window "load" in wallet WebViews */}
      <audio ref={audioRef} src={TRACK_SRC} loop preload="none" muted />
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
