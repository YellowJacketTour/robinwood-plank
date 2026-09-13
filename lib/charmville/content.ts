import manifest from "./content-manifest.json";

/** A renderer's pinned content revision; no balances or gameplay authority. */
export const CHARMVILLE_CONTENT_REVISION = manifest.revision;
export type CharmvilleAssetId = keyof typeof manifest.assets;

export function charmvilleAssetUrl(id: CharmvilleAssetId): string {
  return manifest.assets[id].url;
}

const sourceUrls = new Map<string, string>(
  Object.values(manifest.assets).map(asset => [asset.source, asset.url]),
);

/** Bridge existing scene sources to immutable content; unknown assets stay local. */
export function charmvilleAssetFromSource(source: string): string {
  return sourceUrls.get(source) ?? source;
}

export const CHARMVILLE_DEFINITIONS_URL = manifest.definitions.url;
