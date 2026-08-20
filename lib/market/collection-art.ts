/**
 * Highest-compatible collection art URLs + ordered fallbacks.
 *
 * Live 2026-08-20: CoinGecko `image.small` is ~6KB; `small_2x` ~20KB;
 * swapping `/small/` → `/large/` on coin-images.coingecko.com is a real
 * 200 (~98KB PNG for Bitcoin Wizards). OrdinalsWallet `icon` is often
 * `/inscription/preview/{id}` (404 or a tiny preview). Full inscription
 * bytes live at ordinals.com/content/{id} (and Magic Eden's ord-mirror).
 *
 * Display: try large first, then 2x, then original. Never invent art.
 * Pixel inscriptions stay pixelated when stretched — bilinear blur is
 * what made the hub hero look soft.
 */

const INSCRIPTION_ID = /(?:inscription\/preview|content)\/([0-9a-f]+i[0-9]+)/i;

/** Same-origin static/proxy paths, ipfs, or http(s). Relative `/images/plank-logo.webp` is RobinWood home art. */
export function isRenderableArtUrl(url: string): boolean {
  const t = url.trim();
  if (!t || t.toLowerCase() === "null" || t.toLowerCase() === "undefined") return false;
  if (t.startsWith("/") && !t.startsWith("//")) return true;
  if (t.startsWith("ipfs://")) return true;
  if (t.startsWith("data:image/")) return true;
  return /^https?:\/\//i.test(t);
}

function pushUnique(out: string[], url: string | null | undefined): void {
  if (!url) return;
  const t = url.trim();
  if (!isRenderableArtUrl(t)) return;
  if (!out.includes(t)) out.push(t);
}

/** Prefer the largest known variant of a sourced URL. Fail closed: unknown hosts stay as-is. */
export function preferHighestResImageUrl(url: string | null | undefined): string | null {
  const list = imageSrcFallbacks(url);
  return list[0] ?? null;
}

export function isInscriptionArtUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "ordinals.com" || host === "www.ordinals.com" || host.endsWith("ordinalswallet.com")) {
      return /\/(content|inscription)\//i.test(url);
    }
    if (host === "ord-mirror.magiceden.dev") return true;
  } catch {
    /* */
  }
  return INSCRIPTION_ID.test(url);
}

/**
 * Ordered candidates for <Image>: largest compatible first.
 * Hero should walk this list on error instead of jumping to the placeholder.
 */
export function imageSrcFallbacks(src: string | null | undefined): string[] {
  if (!src || !src.trim() || src.trim().toLowerCase() === "null") return [];
  const original = src.trim();
  const high: string[] = [];
  const mid: string[] = [];
  const low: string[] = [];

  if (/coin-images\.coingecko\.com/i.test(original)) {
    pushUnique(high, original.replace(/\/small(?:_2x)?\//i, "/large/"));
    pushUnique(mid, original.replace(/\/small\//i, "/small_2x/"));
  }

  try {
    if (!/^https?:\/\//i.test(original)) {
      pushUnique(low, original);
      const outEarly: string[] = [];
      for (const u of [...high, ...mid, ...low]) pushUnique(outEarly, u);
      return outEarly.length ? outEarly : isRenderableArtUrl(original) ? [original] : [];
    }
    const parsed = new URL(original);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith("seadn.io") || host.endsWith("openseauserdata.com") || host === "i2.seadn.io") {
      const big = new URL(original);
      big.searchParams.set("w", "2000");
      pushUnique(high, big.toString());
      const med = new URL(original);
      med.searchParams.set("w", "1000");
      pushUnique(mid, med.toString());
      pushUnique(mid, original.replace(/=s\d+/i, "=s1200"));
    }
    if (host.includes("magiceden") || host.includes("arweave.net")) {
      pushUnique(high, original);
    }
  } catch {
    /* keep original */
  }

  const ins = original.match(INSCRIPTION_ID);
  if (ins) {
    const id = ins[1];
    pushUnique(high, `https://ordinals.com/content/${id}`);
    pushUnique(high, `https://ord-mirror.magiceden.dev/content/${id}`);
    pushUnique(low, `https://turbo.ordinalswallet.com/inscription/preview/${id}`);
  }

  pushUnique(low, original);
  const out: string[] = [];
  for (const u of [...high, ...mid, ...low]) pushUnique(out, u);
  return out;
}

export function pickBestCoinGeckoImage(image: {
  small?: string | null;
  small_2x?: string | null;
  large?: string | null;
} | null | undefined): string | null {
  return preferHighestResImageUrl(image?.large || image?.small_2x || image?.small || null);
}
