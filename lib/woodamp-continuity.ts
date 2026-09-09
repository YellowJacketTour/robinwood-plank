import { isAudioSource, type WoodAmpTrack } from "./woodamp-playlist";

export const WOODAMP_RESUME_KEY = "woodamp-resume-v1";
export type WoodAmpResume = {
  version: 1;
  trackId: string;
  source: string;
  position: number;
  shuffle: boolean;
  repeat: boolean;
};

/** Device-local listening preferences only; no identity, drafts or play intent. */
export function parseWoodAmpResume(raw: string | null): WoodAmpResume | null {
  if (!raw || raw.length > 8192) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || typeof value.trackId !== "string" ||
      typeof value.source !== "string" || typeof value.position !== "number" ||
      !Number.isFinite(value.position) || value.position < 0 ||
      typeof value.shuffle !== "boolean" || typeof value.repeat !== "boolean") return null;
    return { version: 1, trackId: value.trackId, source: value.source,
      position: value.position, shuffle: value.shuffle, repeat: value.repeat };
  } catch { return null; }
}

/** Match both identity and media: an edited/replaced track starts at zero. */
export function resolveWoodAmpResume(playlist: readonly WoodAmpTrack[], resume: WoodAmpResume | null) {
  if (!resume) return null;
  const index = playlist.findIndex((track) => track.id === resume.trackId &&
    track.src === resume.source && isAudioSource(track.source));
  return index < 0 ? null : { index, position: resume.position };
}

export function clampResumePosition(position: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  // A completed track resumes at the beginning, instead of immediately ending.
  return position >= duration ? 0 : Math.max(0, position);
}
