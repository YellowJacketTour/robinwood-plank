/**
 * WoodAmp playlist — Phase 1 static manifest.
 *
 * The community-radio track list, in play order. `sugar.mp3` is the original
 * site background loop (see the git history of components/AudioPlayer.tsx) and
 * stays as track 1 so the ambient-on-load behavior is unchanged.
 *
 * Phase 2 replaces this module with a fetch from `/api/music/playlist`
 * (admin-managed list in the durable KV store) — keep the shape identical so
 * the player components don't change.
 *
 * `source` semantics:
 * - "hosted": file we host ourselves (today `/public/audio`, later object
 *   storage). CORS-clean, so the real Web Audio visualizer can attach.
 * - "remote": community-hosted direct audio URL. Must be a direct file URL —
 *   SoundCloud/YouTube page links cannot play in an <audio> element. The CSP
 *   `media-src` directive in next.config.ts must allow the host.
 */
export type WoodAmpTrack = {
  /** Stable id — becomes the DB key in Phase 2. */
  id: string;
  title: string;
  /** Community credit shown under the title. */
  artist: string;
  /** Direct audio URL (same-origin path or https). */
  src: string;
  source: "hosted" | "remote";
  /** Display length, seconds. Optional — the player falls back to metadata. */
  duration?: number;
};

export const WOODAMP_PLAYLIST: readonly WoodAmpTrack[] = [
  {
    id: "sugar",
    title: "Sugar",
    artist: "Plank Community Radio",
    src: "/audio/sugar.mp3",
    source: "hosted",
  },
] as const;
