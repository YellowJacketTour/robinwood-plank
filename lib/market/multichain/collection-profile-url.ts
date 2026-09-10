export const MARKETPLACE_HANDLES = ["opensea", "openseapro", "opensea_io", "magiceden", "blur_io", "blureth", "looksrare", "x2y2_io", "rarible", "coingecko", "nftgo", "tensor_hq"];

export function profileUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function profileLink(field: "website" | "twitter" | "discord", raw: unknown): string | null {
  const href = profileUrl(raw);
  if (!href || field === "website") return href;
  const url = new URL(href);
  const host = url.hostname.replace(/^www\./, "");
  if (field === "discord") return (host === "discord.gg" || (host === "discord.com" && url.pathname.startsWith("/invite/"))) ? href : null;
  const match = /^\/@?([a-z0-9_]{1,15})\/?$/i.exec(url.pathname);
  return ["x.com", "twitter.com"].includes(host) && match && ![...MARKETPLACE_HANDLES, "home", "share", "intent", "search", "i", "hashtag"].includes(match[1].toLowerCase()) ? href : null;
}
