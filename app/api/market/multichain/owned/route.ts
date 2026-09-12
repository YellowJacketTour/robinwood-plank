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
import { readProjectedTokensByIds } from "@/lib/market/multichain/collection-token-store";
import {
  planArtLookups,
  mapWithConcurrency,
  ART_RPC_DEADLINE_MS,
  MAX_CONCURRENT_ART_RPC,
} from "@/lib/market/multichain/art-lookup-plan";

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

      // READ THE ARCHIVE FIRST -- the leg this route never had either.
      //
      // The per-token art below is an `eth_call` for tokenURI plus, for an
      // off-chain URI, an HTTP fetch of the metadata document, against ONE
      // Robinhood-Chain RPC endpoint (ROBINHOOD_RPC_URLS[0] -- there is no
      // pool to spread it over). That is the real hazard, and it is why a
      // bound on THAT leg is legitimate pacing.
      //
      // It is not a reason to cap the page. `plank_collection_tokens` holds
      // this collection's token name and image already, keyed
      // (chain_slug, collection_slug, token_id), and reading it is ONE
      // indexed query for however many ids the wallet holds. `.catch`
      // because the archive must never be able to take "My tokens" down --
      // if Postgres is unavailable this degrades to exactly the RPC path
      // that ran before.
      const archivedArt = tokenIds.length
        ? await readProjectedTokensByIds(chainSlug, contractAddress, tokenIds).catch(
            () => new Map<string, { name: string | null; imageUrl: string | null }>()
          )
        : new Map<string, { name: string | null; imageUrl: string | null }>();

      const artByToken = new Map<string, { name: string | null; imageUrl: string | null }>();
      for (const [tokenId, row] of archivedArt) {
        // An archived row with neither name nor image answers nothing; let
        // it fall through to the RPC rather than render a blank card with
        // the archive's authority behind it.
        if (!row.imageUrl && !row.name) continue;
        artByToken.set(tokenId, { name: row.name ?? null, imageUrl: row.imageUrl ?? null });
      }

      // THE BOUND THAT REMAINS IS A DEADLINE, NOT A COUNT.
      //
      // This was `tokenIds.slice(0, 30)`: a wallet holding 31 tokens got
      // `{name: null, imageUrl: null}` from the thirty-first onwards and the
      // response said nothing, so a partial answer was byte-for-byte
      // indistinguishable from a complete one.
      //
      // A count is the wrong instrument here for the same reason PR #483
      // rejected a row cap for the trait index: the hazard is not "too many
      // tokens", it is "this request runs past its deadline holding an RPC
      // connection". Time is what actually bounds that, so the RPC leg runs
      // against ART_RPC_DEADLINE_MS and takes as many tokens as it can
      // finish inside it. A wallet whose tokens resolve fast gets all of
      // them; a slow RPC costs the deadline and no more.
      //
      // MAX_CONCURRENT_ART_RPC is a concurrency ceiling, not a throughput
      // one -- the deadline stops the work; this only stops the fan-out from
      // opening hundreds of simultaneous sockets against a single node.
      // Whatever the deadline leaves unfinished is reported as artIncomplete
      // rather than returned as art that does not exist.
      const artPlan = planArtLookups(tokenIds, (id) => artByToken.has(id), tokenIds.length);
      const rpcDeadline = Date.now() + ART_RPC_DEADLINE_MS;
      const skippedPastDeadline: string[] = [];
      const artEntries = await mapWithConcurrency(artPlan.remoteIds, MAX_CONCURRENT_ART_RPC, async (tokenId) => {
        if (Date.now() >= rpcDeadline) {
          // Not an answer -- a token we ran out of time to ask about.
          // Counted, never silently nulled.
          skippedPastDeadline.push(tokenId);
          return [tokenId, null] as const;
        }
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
      });
      for (const [tokenId, art] of artEntries) {
        // null means "never asked" (past the deadline), which is already
        // counted in skippedPastDeadline; do not write it into the map as
        // though it were a real "this token has no art" answer.
        if (art) artByToken.set(tokenId, art);
      }
      const items = tokenIds.map((tokenId) => ({
        tokenId,
        name: artByToken.get(tokenId)?.name ?? null,
        imageUrl: artByToken.get(tokenId)?.imageUrl ?? null,
      }));
      // A TOKEN WE NEVER ASKED ABOUT IS NOT A TOKEN WITH NO ART.
      //
      // `{name: null, imageUrl: null}` used to mean both, and the caller had
      // no way to tell them apart -- so a wallet holding 31 tokens looked
      // exactly like a wallet whose 31st token has no metadata. Only one of
      // those is worth retrying.
      const unresolved = [...artPlan.unresolvedIds, ...skippedPastDeadline];
      return NextResponse.json(
        {
          tokenIds,
          items,
          artCoverage: {
            complete: unresolved.length === 0,
            distinctTokens: artPlan.archiveIds.length,
            fromArchive: artPlan.archiveIds.length - artPlan.remoteIds.length - artPlan.unresolvedIds.length,
            remoteLookups: artPlan.remoteIds.length - skippedPastDeadline.length,
            unresolvedTokens: unresolved.length,
            reason: unresolved.length ? "rpc-deadline-exceeded" : null,
            remoteDeadlineMs: ART_RPC_DEADLINE_MS,
          },
          artIncomplete: unresolved.length > 0,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
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
