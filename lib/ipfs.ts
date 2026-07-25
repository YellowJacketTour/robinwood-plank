import { getCachedMetadata, setCachedMetadata } from "@/lib/nft-cache";

/**
 * Public IPFS gateways tried for metadata and images.
 * Order: fastest/reliable first; race the top few on metadata fetch.
 */
export const IPFS_GATEWAYS = [
  "https://nftstorage.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://4everland.io/ipfs/",
] as const;

/**
 * Convert ipfs:// CIDs (and nested paths with spaces) into a gateway URL.
 * Path segments are encoded so filenames like "Is This Art4.png" work.
 */
export function resolveIpfsUrl(
  uri: string,
  gateway: string = IPFS_GATEWAYS[0],
): string {
  if (!uri) return "";
  if (uri.startsWith("http://") || uri.startsWith("https://") || uri.startsWith("data:")) {
    return uri;
  }

  let path = uri.startsWith("ipfs://")
    ? uri.slice("ipfs://".length)
    : uri.startsWith("/ipfs/")
      ? uri.slice("/ipfs/".length)
      : uri;

  // ipfs://ipfs/CID → CID
  if (path.startsWith("ipfs/")) path = path.slice(5);

  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${gateway}${encoded}`;
}

export function ipfsGatewayCandidates(uri: string): string[] {
  if (!uri) return [];
  if (uri.startsWith("data:")) return [uri];

  // Already an http(s) URL — still try gateway rewrites if it looks like /ipfs/
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    const match = uri.match(/\/ipfs\/(.+)$/i);
    if (match) {
      const cidPath = match[1];
      return [
        uri,
        ...IPFS_GATEWAYS.map((gateway) => `${gateway}${cidPath}`),
      ];
    }
    return [uri];
  }

  return IPFS_GATEWAYS.map((gateway) => resolveIpfsUrl(uri, gateway));
}

export type NftAttribute = {
  trait_type?: string;
  value?: string | number | boolean;
};

export type NftMetadata = {
  name?: string;
  description?: string;
  image?: string;
  attributes?: NftAttribute[];
};

function isUsableMetadata(data: NftMetadata | null | undefined): data is NftMetadata {
  if (!data || typeof data !== "object") return false;
  const image = typeof data.image === "string" ? data.image.trim() : "";
  const attrs = Array.isArray(data.attributes) ? data.attributes : [];
  const name = typeof data.name === "string" ? data.name.trim() : "";
  // Need at least image or traits — bare name is not enough
  return Boolean(image || attrs.length > 0 || name);
}

async function fetchJsonFromUrl(
  url: string,
  timeoutMs: number,
): Promise<NftMetadata> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
    headers: { Accept: "application/json, text/plain, */*" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = (await response.json()) as NftMetadata;
  if (!isUsableMetadata(data)) {
    throw new Error("Empty metadata payload");
  }
  return data;
}

/**
 * Race the first N gateways, then walk the rest serially.
 * Never permanently cache failures — only successful usable metadata.
 */
export async function fetchNftMetadata(
  tokenUri: string,
  options?: { force?: boolean },
): Promise<NftMetadata> {
  if (!tokenUri) throw new Error("Empty tokenURI");

  if (!options?.force) {
    const cached = getCachedMetadata(tokenUri);
    if (cached && isUsableMetadata(cached)) {
      // Prefer cache hits that include image; otherwise re-fetch
      if (cached.image?.trim() || (cached.attributes?.length ?? 0) > 0) {
        return cached;
      }
    }
  }

  const candidates = ipfsGatewayCandidates(tokenUri);
  let lastError: unknown;

  // Race first 3 gateways for speed (newest mints need this)
  const raceN = Math.min(3, candidates.length);
  if (raceN > 0) {
    try {
      const data = await Promise.any(
        candidates.slice(0, raceN).map((url) => fetchJsonFromUrl(url, 8_000)),
      );
      setCachedMetadata(tokenUri, data);
      return data;
    } catch (error) {
      lastError = error;
    }
  }

  // Remaining gateways serially with slightly longer timeout
  for (const url of candidates.slice(raceN)) {
    try {
      const data = await fetchJsonFromUrl(url, 12_000);
      setCachedMetadata(tokenUri, data);
      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to load NFT metadata.");
}
