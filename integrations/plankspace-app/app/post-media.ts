export type PostMedia = {
  mediaUrl: string;
  mediaType: "" | "image" | "video" | "link" | "gift";
  mediaAlt: string;
};

const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const HTTPS_MEDIA = /^https:\/\//i;
const GIFTS = new Set(["gift:🎁", "gift:💝", "gift:🪵", "gift:🍊", "gift:🌲", "gift:🔥", "gift:🍻", "gift:🪙"]);

export function normalizePostMedia(value: {
  mediaUrl?: unknown;
  mediaType?: unknown;
  mediaAlt?: unknown;
}): PostMedia {
  const raw = typeof value.mediaUrl === "string" ? value.mediaUrl.trim() : "";
  const requestedType = value.mediaType === "video" || value.mediaType === "link" || value.mediaType === "gift" ? value.mediaType : "image";
  const mediaAlt = typeof value.mediaAlt === "string" ? value.mediaAlt.trim().slice(0, 180) : "";
  if (!raw) return { mediaUrl: "", mediaType: "", mediaAlt: "" };

  if (requestedType === "gift") {
    if (!GIFTS.has(raw)) throw new Error("Choose a gift from the PlankSpace gift tray.");
    return { mediaUrl: raw, mediaType: "gift", mediaAlt };
  }

  const dataMatch = DATA_IMAGE.exec(raw);
  if (dataMatch) {
    const estimatedBytes = Math.floor(dataMatch[2].length * 0.75);
    if (estimatedBytes > 3_000_000) throw new Error("Images and GIFs must be under 3 MB.");
    return { mediaUrl: raw, mediaType: "image", mediaAlt };
  }

  if (!HTTPS_MEDIA.test(raw) || raw.length > 2_000) {
    throw new Error("Use an HTTPS media link, or upload a PNG, JPEG, WebP, or GIF under 3 MB.");
  }

  return { mediaUrl: raw, mediaType: requestedType, mediaAlt };
}
