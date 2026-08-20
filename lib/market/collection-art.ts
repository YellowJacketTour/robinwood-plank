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

function pushUnique(out: string[], url: string | null | undefined): void {
  if (!url) return;
  const t = url.trim();
  if (!t || t.toLowerCase() === "null" || !/^https?:\/\//i.test(t)) return;
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
