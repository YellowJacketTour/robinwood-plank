/**
 * Browser-safe: no Postgres, no OpenSea, no dns. Live-verified image URL
 * templates only. Add a line only after a real HEAD 200 on that host.
 */
const ERC721_IMAGE_TEMPLATE: Record<string, (tokenId: string) => string> = {
  "0x5af0d9827e0c53e31634944c487d43a2b04f8e38": (id) => `https://www.miladymaker.net/milady/${id}.png`,
};

export function templatedErc721Image(contractAddress: string, tokenId: string): string | null {
  const fn = ERC721_IMAGE_TEMPLATE[contractAddress.toLowerCase()];
  if (!fn || !/^\d+$/.test(tokenId)) return null;
  return fn(tokenId);
}

const INSCRIPTION_ID = /^[0-9a-f]{64}i[0-9]+$/i;

/** Client-safe extra srcs for the collection grid. Chain-specific, exact id only. */
export function catalogArtExtras(chainSlug: string, contractAddress: string, tokenId: string): string[] {
  const out: string[] = [];
  const evm = templatedErc721Image(contractAddress, tokenId);
  if (evm) out.push(evm);
  if (chainSlug === "bitcoin-mainnet" && INSCRIPTION_ID.test(tokenId)) {
    out.push(`https://ordinals.com/content/${tokenId}`);
    out.push(`https://ord-mirror.magiceden.dev/content/${tokenId}`);
  }
  return out;
}
