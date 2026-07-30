"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import NftImage from "@/components/NftImage";
import { getMintReadClient, touchMintReadClient } from "@/lib/robinhood-provider";
import { fetchNftMetadata } from "@/lib/ipfs";
import {
  ensureNftCacheHydrated,
  getCachedSupply,
  getCachedToken,
  hasFreshMetadata,
  listCachedScoredTokens,
  putTokenMetadata,
  putTokenUri,
  setCachedSupply,
} from "@/lib/nft-cache";
import { computeRaritySnapshot, formatRank, tierColor } from "@/lib/rarity";

const PREVIEW_COUNT = 5;

type PreviewNft = {
  tokenId: number;
  imageUri: string;
  name: string;
};

/**
 * Condensed landing-page teaser (DESIGN.md: "marketing surfaces may breathe
 * … while remaining recognizably RobinWood" — the full interactive
 * grid/search/insights workbench stays a /gallery job, this just proves the
 * collection is real and live). Reuses the same cache + rarity registries as
 * the full Gallery component rather than re-implementing hydration — no
 * hardcoded counts or placeholder art.
 */
export default function GalleryTeaser() {
  const [totalMinted, setTotalMinted] = useState(0);
  const [preview, setPreview] = useState<PreviewNft[]>([]);

  useEffect(() => {
    let alive = true;
    ensureNftCacheHydrated();

    const cachedSupply = getCachedSupply();
    if (cachedSupply?.value) setTotalMinted(cachedSupply.value);

    async function run() {
      try {
        const { contract } = await getMintReadClient();
        const supply = Number(await contract.totalSupply());
        if (!alive || supply <= 0) return;
        touchMintReadClient();
        setCachedSupply(supply);
        setTotalMinted(supply);

        const newestIds: number[] = [];
        for (let id = supply; id >= 1 && newestIds.length < PREVIEW_COUNT; id -= 1) {
          newestIds.push(id);
        }

        const hydrated = await Promise.all(
          newestIds.map(async (tokenId): Promise<PreviewNft | null> => {
            const cached = getCachedToken(tokenId);
            if (hasFreshMetadata(tokenId) && cached?.imageUri) {
              return { tokenId, imageUri: cached.imageUri, name: cached.name };
            }
            try {
              const tokenUri =
                cached?.tokenUri || ((await contract.tokenURI(tokenId)) as string);
              if (tokenUri && !cached?.tokenUri) putTokenUri(tokenId, tokenUri);
              if (!tokenUri) return null;
              const metadata = await fetchNftMetadata(tokenUri);
              const rec = putTokenMetadata(tokenId, {
                tokenUri,
                name: metadata.name?.trim() || `RobinWood Plank #${tokenId}`,
                description: metadata.description?.trim() || "",
                imageUri: (metadata.image || "").trim(),
                attributes: Array.isArray(metadata.attributes) ? metadata.attributes : [],
                owner: cached?.owner || "",
              });
              return rec.imageUri ? { tokenId, imageUri: rec.imageUri, name: rec.name } : null;
            } catch {
              return null;
            }
          }),
        );

        if (!alive) return;
        touchMintReadClient();
        setPreview(hydrated.filter((n): n is PreviewNft => n !== null));
      } catch {
        // Keep whatever cached preview we already painted — teaser is
        // decorative-adjacent, never worth surfacing a hard error for.
      }
    }

    // Paint from cache immediately if we have any scored tokens already.
    const scored = listCachedScoredTokens();
    if (scored.length) {
      const newestCached = [...scored].sort((a, b) => b.tokenId - a.tokenId).slice(0, PREVIEW_COUNT);
      const painted = newestCached
        .map((t) => {
          const rec = getCachedToken(t.tokenId);
          return rec?.imageUri ? { tokenId: t.tokenId, imageUri: rec.imageUri, name: rec.name } : null;
        })
        .filter((n): n is PreviewNft => n !== null);
      if (painted.length) setPreview(painted);
    }

    void run();
    return () => {
      alive = false;
    };
  }, []);

  // `preview` isn't read directly below — it's the recompute trigger: rarity
  // reads the shared token cache (mutated by `run()`, not by React state), so
  // this needs to re-run whenever preview updates or new cache entries never
  // get scored.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rarity = useMemo(() => computeRaritySnapshot(listCachedScoredTokens()), [preview]);

  return (
    <div className="dense-card fx-in flex h-full flex-col overflow-hidden p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[0.68rem] font-black uppercase tracking-[0.1em] text-gold-300">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"
            aria-hidden="true"
          />
          {totalMinted > 0 ? `Live gallery · ${totalMinted.toLocaleString()} minted` : "Live gallery"}
        </span>
        <Link
          href="/gallery"
          className="inline-flex min-h-9 shrink-0 items-center rounded-lg border border-line-strong px-3 text-xs font-bold text-gold-300 transition hover:border-gold-400"
        >
          Open full gallery ↗
        </Link>
      </div>

      {preview.length > 0 ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {preview.map((nft) => {
            const r = rarity.byTokenId.get(nft.tokenId);
            return (
              <Link
                key={nft.tokenId}
                href={`/gallery?item=${nft.tokenId}`}
                className="group relative aspect-square overflow-hidden rounded-lg border border-line bg-wood-900"
              >
                <NftImage
                  imageUri={nft.imageUri}
                  alt={nft.name}
                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                />
                <span className="absolute left-1 top-1 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[0.6rem] font-bold text-gold-300">
                  #{nft.tokenId}
                </span>
                {r && (
                  <span
                    className="absolute bottom-1 right-1 rounded-full bg-black/75 px-1.5 py-0.5 text-[0.55rem] font-black uppercase"
                    style={{ color: tierColor(r.tier) }}
                  >
                    {formatRank(r.rank)}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ) : (
        <p className="flex-1 py-8 text-center text-sm text-cream-muted">Loading minted art…</p>
      )}
    </div>
  );
}
