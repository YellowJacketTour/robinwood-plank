/**
 * Real owned-token lookup for a wallet, on a foreign chain, for one
 * collection -- powers "My tokens"/Send on the multichain browse surface.
 * Server-side so the Alchemy key path stays consistent with every other
 * multichain route (this one can run on the free "demo" key even so, but
 * keeping it server-side avoids yet another client-exposed key path).
 */
import { NextRequest, NextResponse } from "next/server";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { rpcCall } from "@/lib/market/multichain/discovery/evm-log-scan";
import { resolveOwnedTokenIds } from "@/lib/market/multichain/owned-token-resolver";
import { ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";
import { publicError, rateLimit } from "@/lib/security";
import { isSolanaChainSlug, isBitcoinChainSlug, isRobinhoodChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import { pickAlchemyKey } from "@/lib/market/multichain/discovery/alchemy-key-pool";
import { edgeRead } from "@/lib/market/multichain/edge/read-gateway";
import { meteredFetch } from "@/lib/market/multichain/edge/provider-ledger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALCHEMY_SUBDOMAIN: Record<string, string> = {
  "eth-mainnet": "eth-mainnet",
  "polygon-mainnet": "polygon-mainnet",
  "arb-mainnet": "arb-mainnet",
  "base-mainnet": "base-mainnet",
  "opt-mainnet": "opt-mainnet",
  "bnb-mainnet": "bnb-mainnet",
  "avax-mainnet": "avax-mainnet",
};

/**
 * Alchemy's NFT API (getNFTsForOwner) has no listing for Robinhood Chain --
 * it's a private Arbitrum Orbit L3 (chainId 4663), confirmed by
 * robinhood-chain-scan.ts's own header never including it in
 * ALCHEMY_NETWORK_SUBDOMAIN. So ownership is resolved via raw RPC directly
 * against Robinhood Chain, same rpcCall primitive the discovery scanner
 * already uses. Bounded at MAX_ENUMERATED_TOKENS / MAX_SCANNED_TRANSFER_LOGS
 * so a single request can't fan out unboundedly.
 */
function encodeUint(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}
/**
 * Try ERC721Enumerable first (balanceOf + tokenOfOwnerByIndex) -- exact and
 * cheap when supported. Falls back to a bounded Transfer-log scan (to==owner
 * minus a later from==owner, the same "current holder" derivation the
 * discovery scanner's own activity tally is built on) when the contract
 * doesn't implement it, which reverts/errors on the very first
 * tokenOfOwnerByIndex call rather than partially enumerating.
 */
export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-owned", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const owner = searchParams.get("owner");
  const contractAddress = searchParams.get("contractAddress");

  if (!chainSlug || !owner || !contractAddress) {
    return NextResponse.json({ error: "chainSlug, owner, and contractAddress are required" }, { status: 400 });
  }

  // SOLANA -- real, keyless Magic Eden wallet-tokens lookup. Confirmed live
  // 2026-08-18: GET /v2/wallets/{wallet}/tokens?collection_symbol={symbol}
  // needs no API key, returning the real tokens that wallet currently holds
  // in that collection with real art/name already embedded.
  if (isSolanaChainSlug(chainSlug)) {
    try {
      type MeToken = { mintAddress: string; name?: string; image?: string };
      const { value: raw } = await edgeRead<MeToken[]>(
        { kind: "owned", chainSlug, subject: owner, variant: { collection: contractAddress, limit: 100 } },
        async () => {
          const res = await meteredFetch(
            `https://api-mainnet.magiceden.dev/v2/wallets/${encodeURIComponent(owner)}/tokens?collection_symbol=${encodeURIComponent(contractAddress)}&limit=100`,
            { headers: { accept: "application/json" } },
            { source: "magiceden", chainSlug }
          );
          if (!res.ok) throw new Error(`Magic Eden ${res.status}`);
          return (await res.json()) as MeToken[];
        },
        { provider: "magiceden" }
      );
      const items = raw.map((t) => ({ tokenId: t.mintAddress, name: t.name ?? null, imageUrl: t.image ?? null }));
      return NextResponse.json({ tokenIds: items.map((i) => i.tokenId), items }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return publicError(error, "Failed to load owned Solana tokens");
    }
  }

  // BITCOIN ORDINALS -- honest empty state, same reasoning as listings/
  // route.ts's "bitcoin" branch: no keyless/documented owned-inscriptions
  // query endpoint was found for UniSat's Marketplace API during this pass.
  if (isBitcoinChainSlug(chainSlug)) {
    return NextResponse.json({ tokenIds: [], items: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  if (isRobinhoodChainSlug(chainSlug)) {
    try {
      const rpcUrl = ROBINHOOD_RPC_URLS[0];
      if (!rpcUrl) {
        return NextResponse.json({ error: "Robinhood Chain RPC is not configured on this deployment." }, { status: 503 });
      }
      const tokenIds = await resolveOwnedTokenIds(rpcUrl, contractAddress, owner);
      // Same bound listings/route.ts and offers/route.ts use for per-token
      // art fan-out -- most wallets hold a handful of tokens, this only
      // guards a pathological case.
      const artLookupIds = tokenIds.slice(0, 30);
      const artEntries = await Promise.all(
        artLookupIds.map(async (tokenId) => {
          try {
            const uriHex = await rpcCall<string>(rpcUrl, "eth_call", [
              { to: contractAddress, data: "0xc87b56dd" + encodeUint(BigInt(tokenId)) },
              "latest",
            ]);
            if (!uriHex || uriHex === "0x" || uriHex.length < 130) return [tokenId, { name: null, imageUrl: null }] as const;
            const lengthHex = uriHex.slice(66, 130);
            const length = Number.parseInt(lengthHex, 16);
            if (!Number.isFinite(length) || length <= 0 || length > 500) return [tokenId, { name: null, imageUrl: null }] as const;
            const dataHex = uriHex.slice(130, 130 + length * 2);
            let rawUri = Buffer.from(dataHex, "hex").toString("utf8").replace(/\0/g, "").trim();
            if (!rawUri) return [tokenId, { name: null, imageUrl: null }] as const;
            if (rawUri.startsWith("ipfs://")) rawUri = `https://ipfs.io/ipfs/${rawUri.slice("ipfs://".length)}`;
            let json: { name?: string; image?: string };
            if (rawUri.startsWith("data:application/json")) {
              const commaIdx = rawUri.indexOf(",");
              const payload = rawUri.slice(commaIdx + 1);
              json = rawUri.includes("base64")
                ? JSON.parse(Buffer.from(payload, "base64").toString("utf8"))
                : JSON.parse(decodeURIComponent(payload));
            } else {
              const res = await fetch(rawUri, { signal: AbortSignal.timeout(8000) });
              if (!res.ok) return [tokenId, { name: null, imageUrl: null }] as const;
              json = (await res.json()) as { name?: string; image?: string };
            }
            const image = json.image?.startsWith("ipfs://")
              ? `https://ipfs.io/ipfs/${json.image.slice("ipfs://".length)}`
              : (json.image ?? null);
            return [tokenId, { name: json.name ?? null, imageUrl: image }] as const;
          } catch {
            return [tokenId, { name: null, imageUrl: null }] as const;
          }
        })
      );
      const artByToken = new Map(artEntries);
      const items = tokenIds.map((tokenId) => ({
        tokenId,
        name: artByToken.get(tokenId)?.name ?? null,
        imageUrl: artByToken.get(tokenId)?.imageUrl ?? null,
      }));
      return NextResponse.json({ tokenIds, items }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return publicError(error, "Failed to load owned Robinhood-Chain tokens");
    }
  }

  if (!foreignChainByChainSlug(chainSlug)) {
    return NextResponse.json({ error: `"${chainSlug}" is not a supported foreign chain` }, { status: 400 });
  }
  const subdomain = ALCHEMY_SUBDOMAIN[chainSlug];
  if (!subdomain) {
    return NextResponse.json({ error: `No Alchemy NFT API mapping for "${chainSlug}"` }, { status: 400 });
  }

  const keyEntry = await pickAlchemyKey("live");
  const apiKey = keyEntry?.apiKey || "demo";
  type OwnedArt = { tokenId: string; name: string | null; imageUrl: string | null };
  let items: OwnedArt[];
  try {
    const { value } = await edgeRead<OwnedArt[]>(
      { kind: "owned", chainSlug, subject: owner.toLowerCase(), variant: { collection: contractAddress.toLowerCase() } },
      async () => {
        const url = new URL(`https://${subdomain}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner`);
        url.searchParams.set("owner", owner);
        url.searchParams.append("contractAddresses[]", contractAddress);
        // withMetadata=true -- the "My NFTs" tab renders real card art (matching
        // the native MyNfts.tsx grid), not just a bare list of token ids.
        url.searchParams.set("withMetadata", "true");
        const res = await meteredFetch(url.toString(), undefined, { source: "alchemy-nft", keyId: keyEntry?.id ?? null, chainSlug, costUnits: 480 });
        if (!res.ok) throw new Error(`Alchemy ${res.status}`);
        const data = (await res.json()) as {
          ownedNfts?: Array<{ tokenId: string; name?: string; image?: { cachedUrl?: string; originalUrl?: string } }>;
        };
        return (data.ownedNfts ?? []).map((n) => ({
          tokenId: n.tokenId,
          name: n.name ?? null,
          imageUrl: n.image?.cachedUrl ?? n.image?.originalUrl ?? null,
        }));
      },
      { provider: "alchemy" }
    );
    items = value;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Alchemy request failed" }, { status: 502 });
  }
  return NextResponse.json(
    { tokenIds: items.map((i) => i.tokenId), items },
    { headers: { "Cache-Control": "no-store" } }
  );
}
