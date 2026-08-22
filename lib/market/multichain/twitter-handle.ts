/**
 * Shared creator-handle extraction, factored out once a second discovery
 * source (ordiscan-collection-scan.ts) needed the exact same logic
 * unisat-collection-list-scan.ts already had inline as `extractTwitterHandle`.
 * Never fabricated: null when the field is absent, blank, or clearly not a
 * handle/URL this app recognizes.
 */

/** Real creator handle from a raw twitter/x field -- strips a leading "@"
 * or reduces a full twitter.com/x.com URL down to the bare handle. */
export function extractHandleFromTwitterUrl(twitter: string | null | undefined): string | null {
  const trimmed = twitter?.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/(?:twitter\.com|x\.com)\/@?([A-Za-z0-9_]{1,15})/i);
  if (urlMatch) return urlMatch[1];
  const handle = trimmed.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
}
