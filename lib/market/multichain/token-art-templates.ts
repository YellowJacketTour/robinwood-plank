/**
 * Browser-safe: no Postgres, no OpenSea, no dns. Live-verified image URL
 * templates only.
 *
 * VERIFY BOTH HALVES. A template is a (contract -> url) PAIR, and this file's
 * old rule -- "add a line only after a real HEAD 200 on that host" -- checked
 * only the url. The single entry here keyed Milady as
 * 0x5af0d9827e0c53e31634944c487d43a2b04f8e38, which shares a prefix with the
 * real contract and diverges after 16 hex characters.
 *
 * Checked on-chain 2026-09-09 with eth_call name():
 *   0x5af0d9827e0c53e31634944c487d43a2b04f8e38 -> no code at all
 *   0x5af0d9827e0c53e4799bb226655a1de152a425a5 -> "Milady"
 *
 * So the only template in the codebase could never match anything, and every
 * Milady tile fell through to a per-token OpenSea call. The url was fine; the
 * KEY was wrong, and a url-only check cannot see that. A wrong key here fails
 * exactly like a missing entry -- silently, and slower.
 */
const ERC721_IMAGE_TEMPLATE: Record<string, (tokenId: string) => string> = {
  // Milady Maker. Contract confirmed on-chain (name() == "Milady"); url
  // confirmed HTTP 200 image/png for ids 0, 7957 and 9975.
  "0x5af0d9827e0c53e4799bb226655a1de152a425a5": (id) => `https://www.miladymaker.net/milady/${id}.png`,
};

/** Exported so a test can assert every key is a well-formed, lowercase
 *  address -- the shape a typo'd key fails. */
export const ERC721_IMAGE_TEMPLATE_KEYS = Object.keys(ERC721_IMAGE_TEMPLATE);

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
