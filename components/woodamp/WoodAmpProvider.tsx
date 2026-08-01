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
import {
  isAudioSource,
  isEmbedSource,
  sanitizePlaylist,
  WOODAMP_PLAYLIST,
  type WoodAmpTrack,
} from "@/lib/woodamp-playlist";

/**
 * WoodAmp — the single global audio system, mounted once in the root layout
 * so playback survives client-side navigation (the same reason the old
 * components/AudioPlayer.tsx lived there; this provider absorbs and replaces
 * it).
 *
 * Behavior:
 * - NO autoplay (owner direction, 2026-07-31). The legacy AudioPlayer's
 *   muted-autoplay "ambient on load" is gone — playback starts only from an
 *   explicit user action (chip, transport, Planklist). The remembered mute
 *   preference (localStorage "plank-audio-muted", the pre-WoodAmp key) and
 *   the cross-tab `storage` sync remain, but they only set state — they
 *   never start sound.
 * - `preload="none"` — preload=auto can hang window "load" in wallet
 *   WebViews.
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

  // Phase 2: seed with the static manifest (identical first paint / no
  // hydration mismatch), then adopt the admin-managed list once fetched.
  const [playlist, setPlaylist] =
    useState<readonly WoodAmpTrack[]>(WOODAMP_PLAYLIST);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Only ever read localStorage after mount — reading during render would
  // mismatch server markup and trip a hydration warning.
  const [muted, setMuted] = useState(false);
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
    // Absent key = first-ever visit = start UNMUTED. Muting by default was
    // correct only while the player autoplayed on load: it kept a visitor from
    // being ambushed by sound. Autoplay is gone, so the only way audio starts
    // is someone pressing play — and answering that with silence reads as a
    // broken player. Any stored value is still the visitor's own choice.
    const initialMuted = storedMute === null ? false : storedMute === "true";
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
    // NO autoplay (owner direction, 2026-07-31): the legacy AudioPlayer
    // started playback on mount ("ambient on load", muted-autoplay), which
    // combined with a remembered unmute + repeat-on meant music looped on
    // every visit. Playback now starts only from an explicit user action
    // (chip, transport, Planklist).
  }, []);

  // --- Phase 2: adopt the admin-managed playlist -------------------------
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/music/playlist", {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { tracks?: unknown };
        const parsed = sanitizePlaylist(data.tracks);
        if (!parsed.ok) return;
        setPlaylist((current) =>
          JSON.stringify(parsed.tracks) === JSON.stringify(current)
            ? current
            : parsed.tracks
        );
        // The seed is a single track, so the current index is 0 in practice;
        // clamping (rather than id-matching) keeps both updaters pure.
        setIndex((i) => (i < parsed.tracks.length ? i : 0));
      } catch {
        // Offline or aborted — the static seed keeps playing.
      }
    })();
    return () => controller.abort();
  }, []);

  // --- cross-tab mute sync (carried over from AudioPlayer.tsx) -----------
  // Sync the mute STATE only — never start playback in this tab because
  // another tab unmuted (no-autoplay rule above).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== MUTE_STORAGE_KEY || e.newValue === null) return;
      const next = e.newValue === "true";
      setMuted(next);
      const audio = audioRef.current;
      if (audio) audio.muted = next;
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

  /**
   * Whether the track at `i` can produce sound right now. Audio tracks
   * always can; embed tracks (YouTube/SoundCloud iframes) only while the
   * popout is open — YouTube's terms require a visible player, and the
   * iframe only exists inside the window. External (X/page) links never
   * play — they're showcase rows that open on the platform.
   */
  const canPlayAt = useCallback(
    (i: number) => {
      const t = playlist[i];
      if (!t) return false;
      return isAudioSource(t.source) || (open && isEmbedSource(t.source));
    },
    [open, playlist]
  );

  /** Nearest playable index walking `dir` from `start` (inclusive), or -1. */
  const findPlayable = useCallback(
    (start: number, dir: 1 | -1) => {
      for (let step = 0; step < playlist.length; step++) {
        const i =
          (((start + dir * step) % playlist.length) + playlist.length) %
          playlist.length;
        if (canPlayAt(i)) return i;
      }
      return -1;
    },
    [canPlayAt, playlist.length]
  );

  const selectTrack = useCallback(
    (i: number, autoplay = true) => {
      const clamped = ((i % playlist.length) + playlist.length) % playlist.length;
      // External links are not selectable — the Planklist renders them as
      // outbound anchors, and rotation never lands on them.
      if (playlist[clamped]?.source === "external") return;
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
    [index, playCurrent, playlist]
  );

  const chipToggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // The chip drives the ambient <audio> radio. If the current track is an
    // embed/external entry, hop to the nearest real audio track first.
    if (!isAudioSource(track.source)) {
      for (let step = 1; step <= playlist.length; step++) {
        const i = (index + step) % playlist.length;
        if (playlist[i] && isAudioSource(playlist[i].source)) {
          if (muted) {
            audio.muted = false;
            setMuted(false);
            persistMute(false);
          }
          selectTrack(i);
          return;
        }
      }
      return;
    }
    if (muted) {
      audio.muted = false;
      setMuted(false);
      persistMute(false);
      playCurrent();
      return;
    }
    togglePlay();
  }, [
    index,
    muted,
    persistMute,
    playCurrent,
    playlist,
    selectTrack,
    togglePlay,
    track.source,
  ]);

  const pickShuffled = useCallback(() => {
    const candidates: number[] = [];
    for (let i = 0; i < playlist.length; i++) {
      if (i !== index && canPlayAt(i)) candidates.push(i);
    }
    if (candidates.length === 0) return index;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }, [canPlayAt, index, playlist.length]);

  const next = useCallback(() => {
    selectTrack(shuffle ? pickShuffled() : findPlayable(index + 1, 1));
  }, [findPlayable, index, pickShuffled, selectTrack, shuffle]);

  const prev = useCallback(() => {
    const audio = audioRef.current;
    // Winamp semantics: early in a track, prev = previous track; later,
    // prev = restart current track.
    if (audio && audio.currentTime > 3 && isAudioSource(track.source)) {
      audio.currentTime = 0;
      return;
    }
    selectTrack(shuffle ? pickShuffled() : findPlayable(index - 1, -1));
  }, [findPlayable, index, pickShuffled, selectTrack, shuffle, track.source]);

  const handleEnded = useCallback(() => {
    if (shuffle) {
      selectTrack(pickShuffled());
      return;
    }
    const nxt = findPlayable(index + 1, 1);
    if (nxt === -1) {
      intentRef.current = false;
      setPlaying(false);
      return;
    }
    if (nxt > index || repeat) {
      selectTrack(nxt);
      return;
    }
    // Wrapped past the end without repeat: stop.
    intentRef.current = false;
    setPlaying(false);
  }, [findPlayable, index, pickShuffled, repeat, selectTrack, shuffle]);

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
  // Embed tracks make sound through their iframe instead — silence the
  // shared <audio> while one is active so the two never overlap.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!isAudioSource(playlist[index]?.source ?? "hosted")) {
      audio.pause();
      return;
    }
    if (intentRef.current) {
      void audio.play().catch(() => {});
    }
  }, [index, playlist]);

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
        src={isAudioSource(track.source) ? track.src : undefined}
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
