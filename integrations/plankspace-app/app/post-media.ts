export type PostMedia = {
  mediaUrl: string;
  mediaType: "" | "image" | "video" | "link" | "gift";
  mediaAlt: string;
};

const HTTPS_MEDIA = /^https:\/\//i;
const GIFT_MEDIA = /^gift:(plank|heart|fire|diamond|tree)$/;
const INTERNAL_MEDIA = /^\/api\/media\/[a-f0-9]{12}-[a-z0-9][a-z0-9-]{0,80}\.[a-z0-9]{2,5}$/;

export function normalizePostMedia(value: {
  mediaUrl?: unknown;
  mediaType?: unknown;
  mediaAlt?: unknown;
}): PostMedia {
  const raw = typeof value.mediaUrl === "string" ? value.mediaUrl.trim() : "";
  const requestedType = value.mediaType === "video" ? "video" : value.mediaType === "link" ? "link" : value.mediaType === "gift" ? "gift" : "image";
  const mediaAlt = typeof value.mediaAlt === "string" ? value.mediaAlt.trim().slice(0, 180) : "";
  if (!raw) return { mediaUrl: "", mediaType: "", mediaAlt: "" };

  if (requestedType === "gift") {
    if (!GIFT_MEDIA.test(raw)) throw new Error("Choose a valid PlankSpace gift.");
    return { mediaUrl: raw, mediaType: "gift", mediaAlt };
  }
  if (INTERNAL_MEDIA.test(raw)) return { mediaUrl: raw, mediaType: requestedType === "link" ? "image" : requestedType, mediaAlt };
  if (!HTTPS_MEDIA.test(raw) || raw.length > 2_000) {
    throw new Error("Use a secure HTTPS link or upload supported media.");
  }
  return { mediaUrl: raw, mediaType: requestedType, mediaAlt };
}
