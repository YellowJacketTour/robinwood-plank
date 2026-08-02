/**
 * Gallery panel identity — the same shape lib/market/navigation.ts gives the
 * marketplace, for the same reason: the tab id is a public contract. It appears
 * in `/gallery?tab=…`, so people bookmark it and paste it to each other, and it
 * cannot be renamed casually.
 *
 * Extracted rather than left inline in components/Gallery.tsx because the test
 * suite is `tsx --test test/market/*.test.ts` — pure modules only, no React or
 * DOM harness. Keeping the parser here is what makes any of this testable.
 */

export type GalleryPanel = "gallery" | "insights" | "my-nfts";

export const GALLERY_TABS: ReadonlyArray<{ id: GalleryPanel; label: string }> = [
  { id: "gallery", label: "Grid" },
  { id: "insights", label: "Insights" },
  // Deliberately the same id the marketplace already uses for its own
  // wallet-scoped tab (lib/market/navigation.ts). Two different surfaces, one
  // vocabulary — `?tab=my-nfts` means "mine" everywhere on the site.
  { id: "my-nfts", label: "My NFTs" },
];

/** The panel a bare `/gallery` shows, and the one whose `tab` param is omitted. */
export const DEFAULT_GALLERY_PANEL: GalleryPanel = "gallery";

/**
 * `?tab=` → panel, total and forgiving. Anything unrecognised — absent,
 * empty, misspelled, or a value from a future release someone pasted into an
 * older deploy — resolves to the default rather than rendering nothing.
 */
export function parseGalleryTab(value: string | null | undefined): GalleryPanel {
  const hit = GALLERY_TABS.find((tab) => tab.id === value);
  return hit ? hit.id : DEFAULT_GALLERY_PANEL;
}

/**
 * The string→number boundary between the two halves of this feature.
 *
 * getOwnedTokenIds() (lib/market/inventory.ts) returns token ids as STRINGS,
 * decoded from eth_call words. GalleryNft.tokenId (lib/gallery-types.ts) is a
 * NUMBER. Comparing the two directly always fails, silently, and the tab just
 * renders empty — so the conversion lives in one named place instead of being
 * re-derived at the call site.
 *
 * Unusable entries are dropped rather than admitted, since a junk member would
 * neither match a real tokenId nor be visible as a bug.
 *
 * Note the empty-string trap: `Number("")` is 0, not NaN, so a `Number.isFinite`
 * guard alone would silently admit token 0 for every blank entry. Match the
 * digits explicitly instead of coercing and hoping.
 */
export function toNumericTokenIds(ids: Iterable<string>): Set<number> {
  const out = new Set<number>();
  for (const id of ids) {
    if (!/^\d+$/.test(String(id).trim())) continue;
    const n = Number(String(id).trim());
    if (Number.isSafeInteger(n)) out.add(n);
  }
  return out;
}
