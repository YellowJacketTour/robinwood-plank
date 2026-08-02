/**
 * Pull the audio out of an X (Twitter) post so a community track can be hosted
 * here instead of linking out.
 *
 * SERVER ONLY — never import from a client component. It fetches third-party
 * URLs, and doing that from the browser would both leak the visitor's IP to X
 * and be blocked by CORS anyway.
 *
 * How it works, and why this shape:
 *
 * X posts have no audio file. The audio lives inside the post's video, which
 * is served as progressive MP4 variants (plus an HLS playlist) from
 * video.twimg.com. Those URLs are listed by the public syndication endpoint
 * that powers embedded tweets — no API key, no OAuth, no scraping of the
 * logged-in web app.
 *
 * We do NOT transcode. The MP4s carry an AAC track (`mp4a`/`esds`), and an
 * <audio> element plays AAC-in-MP4 natively, ignoring the video track. So the
 * file is stored as .m4a (audio/mp4) and played like any other hosted track.
 * Requiring ffmpeg would mean a binary dependency the shared host does not
 * have, to produce something the browser already handles.
 *
 * We deliberately take the SMALLEST video variant. Every variant carries the
 * same audio; the larger ones only differ in video bitrate, which we discard
 * on playback. Picking the smallest is the difference between storing ~1.4 MB
 * and ~5 MB for the identical listening experience.
 *
 * This is an unofficial endpoint, so every failure is explicit and typed —
 * the admin console falls back to "upload the file yourself" rather than
 * pretending a track was imported.
 */

/** Posts can be long; the cap matches the upload limit. */
export const MAX_X_AUDIO_BYTES = 25 * 1024 * 1024;

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

export type XImportError =
  | "NOT_X_URL"
  | "NOT_FOUND"
  | "NO_VIDEO"
  | "TOO_LARGE"
  | "FETCH_FAILED";

export type XPostAudio = {
  /** Progressive MP4 holding the AAC audio. */
  mediaUrl: string;
  /** @handle of the poster — used as the default track credit. */
  author: string;
  /** Post text, trimmed — used to suggest a title. */
  text: string;
  durationMs: number | null;
  postId: string;
};

/** Numeric status id from any X/Twitter post URL, or null. */
export function xPostId(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;
  const id = url.pathname.match(/\/status(?:es)?\/(\d{5,25})/)?.[1];
  return id ?? null;
}

/**
 * The `token` the syndication endpoint requires. Not a secret and not
 * authentication — it is derived from the post id by the same arithmetic the
 * embed script uses, and the endpoint simply 404s without it.
 */
export function syndicationToken(postId: string): string {
  return ((Number(postId) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, "");
}

type Variant = { content_type?: string; bitrate?: number; url?: string };

/** Resolve a post to its audio-bearing media URL. */
export async function fetchXPostAudio(
  postUrl: string,
  signal?: AbortSignal
): Promise<XPostAudio | { error: XImportError }> {
  const postId = xPostId(postUrl);
  if (!postId) return { error: "NOT_X_URL" };

  const endpoint = `https://cdn.syndication.twimg.com/tweet-result?id=${postId}&token=${syndicationToken(postId)}&lang=en`;
  let payload: Record<string, unknown>;
  try {
    const res = await fetch(endpoint, {
      // The endpoint answers 200-with-empty-body to unrecognised clients.
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (!res.ok) return { error: "NOT_FOUND" };
    const text = await res.text();
    if (!text.trim()) return { error: "NOT_FOUND" };
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: "FETCH_FAILED" };
  }

  const media = (payload.mediaDetails as Array<Record<string, unknown>>) ?? [];
  const videoInfo = media
    .map((m) => m.video_info as { variants?: Variant[]; duration_millis?: number })
    .find((v) => Array.isArray(v?.variants) && v.variants.length > 0);
  const mp4s = (videoInfo?.variants ?? []).filter(
    (v): v is Variant & { url: string } =>
      v.content_type === "video/mp4" && typeof v.url === "string"
  );
  if (mp4s.length === 0) return { error: "NO_VIDEO" };

  // Smallest bitrate — same audio, least bytes. Unlabelled variants sort last.
  const smallest = mp4s.reduce((best, v) =>
    (v.bitrate ?? Infinity) < (best.bitrate ?? Infinity) ? v : best
  );

  const user = payload.user as { screen_name?: string } | undefined;
  return {
    mediaUrl: smallest.url,
    author: user?.screen_name ? `@${user.screen_name}` : "X",
    text: typeof payload.text === "string" ? payload.text.trim() : "",
    durationMs: videoInfo?.duration_millis ?? null,
    postId,
  };
}

/** Download the resolved media, enforcing the size cap before buffering. */
export async function downloadXAudio(
  mediaUrl: string,
  signal?: AbortSignal
): Promise<Buffer | { error: XImportError }> {
  try {
    const res = await fetch(mediaUrl, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://x.com/" },
      cache: "no-store",
      signal,
    });
    if (!res.ok) return { error: "FETCH_FAILED" };
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_X_AUDIO_BYTES) {
      return { error: "TOO_LARGE" };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    // Content-Length is advisory; the real size is what we actually hold.
    if (bytes.byteLength > MAX_X_AUDIO_BYTES) return { error: "TOO_LARGE" };
    if (bytes.byteLength === 0) return { error: "FETCH_FAILED" };
    return bytes;
  } catch {
    return { error: "FETCH_FAILED" };
  }
}
