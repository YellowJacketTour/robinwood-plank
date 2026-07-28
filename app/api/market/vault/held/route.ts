import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { getVaultHeldTokenIds } from "@/lib/market/vault-held";
import { resolveTokenImage } from "@/lib/market/token-image";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Cap how many images this route resolves per request — the vault could
 * hold hundreds of tokens; the picker only needs enough to fill a grid, not
 * the full set, and every extra id is an IPFS round trip. */
const MAX_PREVIEWED = 60;

/**
 * Visual token picker for Redeem — "which specific Plank am I taking out" —
 * needs real artwork, not a bare id typed blind. See lib/market/vault-held.ts
 * for how "currently held" is derived (Transfer-log replay, not a stored
 * list, since the vault contract itself only exposes count/membership).
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "vault-held", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const ids = await getVaultHeldTokenIds();
    const previewIds = ids.slice(0, MAX_PREVIEWED);
    const images = await Promise.all(
      previewIds.map((id) => resolveTokenImage(NFT_CONTRACT_ADDRESS, id))
    );
    const tokens = previewIds.map((tokenId, i) => ({ tokenId, imageUrl: images[i] ?? null }));
    return publicJson({ count: ids.length, tokens });
  } catch (error) {
    return publicError(error, "Could not read the vault's held tokens right now.");
  }
}
