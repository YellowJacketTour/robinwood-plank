/**
 * Title and artist for a pasted track URL, so neither has to be typed.
 *
 * SERVER ONLY — it fetches third-party URLs. From the browser these are all
 * CORS-blocked anyway, and it would leak the visitor's IP to four platforms.
 *
 * Each source is asked in whatever way it actually supports:
 * - YouTube and SoundCloud publish oEmbed, which is a documented, stable
 *   contract returning `title` and `author_name`.
 * - Suno publishes no oEmbed, so its song page is read for OpenGraph tags.
 *   That is scraping, and it is treated as such: every field is optional and
 *   a miss just means the admin types the title, never an error.
 * - X has neither, but the syndication endpoint behind the import already
 *   returns the post text and handle (see lib/x-media.ts).
 *
 * SSRF is the risk in any "fetch the URL the user gave me" feature. The guard
 * is that a URL is never fetched as given: it is matched against a fixed host
 * list first, and for oEmbed the URL is passed as a query parameter to a
 * hard-coded provider endpoint. There is no input that makes this reach an
 * internal address.
 */

import {
  classifyTrackUrl,
  sunoAudioUrl,
  titleFromPost,
} from "@/lib/woodamp-playlist";
import { fetchXPostAudio, xPostId } from "@/lib/x-media";

export type TrackMeta = { title: string; artist: string };

/** Metadata lookups are a convenience — never let one hang a request. */
const TIMEOUT_MS = 6000;

const UA = "Mozilla/5.0 (compatible; PlankBot/1.0; +https://plank.love)";

async function getText(url: string, signal?: AbortSignal): Promise<string | null> {
  const timer = AbortSignal.timeout(TIMEOUT_MS);
  const composite = signal ? AbortSignal.any([signal, timer]) : timer;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/json" },
      cache: "no-store",
      redirect: "follow",
      signal: composite,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function oEmbed(
  endpoint: string,
  target: string,
  signal?: AbortSignal
): Promise<TrackMeta | null> {
  const body = await getText(
    `${endpoint}?format=json&url=${encodeURIComponent(target)}`,
    signal
  );
  if (!body) return null;
  try {
    const data = JSON.parse(body) as {
      title?: unknown;
      author_name?: unknown;
    };
    const title = typeof data.title === "string" ? data.title.trim() : "";
    const artist =
      typeof data.author_name === "string" ? data.author_name.trim() : "";
    if (!title && !artist) return null;
    // SoundCloud titles read "Flickermood by Forss" — the author is already a
    // separate field, so the suffix is noise in a playlist row.
    const deduped =
      artist && title.toLowerCase().endsWith(` by ${artist.toLowerCase()}`)
        ? title.slice(0, title.length - ` by ${artist}`.length).trim()
        : title;
    return { title: deduped, artist };
  } catch {
    return null;
  }
}

function metaTag(html: string, key: string): string {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
      "i"
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1].trim());
  }
  return "";
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

async function sunoMeta(
  songUrl: string,
  signal?: AbortSignal
): Promise<TrackMeta | null> {
  const html = await getText(songUrl, signal);
  if (!html) return null;
  const title = metaTag(html, "og:title") || metaTag(html, "twitter:title");
  // The description carries the creator: "TITLE by ARTIST (@handle). …"
  const description =
    metaTag(html, "description") || metaTag(html, "og:description");
  const artist = description.match(/\bby\s+(.+?)\s*(?:\(@|\.|$)/i)?.[1] ?? "";
  if (!title && !artist) return null;
  return { title, artist: artist.trim() };
}

/**
 * Best-effort title/artist for any URL the Planklist accepts. Null when the
 * source has nothing to offer — a direct .mp3 URL carries no metadata, and
 * guessing from a filename is worse than leaving the field blank.
 */
export async function fetchTrackMeta(
  src: string,
  signal?: AbortSignal
): Promise<TrackMeta | null> {
  const url = src.trim();
  if (!url) return null;

  if (xPostId(url)) {
    const post = await fetchXPostAudio(url, signal);
    if ("error" in post) return null;
    return {
      title: titleFromPost(post.text, post.author),
      artist: post.author,
    };
  }

  if (sunoAudioUrl(url) && !/^https:\/\/cdn\d*\.suno\.ai\//i.test(url)) {
    return sunoMeta(url, signal);
  }

  const kind = classifyTrackUrl(url);
  if (kind === "embed-youtube") {
    return oEmbed("https://www.youtube.com/oembed", url, signal);
  }
  if (kind === "embed-soundcloud") {
    return oEmbed("https://soundcloud.com/oembed", url, signal);
  }
  return null;
}
