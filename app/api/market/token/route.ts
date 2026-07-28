import { Contract, JsonRpcProvider } from "ethers";
import {
  NFT_ABI,
  NFT_CONTRACT_ADDRESS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URLS,
} from "@/lib/mint-contract";
import { fetchNftMetadata, resolveIpfsUrl } from "@/lib/ipfs";
import { fetchActivity } from "@/lib/market/activity";
import { compactRarityFor, getRaritySnapshot } from "@/lib/market/rarity-snapshot";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Fixed supply of the collection, confirmed on-chain during the audit. */
const MAX_TOKEN_ID = 1542;

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; payload: unknown }>();

async function readToken(tokenId: string) {
  let lastError: unknown = null;
  for (const url of ROBINHOOD_RPC_URLS) {
    try {
      const provider = new JsonRpcProvider(url, ROBINHOOD_CHAIN_ID, {
        staticNetwork: true,
        batchMaxCount: 1,
      });
      const contract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, provider);
      const [tokenUri, owner] = await Promise.all([
        contract.tokenURI(tokenId) as Promise<string>,
        contract.ownerOf(tokenId) as Promise<string>,
      ]);
      return { tokenUri, owner };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not read token ${tokenId}: ${String(lastError)}`);
}

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-token", limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("tokenId") ?? "";

  // Reject anything that is not a plain decimal id in range, before it reaches
  // an RPC or a gateway. Fails closed on every malformed input.
  if (!/^\d{1,5}$/.test(raw)) {
    return publicJson({ error: "BAD_TOKEN", message: "Invalid token id." }, 400);
  }
  const tokenId = String(Number(raw));
  if (Number(tokenId) < 1 || Number(tokenId) > MAX_TOKEN_ID) {
    return publicJson({ error: "BAD_TOKEN", message: "Unknown token." }, 404);
  }

  const hit = cache.get(tokenId);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return publicJson(hit.payload);
  }

  try {
    const { tokenUri, owner } = await readToken(tokenId);

    // Metadata comes from IPFS and may be slow or missing; the token is still
    // real without it, so a failure degrades to "no traits" rather than a 500.
    let attributes: Array<{ trait_type?: string; value?: string | number | boolean }> = [];
    let image: string | null = null;
    try {
      const metadata = await fetchNftMetadata(tokenUri);
      attributes = metadata.attributes ?? [];
      // Resolve to an https gateway URL: a raw ipfs:// URI is blocked by the
      // site's own img-src CSP, so returning one guarantees a broken image.
      image = metadata.image ? resolveIpfsUrl(metadata.image) : null;
    } catch {
      attributes = [];
    }

    let history: unknown[] = [];
    try {
      const all = await fetchActivity(200);
      history = all.filter((e) => e.tokenId === tokenId).slice(0, 12);
    } catch {
      history = [];
    }

    // Rarity is a nice-to-have on top of a real token, not a precondition for
    // showing one — a snapshot failure degrades to "no rarity shown", same
    // pattern as metadata/history above.
    let rarity = null;
    try {
      const snapshot = await getRaritySnapshot();
      rarity = compactRarityFor(snapshot, Number(tokenId));
    } catch {
      rarity = null;
    }

    const payload = { tokenId, owner, image, attributes, history, rarity };
    cache.set(tokenId, { at: Date.now(), payload });
    return publicJson(payload);
  } catch (error) {
    return publicError(error, "Could not load this item.");
  }
}
