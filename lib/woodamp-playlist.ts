/**
 * WoodAmp playlist — track type, validation, and the static seed manifest.
 *
 * This module stays free of Node/server imports on purpose: the player and
 * the /admin console (client components) and lib/woodamp-playlist-store.ts
 * (server) all share the same `WoodAmpTrack` shape and `sanitizePlaylist`
 * validator, so the JSON an admin signs is byte-identical to the JSON the
 * server verifies and stores.
 *
 * The static list below is the Phase 1 manifest, retained as the seed and
 * fallback. `sugar.mp3` is the original site background loop (see the git
 * history of components/AudioPlayer.tsx) and stays as track 1. (Autoplay was
 * removed by owner direction July 2026 — the track only plays when a visitor
 * starts it.)
 *
 * Phase 2 is live: the player fetches `/api/music/playlist` (admin-managed
 * list in the database, edited at /admin) and falls back to this
 * static list if that fetch fails or returns nothing.
 *
 * `source` semantics:
 * - "hosted": file we host ourselves (`/public/audio` or an admin upload
 *   served from `/api/media/…`). CORS-clean, so the real Web Audio visualizer
 *   can attach.
 * - "remote": community-hosted direct audio URL. Must be a direct file URL.
 *   The CSP `media-src` directive in next.config.ts must allow the host.
 * - "embed-youtube" / "embed-soundcloud": platform links played through the
 *   provider's official iframe player inside the WoodAmp popout, driven over
 *   postMessage (no provider SDK script — see WoodAmpEmbed). The ambient
 *   chip-only rotation skips them: YouTube's terms require a visible player,
 *   and neither can feed the shared <audio> element.
 * - "external": links we can't play at all (X/Twitter and other pages).
 *   Shown in the Planklist as community showcase entries that open on the
 *   platform; always skipped by rotation.
 */
export type WoodAmpSource =
  | "hosted"
  | "remote"
  | "embed-youtube"
  | "embed-soundcloud"
  | "external";

export type WoodAmpTrack = {
  /** Stable id — the storage key component for the stored playlist. */
  id: string;
  title: string;
  /** Community credit shown under the title. */
  artist: string;
  /** Direct audio URL (same-origin path or https), or the platform page URL
   * for embed/external tracks. */
  src: string;
  source: WoodAmpSource;
  /** Display length, seconds. Optional — the player falls back to metadata. */
  duration?: number;
};

/** True when the track can play through the shared <audio> element. */
export function isAudioSource(source: WoodAmpSource): boolean {
  return source === "hosted" || source === "remote";
}

/** True when the track plays via a provider iframe in the popout. */
export function isEmbedSource(source: WoodAmpSource): boolean {
  return source === "embed-youtube" || source === "embed-soundcloud";
}

export const WOODAMP_PLAYLIST: readonly WoodAmpTrack[] = [
  {
    id: "sugar",
    title: "Sugar",
    artist: "Plank Community Radio",
    src: "/audio/sugar.mp3",
    source: "hosted",
  },
] as const;

// --- Playlist validation (shared client/server) ----------------------------

/** Bounds that keep a bad admin payload from becoming a stored footgun. */
export const MAX_TRACKS = 200;
const MAX_TEXT = 200;
const MAX_SRC = 600;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "www.youtube-nocookie.com",
  "youtu.be",
]);
const SOUNDCLOUD_HOSTS = new Set([
  "soundcloud.com",
  "www.soundcloud.com",
  "on.soundcloud.com",
  "m.soundcloud.com",
]);
/** Hosts that serve pages we can neither play nor embed as audio. */
const EXTERNAL_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "open.spotify.com",
  "spotify.com",
]);

/** Extract the YouTube video id from a watch/short/share URL, or null. */
export function youTubeVideoId(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const ID = /^[A-Za-z0-9_-]{6,20}$/;
  if (url.hostname.toLowerCase() === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return ID.test(id) ? id : null;
  }
  const v = url.searchParams.get("v");
  if (v && ID.test(v)) return v;
  const shorts = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,20})/);
  return shorts ? shorts[1] : null;
}

/**
 * Classify a URL the way the admin console and validator agree on:
 * same-origin paths are hosted files, YouTube/SoundCloud pages become embed
 * tracks (played via the provider's iframe player), known unplayable page
 * hosts become external showcase links, and everything else https is treated
 * as a direct audio file.
 */
export function classifyTrackUrl(src: string): WoodAmpSource | null {
  const trimmed = src.trim();
  if (/^\/[^\s]*$/.test(trimmed) && !trimmed.startsWith("//")) return "hosted";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) {
    return youTubeVideoId(trimmed) ? "embed-youtube" : "external";
  }
  if (SOUNDCLOUD_HOSTS.has(host)) return "embed-soundcloud";
  if (EXTERNAL_HOSTS.has(host)) return "external";
  return "remote";
}

export type TrackValidationError = { index: number; message: string };

function validateTrack(
  value: unknown,
  index: number
): TrackValidationError | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { index, message: "Track must be an object." };
  }
  const track = value as Record<string, unknown>;
  if (typeof track.id !== "string" || !ID_PATTERN.test(track.id)) {
    return {
      index,
      message: "id must be a lowercase slug (a-z, 0-9, hyphens, max 64 chars).",
    };
  }
  for (const field of ["title", "artist"] as const) {
    const text = track[field];
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) {
      return { index, message: `${field} must be 1-${MAX_TEXT} characters.` };
    }
  }
  const VALID_SOURCES: WoodAmpSource[] = [
    "hosted",
    "remote",
    "embed-youtube",
    "embed-soundcloud",
    "external",
  ];
  if (!VALID_SOURCES.includes(track.source as WoodAmpSource)) {
    return {
      index,
      message: `source must be one of ${VALID_SOURCES.join(", ")}.`,
    };
  }
  const src = track.src;
  if (typeof src !== "string" || !src.trim() || src.length > MAX_SRC) {
    return { index, message: `src must be 1-${MAX_SRC} characters.` };
  }
  // The stored source must agree with what the URL actually is — a mismatch
  // (e.g. a YouTube page stored as "remote") produces a track that can never
  // play, so classification is authoritative, not advisory.
  const classified = classifyTrackUrl(src);
  if (classified === null) {
    return {
      index,
      message:
        "src must be a same-origin path like /audio/track.mp3 or a valid https URL.",
    };
  }
  if (classified !== track.source) {
    return {
      index,
      message: `src is a ${classified} URL but source says ${String(track.source)}.`,
    };
  }
  if (
    track.duration !== undefined &&
    (typeof track.duration !== "number" ||
      !Number.isFinite(track.duration) ||
      track.duration < 0)
  ) {
    return { index, message: "duration must be a non-negative number." };
  }
  return null;
}

/**
 * Validate an untrusted playlist payload. Returns the cleaned track list
 * (unknown extra fields dropped, text trimmed) or the first validation error.
 * Client and server both run this so the signed JSON matches the stored JSON.
 */
export function sanitizePlaylist(
  value: unknown
):
  | { ok: true; tracks: WoodAmpTrack[] }
  | {
      ok: false;
      error: TrackValidationError | { index: -1; message: string };
    } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: { index: -1, message: "tracks must be an array." },
    };
  }
  if (value.length === 0) {
    return {
      ok: false,
      error: { index: -1, message: "The playlist cannot be empty." },
    };
  }
  if (value.length > MAX_TRACKS) {
    return {
      ok: false,
      error: { index: -1, message: `At most ${MAX_TRACKS} tracks.` },
    };
  }
  const tracks: WoodAmpTrack[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const error = validateTrack(value[i], i);
    if (error) return { ok: false, error };
    const raw = value[i] as Record<string, unknown>;
    const track: WoodAmpTrack = {
      id: raw.id as string,
      title: (raw.title as string).trim(),
      artist: (raw.artist as string).trim(),
      src: (raw.src as string).trim(),
      source: raw.source as WoodAmpSource,
      ...(raw.duration !== undefined
        ? { duration: raw.duration as number }
        : {}),
    };
    if (seenIds.has(track.id)) {
      return {
        ok: false,
        error: { index: i, message: `Duplicate track id "${track.id}".` },
      };
    }
    seenIds.add(track.id);
    tracks.push(track);
  }
  return { ok: true, tracks };
}
