"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { WOODAMP_PLAYLIST, type WoodAmpTrack } from "@/lib/woodamp-playlist";

/**
 * WoodAmp — the single global audio system, mounted once in the root layout
 * so playback survives client-side navigation (the same reason the old
 * components/AudioPlayer.tsx lived there; this provider absorbs and replaces
 * it).
 *
 * Behavior carried over from AudioPlayer.tsx on purpose:
 * - Starts MUTED on every fresh tab — no surprise unmuted autoplay. The
 *   visitor's own unmute choice is remembered in localStorage under the
 *   SAME pre-WoodAmp key ("plank-audio-muted") so existing visitors keep
 *   their remembered preference.
 * - A `storage` listener syncs the mute choice across open tabs live.
 * - `preload="none"` — preload=auto can hang window "load" in wallet
 *   WebViews.
 * - Playback can still be blocked by the browser without a prior gesture
 *   even when muted; that's fine — the first chip/transport interaction is
 *   a gesture and unlocks it.
 */

const MUTE_STORAGE_KEY = "plank-audio-muted";
const VOLUME_STORAGE_KEY = "woodamp-volume";

type WoodAmpContextValue = {
  playlist: readonly WoodAmpTrack[];
  index: number;
  track: WoodAmpTrack;
  /** True while the <audio> element is actually progressing. */
  playing: boolean;
  muted: boolean;
  /** 0..1 */
  volume: number;
  shuffle: boolean;
  repeat: boolean;
  currentTime: number;
  duration: number;
  /** Popout window visibility. */
  open: boolean;
  openWindow: () => void;
  closeWindow: () => void;
  toggleWindow: () => void;
  /** Strict play/pause — the in-window transport button. */
  togglePlay: () => void;
  /**
   * The nav-chip button: "make sound / stop sound". If muted, unmutes (and
   * ensures playback); otherwise toggles play/pause. Matches what a visitor
   * means when they tap the little play button in the header, and preserves
   * the old corner-button unmute flow.
   */
  chipToggle: () => void;
  next: () => void;
  prev: () => void;
  selectTrack: (i: number) => void;
  seek: (t: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  toggleRepeat: () => void;
};

const WoodAmpContext = createContext<WoodAmpContextValue | null>(null);

export function useWoodAmp(): WoodAmpContextValue {
  const ctx = useContext(WoodAmpContext);
  if (!ctx) {
    throw new Error("useWoodAmp must be used inside <WoodAmpProvider>");
  }
  return ctx;
}

export default function WoodAmpProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Play intent survives track changes: when true, a newly selected track
  // starts playing as soon as it can.
  const intentRef = useRef(false);

  const playlist = WOODAMP_PLAYLIST;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Only ever read localStorage after mount — reading during render would
  // mismatch server markup and trip a hydration warning.
  const [muted, setMuted] = useState(true);
  const [volume, setVolumeState] = useState(0.8);
  const [shuffle, setShuffle] = useState(false);
  // Repeat defaults ON: the pre-WoodAmp player looped its single track, and
  // ambient community radio should keep going unless someone turns it off.
  const [repeat, setRepeat] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [open, setOpen] = useState(false);

  const track = playlist[index] ?? playlist[0];

  // --- initial state from storage + ambient muted autoplay ---------------
  useEffect(() => {
    const storedMute = window.localStorage.getItem(MUTE_STORAGE_KEY);
    // Absent key = first-ever visit = stay muted (the actual "start on
    // mute" default). Any stored value is the visitor's remembered choice.
    const initialMuted = storedMute === null ? true : storedMute === "true";
    // One-time hydration of client-only localStorage state — the same
    // pattern (and suppression) as MarketView's stored-tab restore.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMuted(initialMuted);

    const storedVolume = Number(
      window.localStorage.getItem(VOLUME_STORAGE_KEY)
    );
    const initialVolume =
      Number.isFinite(storedVolume) && storedVolume > 0 && storedVolume <= 1
        ? storedVolume
        : 0.8;
    setVolumeState(initialVolume);

    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = initialMuted;
    audio.volume = initialVolume;
    intentRef.current = true;
    void audio.play().catch(() => {
      // Blocked without a gesture — the first interaction unlocks it.
    });
  }, []);

  // --- cross-tab mute sync (unchanged from AudioPlayer.tsx) --------------
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== MUTE_STORAGE_KEY || e.newValue === null) return;
      const next = e.newValue === "true";
      setMuted(next);
      const audio = audioRef.current;
      if (audio) {
        audio.muted = next;
        if (!next) {
          intentRef.current = true;
          void audio.play().catch(() => {});
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const persistMute = useCallback((value: boolean) => {
    window.localStorage.setItem(MUTE_STORAGE_KEY, String(value));
  }, []);

  // --- core transport ----------------------------------------------------
  const playCurrent = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    intentRef.current = true;
    void audio.play().catch(() => {});
  }, []);

  const pause = useCallback(() => {
    intentRef.current = false;
    audioRef.current?.pause();
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) playCurrent();
    else pause();
  }, [pause, playCurrent]);

  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    const next = !muted;
    if (audio) {
      audio.muted = next;
      if (!next) playCurrent();
    }
    setMuted(next);
    persistMute(next);
  }, [muted, persistMute, playCurrent]);

  const chipToggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (muted) {
      audio.muted = false;
      setMuted(false);
      persistMute(false);
      playCurrent();
      return;
    }
    togglePlay();
  }, [muted, persistMute, playCurrent, togglePlay]);

  const selectTrack = useCallback(
    (i: number, autoplay = true) => {
      const clamped = ((i % playlist.length) + playlist.length) % playlist.length;
      const audio = audioRef.current;
      if (clamped === index && audio) {
        // Same track (e.g. single-track playlist wrapping): restart it.
        audio.currentTime = 0;
        if (autoplay) playCurrent();
        return;
      }
      setIndex(clamped);
      setCurrentTime(0);
      setDuration(0);
      intentRef.current = autoplay;
      // The <audio> src updates on re-render; the loadeddata handler resumes
      // playback when intentRef is set.
    },
    [index, playCurrent, playlist.length]
  );

  const pickShuffled = useCallback(() => {
    if (playlist.length < 2) return index;
    let i = index;
    while (i === index) {
      i = Math.floor(Math.random() * playlist.length);
    }
    return i;
  }, [index, playlist.length]);

  const next = useCallback(() => {
    selectTrack(shuffle ? pickShuffled() : index + 1);
  }, [index, pickShuffled, selectTrack, shuffle]);

  const prev = useCallback(() => {
    const audio = audioRef.current;
    // Winamp semantics: early in a track, prev = previous track; later,
    // prev = restart current track.
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    selectTrack(shuffle ? pickShuffled() : index - 1);
  }, [index, pickShuffled, selectTrack, shuffle]);

  const handleEnded = useCallback(() => {
    if (shuffle) {
      selectTrack(pickShuffled());
      return;
    }
    if (index < playlist.length - 1) {
      selectTrack(index + 1);
      return;
    }
    if (repeat) {
      selectTrack(0);
      return;
    }
    intentRef.current = false;
    setPlaying(false);
  }, [index, pickShuffled, playlist.length, repeat, selectTrack, shuffle]);

  const seek = useCallback((t: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(t, audio.duration || t));
  }, []);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    const audio = audioRef.current;
    if (audio) audio.volume = clamped;
    window.localStorage.setItem(VOLUME_STORAGE_KEY, String(clamped));
  }, []);

  const toggleShuffle = useCallback(() => setShuffle((v) => !v), []);
  const toggleRepeat = useCallback(() => setRepeat((v) => !v), []);
  const openWindow = useCallback(() => setOpen(true), []);
  const closeWindow = useCallback(() => setOpen(false), []);
  const toggleWindow = useCallback(() => setOpen((v) => !v), []);

  // Changing tracks swaps the <audio> src on re-render; with preload="none"
  // nothing loads until play() is called, so honor the play intent here.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (intentRef.current) {
      void audio.play().catch(() => {});
    }
  }, [index]);

  // --- lock screen / hardware media keys ---------------------------------
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: "WoodAmp — Plank Community Radio",
    });
    navigator.mediaSession.setActionHandler("play", playCurrent);
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("previoustrack", prev);
    navigator.mediaSession.setActionHandler("nexttrack", next);
    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
      navigator.mediaSession.setActionHandler("nexttrack", null);
    };
  }, [next, pause, playCurrent, prev, track.artist, track.title]);

  const value = useMemo<WoodAmpContextValue>(
    () => ({
      playlist,
      index,
      track,
      playing,
      muted,
      volume,
      shuffle,
      repeat,
      currentTime,
      duration,
      open,
      openWindow,
      closeWindow,
      toggleWindow,
      togglePlay,
      chipToggle,
      next,
      prev,
      selectTrack,
      seek,
      setVolume,
      toggleMute,
      toggleShuffle,
      toggleRepeat,
    }),
    [
      chipToggle,
      closeWindow,
      currentTime,
      duration,
      index,
      muted,
      next,
      open,
      openWindow,
      playing,
      playlist,
      prev,
      repeat,
      seek,
      selectTrack,
      setVolume,
      shuffle,
      toggleMute,
      togglePlay,
      toggleRepeat,
      toggleShuffle,
      toggleWindow,
      track,
      volume,
    ]
  );

  return (
    <WoodAmpContext.Provider value={value}>
      {/* preload=none — see behavior notes at the top of this file */}
      <audio
        ref={audioRef}
        src={track.src}
        preload="none"
        muted
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={handleEnded}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onLoadedData={() => {
          if (intentRef.current) {
            void audioRef.current?.play().catch(() => {});
          }
        }}
      />
      {children}
    </WoodAmpContext.Provider>
  );
}

/** mm:ss for transport displays; tolerates NaN/Infinity while loading. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
