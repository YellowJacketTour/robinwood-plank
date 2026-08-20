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
