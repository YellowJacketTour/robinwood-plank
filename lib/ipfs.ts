/** Public IPFS gateways tried in order for metadata and images. */
export const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
] as const;

/**
 * Convert ipfs:// CIDs (and nested paths with spaces) into a gateway URL.
 * Path segments are encoded so filenames like "Is This Art4.png" work.
 */
export function resolveIpfsUrl(
  uri: string,
  gateway: (typeof IPFS_GATEWAYS)[number] = IPFS_GATEWAYS[0],
): string {
  if (!uri) return "";
  if (uri.startsWith("http://") || uri.startsWith("https://") || uri.startsWith("data:")) {
    return uri;
  }

  const path = uri.startsWith("ipfs://")
    ? uri.slice("ipfs://".length)
    : uri.startsWith("/ipfs/")
      ? uri.slice("/ipfs/".length)
      : uri;

  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${gateway}${encoded}`;
}

export function ipfsGatewayCandidates(uri: string): string[] {
  if (!uri) return [];
  if (uri.startsWith("http://") || uri.startsWith("https://") || uri.startsWith("data:")) {
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

export async function fetchNftMetadata(tokenUri: string): Promise<NftMetadata> {
  const candidates = ipfsGatewayCandidates(tokenUri);
  let lastError: unknown;

  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      return (await response.json()) as NftMetadata;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to load NFT metadata.");
}
