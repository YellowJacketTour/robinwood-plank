const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
]);

function videoIdFromUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let id = "";
    if (host === "youtu.be") {
      id = url.pathname.split("/").filter(Boolean)[0] || "";
    } else if (YOUTUBE_HOSTS.has(host)) {
      const parts = url.pathname.split("/").filter(Boolean);
      id =
        url.searchParams.get("v") ||
        (["embed", "shorts", "live"].includes(parts[0] || "") ? parts[1] : "") ||
        "";
    }
    return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

export function parseYouTubeVideoIds(links: string): string[] {
  const unique = new Set<string>();
  for (const raw of links.split(/[\s,]+/)) {
    const id = videoIdFromUrl(raw);
    if (id) unique.add(id);
    if (unique.size === 8) break;
  }
  return [...unique];
}
