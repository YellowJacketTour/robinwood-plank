"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  BrowserProvider,
  getAddress,
  isAddress,
  type Eip1193Provider,
} from "ethers";
import Reveal from "@/components/Reveal";
import {
  fetchNftMetadata,
  ipfsGatewayCandidates,
  type NftAttribute,
  type NftMetadata,
} from "@/lib/ipfs";
import {
  NFT_CONTRACT_ADDRESS,
  ROBINHOOD_EXPLORER_URL,
} from "@/lib/mint-contract";
import {
  getMintReadClient,
  touchMintReadClient,
} from "@/lib/robinhood-provider";
import {
  ensureNftCacheHydrated,
  getCachedInventory,
  getCachedToken,
  listCachedScoredTokens,
  putTokenMetadata,
  putTokenUri,
  setCachedInventory,
} from "@/lib/nft-cache";
import {
  TIER_ORDER,
  computeRaritySnapshot,
  formatRank,
  tierAnimationClass,
  tierCardStyle,
  tierColor,
  tierGlow,
  type RarityTier,
  type TokenRarity,
} from "@/lib/rarity";
import { holoHandlers } from "@/lib/holo";

type EthereumProvider = Eip1193Provider & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export type OwnedNft = {
  tokenId: number;
  tokenUri: string;
  name: string;
  description: string;
  imageUri: string;
  attributes: NftAttribute[];
  metadataError?: string;
};

/** Cards rendered per "page" so large bags don't explode the DOM or page height. */
const PAGE_SIZE = 12;
const META_BATCH = 6;

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function errorMessage(error: unknown) {
  if (typeof error !== "object" || error === null) return "Something went wrong.";
  const value = error as {
    code?: number | string;
    shortMessage?: string;
    reason?: string;
    message?: string;
  };
  if (value.code === 4001 || value.code === "ACTION_REJECTED") {
    return "Connection cancelled.";
  }
  return (
    value.shortMessage ||
    value.reason ||
    value.message ||
    "Something went wrong."
  );
}

function normalizeAddressInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !isAddress(trimmed)) return null;
  try {
    return getAddress(trimmed);
  } catch {
    return null;
  }
}

function nftFromCache(tokenId: number): OwnedNft | null {
  const rec = getCachedToken(tokenId);
  if (!rec?.tokenUri && !rec?.metaAt) return null;
  if (!rec.imageUri && !rec.metaAt) return null;
  return {
    tokenId,
    tokenUri: rec.tokenUri,
    name: rec.name || `RobinWood Plank #${tokenId}`,
    description: rec.description || "",
    imageUri: rec.imageUri || "",
    attributes: rec.attributes || [],
    metadataError: rec.error,
  };
}

/**
 * Collection-wide rarity: merge full cache sample + currently loaded wallet NFTs
 * so ranks match Gallery (not bag-relative ranks).
 */
function buildCollectionRaritySample(owned: OwnedNft[]) {
  ensureNftCacheHydrated();
  const byId = new Map<number, { tokenId: number; attributes: NftAttribute[]; loaded: boolean }>();
  for (const item of listCachedScoredTokens()) {
    byId.set(item.tokenId, item);
  }
  for (const nft of owned) {
    if (Array.isArray(nft.attributes) && nft.attributes.length > 0) {
      byId.set(nft.tokenId, {
        tokenId: nft.tokenId,
        attributes: nft.attributes,
        loaded: true,
      });
    }
  }
  return Array.from(byId.values());
}

function NftImage({
  imageUri,
  alt,
  className,
  priority = false,
}: {
  imageUri: string;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
  const candidates = useMemo(
    () =>
      ipfsGatewayCandidates(imageUri).map(
        (url) =>
          // Proxy every candidate same-origin — a raw external gateway URL in
          // <img src> can fail with ERR_BLOCKED_BY_ORB, same issue fixed for
          // resolveIpfsUrl callers, just via the direct-cascade path here.
          url.startsWith("data:")
            ? url
            : `/api/ipfs/image?uri=${encodeURIComponent(url)}`,
      ),
    [imageUri],
  );
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setIndex(0);
    setFailed(false);
  }, [imageUri]);

  if (!imageUri || failed || candidates.length === 0) {
    return (
      <div
        className={`flex items-center justify-center bg-wood-950/80 text-4xl ${className ?? ""}`}
        aria-hidden="true"
      >
        🪵
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- IPFS multi-gateway fallback needs native onError
    <img
      src={candidates[Math.min(index, candidates.length - 1)]}
      alt={alt}
      className={className}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      onError={() => {
        if (index + 1 < candidates.length) {
          setIndex((value) => value + 1);
        } else {
          setFailed(true);
        }
      }}
    />
  );
}

function AttributeList({ attributes }: { attributes: NftAttribute[] }) {
  if (!attributes.length) {
    return (
      <p className="text-sm text-foreground/60">No attributes published for this Plank.</p>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
      {attributes.map((attribute, index) => (
        <li
          key={`${attribute.trait_type ?? "trait"}-${index}`}
          className="min-w-0 rounded-lg border border-gold-500/25 bg-black/30 px-3 py-2.5"
        >
          <p className="nft-modal-trait-label font-extrabold uppercase text-gold-300/85">
            {attribute.trait_type || "Trait"}
          </p>
          <p className="nft-modal-trait-value mt-1 font-black text-foreground">
            {String(attribute.value ?? "—")}
          </p>
        </li>
      ))}
    </ul>
  );
}

function TraitRarityList({ rarity }: { rarity: TokenRarity }) {
  return (
    <ul className="space-y-1.5">
      {rarity.traits.map((row) => (
        <li
          key={`${row.trait}-${row.value}`}
          className="min-w-0 rounded-lg border border-gold-500/20 bg-black/25 px-2.5 py-2"
        >
          <div className="flex items-center justify-between gap-2 text-[0.7rem]">
            <span className="min-w-0 truncate font-bold text-gold-300/90">
              {row.trait}: {row.value}
            </span>
            <span className="shrink-0 font-mono text-foreground/55">
              {row.count} · {row.pct < 1 ? row.pct.toFixed(2) : row.pct.toFixed(1)}%
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/40">
            <div
              className="h-full rounded-full bg-gold-500/80"
              style={{
                width: `${Math.min(100, Math.max(4, 100 - row.pct))}%`,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function NftDetailModal({
  nft,
  owner,
  rarity,
  sampleSize,
  onClose,
}: {
  nft: OwnedNft;
  owner: string;
  rarity?: TokenRarity;
  sampleSize: number;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousPadding = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbar > 0) {
      document.body.style.paddingRight = `${scrollbar}px`;
    }
    closeRef.current?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPadding;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/85 p-0 sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="nft-modal wood-frame relative flex h-[min(92dvh,880px)] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-wood-900 sm:h-auto sm:max-h-[min(90dvh,860px)] sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-gold-500/25 bg-wood-900 px-4 py-3 sm:px-5 sm:py-4">
          <div className="min-w-0 flex-1 pr-1">
            <p className="text-[0.7rem] font-extrabold uppercase tracking-[0.16em] text-gold-300">
              Your Planks
              {rarity && (
                <span className="ml-2" style={{ color: tierColor(rarity.tier) }}>
                  · {rarity.tier} {formatRank(rarity.rank)}
                </span>
              )}
            </p>
            <h3
              id={titleId}
              className="nft-modal-title mt-1 font-display font-normal text-foreground"
            >
              {nft.name}
            </h3>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-gold-500/40 text-2xl leading-none text-gold-300"
            aria-label="Close NFT details"
          >
            ×
          </button>
        </div>

        <div className="nft-modal-body min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="grid sm:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <div className="relative mx-auto flex w-full max-h-[min(42dvh,320px)] items-center justify-center bg-wood-950 sm:max-h-none sm:min-h-[280px] sm:self-stretch">
              <div className="relative aspect-square w-full max-w-[320px] sm:max-w-none sm:h-full sm:max-h-[420px]">
                <NftImage
                  imageUri={nft.imageUri}
                  alt={nft.name}
                  priority
                  className="absolute inset-0 h-full w-full object-contain p-3 sm:p-4"
                />
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-4 p-4 pb-5 sm:p-5">
              <dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
                <div className="min-w-0 rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2.5">
                  <dt className="uppercase tracking-wide text-foreground/55">Token ID</dt>
                  <dd className="mt-1 font-mono">#{nft.tokenId}</dd>
                </div>
                <div className="min-w-0 rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2.5">
                  <dt className="uppercase tracking-wide text-foreground/55">Owner</dt>
                  <dd className="mt-1 font-mono" title={owner}>
                    {shortAddress(owner)}
                  </dd>
                </div>
                {rarity && (
                  <>
                    <div className="min-w-0 rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2.5">
                      <dt className="uppercase tracking-wide text-foreground/55">
                        Collection rank
                      </dt>
                      <dd
                        className="mt-1 font-mono"
                        style={{ color: tierColor(rarity.tier) }}
                      >
                        {formatRank(rarity.rank)}
                        <span className="text-foreground/45">
                          {" "}
                          / {sampleSize.toLocaleString()}
                        </span>
                      </dd>
                    </div>
                    <div className="min-w-0 rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2.5">
                      <dt className="uppercase tracking-wide text-foreground/55">
                        Tier · exclusivity
                      </dt>
                      <dd className="mt-1 font-mono">
                        <span style={{ color: tierColor(rarity.tier) }}>{rarity.tier}</span>
                        <span className="text-foreground/70">
                          {" "}
                          · {rarity.normalizedScore.toFixed(1)}
                        </span>
                        <span className="text-foreground/45"> outranks %</span>
                      </dd>
                    </div>
                    <div className="min-w-0 rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2.5 min-[420px]:col-span-2">
                      <dt className="uppercase tracking-wide text-foreground/55">
                        Percentile
                      </dt>
                      <dd className="mt-1 font-mono text-foreground">
                        {rarity.percentile.toFixed(1)}th · rarer than{" "}
                        {Math.max(0, rarity.percentile - 100 / Math.max(1, sampleSize)).toFixed(1)}
                        % of scored Planks
                      </dd>
                    </div>
                  </>
                )}
              </dl>

              {nft.description && (
                <p className="text-sm leading-relaxed text-foreground/80">
                  {nft.description}
                </p>
              )}

              {nft.metadataError && (
                <p className="rounded-lg border border-red-400/30 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                  Metadata partially failed to load: {nft.metadataError}
                </p>
              )}

              <div className="min-w-0">
                {rarity && rarity.traits.length > 0 ? (
                  <>
                    <h4 className="mb-2 text-xs font-extrabold uppercase tracking-[0.14em] text-gold-300">
                      Trait rarity
                      <span className="ml-2 font-bold normal-case tracking-normal text-foreground/45">
                        vs collection sample
                      </span>
                    </h4>
                    <TraitRarityList rarity={rarity} />
                  </>
                ) : (
                  <>
                    <h4 className="mb-2 text-xs font-extrabold uppercase tracking-[0.14em] text-gold-300">
                      Traits
                    </h4>
                    <AttributeList attributes={nft.attributes} />
                    {nft.attributes.length > 0 && !rarity && (
                      <p className="mt-2 text-xs text-foreground/50">
                        Open Gallery for live ranks.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-gold-500/25 bg-wood-900 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:px-5">
          <a
            href={`${ROBINHOOD_EXPLORER_URL}/token/${NFT_CONTRACT_ADDRESS}/instance/${nft.tokenId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg bg-gold-500 px-4 py-3 text-center font-extrabold text-wood-950"
          >
            View on explorer ↗
          </a>
          <a
            href={`/gallery`}
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg border border-gold-500/40 px-4 py-3 text-center font-extrabold text-gold-300"
          >
            Open gallery
          </a>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg border border-gold-500/40 px-4 py-3 font-extrabold text-gold-300"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function BagRaritySummary({
  nfts,
  rarityById,
  sampleSize,
  tierCounts,
}: {
  nfts: OwnedNft[];
  rarityById: Map<number, TokenRarity>;
  sampleSize: number;
  tierCounts: Record<RarityTier, number>;
}) {
  const scored = nfts.filter((n) => rarityById.has(n.tokenId));
  if (!scored.length) return null;

  const rarest = [...scored]
    .map((n) => rarityById.get(n.tokenId)!)
    .sort((a, b) => a.rank - b.rank || b.normalizedScore - a.normalizedScore)[0];

  const avgScore =
    scored.reduce((sum, n) => sum + (rarityById.get(n.tokenId)?.normalizedScore || 0), 0) /
    scored.length;

  const bagTiers = TIER_ORDER.filter((tier) => tierCounts[tier] > 0);

  return (
    <div className="border-b border-gold-500/15 bg-black/15 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-gold-300/85">
          Bag rarity · collection ranks
        </p>
        <p className="text-xs text-foreground/50">
          Sample {sampleSize.toLocaleString()} revealed
        </p>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border border-gold-500/20 bg-black/25 px-2.5 py-2">
          <p className="text-[0.6rem] font-bold uppercase tracking-wide text-foreground/50">
            Scored
          </p>
          <p className="font-mono text-sm font-black text-foreground">
            {scored.length}
            <span className="text-foreground/45"> / {nfts.length}</span>
          </p>
        </div>
        <div className="rounded-lg border border-gold-500/20 bg-black/25 px-2.5 py-2">
          <p className="text-[0.6rem] font-bold uppercase tracking-wide text-foreground/50">
            Rarest held
          </p>
          <p
            className="truncate font-mono text-sm font-black"
            style={{ color: tierColor(rarest.tier) }}
            title={`#${rarest.tokenId}`}
          >
            {formatRank(rarest.rank)} · {rarest.tier}
          </p>
        </div>
        <div className="rounded-lg border border-gold-500/20 bg-black/25 px-2.5 py-2">
          <p className="text-[0.6rem] font-bold uppercase tracking-wide text-foreground/50">
            Avg score
          </p>
          <p className="font-mono text-sm font-black text-foreground">
            {avgScore.toFixed(1)}
            <span className="text-foreground/45"> / 100</span>
          </p>
        </div>
        <div className="rounded-lg border border-gold-500/20 bg-black/25 px-2.5 py-2">
          <p className="text-[0.6rem] font-bold uppercase tracking-wide text-foreground/50">
            Tiers in bag
          </p>
          <p className="truncate text-sm font-black text-foreground">
            {bagTiers.length
              ? bagTiers
                  .map((t) => `${t.slice(0, 1)}${tierCounts[t]}`)
                  .join(" · ")
              : "—"}
          </p>
        </div>
      </div>
      {bagTiers.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {TIER_ORDER.map((tier) => {
            const count = tierCounts[tier];
            if (!count) return null;
            return (
              <span
                key={tier}
                className="rounded-full px-2 py-0.5 text-[0.65rem] font-extrabold"
                style={{
                  color: tierColor(tier),
                  border: `1px solid ${tierColor(tier)}55`,
                  background: `${tierColor(tier)}18`,
                }}
              >
                {tier} {count}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function NftViewer() {
  const [inputAddress, setInputAddress] = useState("");
  const [viewedAddress, setViewedAddress] = useState("");
  const [connectedAddress, setConnectedAddress] = useState("");
  const [nfts, setNfts] = useState<OwnedNft[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<OwnedNft | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [sortMode, setSortMode] = useState<"id" | "rarest" | "score">("id");
  const requestIdRef = useRef(0);
  const gridScrollRef = useRef<HTMLDivElement>(null);

  const collectionRarity = useMemo(() => {
    const sample = buildCollectionRaritySample(nfts);
    return computeRaritySnapshot(sample);
  }, [nfts]);

  const bagTierCounts = useMemo(() => {
    const counts: Record<RarityTier, number> = {
      Mythic: 0,
      Legendary: 0,
      Epic: 0,
      Rare: 0,
      Uncommon: 0,
      Common: 0,
    };
    for (const nft of nfts) {
      const r = collectionRarity.byTokenId.get(nft.tokenId);
      if (r) counts[r.tier] += 1;
    }
    return counts;
  }, [nfts, collectionRarity]);

  const sortedNfts = useMemo(() => {
    if (sortMode === "id") {
      return [...nfts].sort((a, b) => a.tokenId - b.tokenId);
    }
    return [...nfts].sort((a, b) => {
      const ra = collectionRarity.byTokenId.get(a.tokenId);
      const rb = collectionRarity.byTokenId.get(b.tokenId);
      if (sortMode === "rarest") {
        if (ra && rb) return ra.rank - rb.rank || a.tokenId - b.tokenId;
        if (ra) return -1;
        if (rb) return 1;
        return a.tokenId - b.tokenId;
      }
      // score
      if (ra && rb) {
        return rb.normalizedScore - ra.normalizedScore || a.tokenId - b.tokenId;
      }
      if (ra) return -1;
      if (rb) return 1;
      return a.tokenId - b.tokenId;
    });
  }, [nfts, sortMode, collectionRarity]);

  const visibleNfts = useMemo(
    () => sortedNfts.slice(0, visibleCount),
    [sortedNfts, visibleCount],
  );

  const selectedRarity = selected
    ? collectionRarity.byTokenId.get(selected.tokenId)
    : undefined;

  // Keep modal in sync as metadata/rarity loads
  useEffect(() => {
    if (!selected) return;
    const next = nfts.find((n) => n.tokenId === selected.tokenId);
    if (
      next &&
      (next.imageUri !== selected.imageUri ||
        next.attributes !== selected.attributes ||
        next.name !== selected.name)
    ) {
      setSelected(next);
    }
  }, [nfts, selected]);

  const paintFromInventoryCache = useCallback((wallet: string) => {
    ensureNftCacheHydrated();
    const inv = getCachedInventory(wallet);
    if (!inv?.ids.length) return false;
    const cachedNfts = inv.ids
      .map((id) => nftFromCache(id))
      .filter((n): n is OwnedNft => Boolean(n))
      .sort((a, b) => a.tokenId - b.tokenId);
    if (!cachedNfts.length) return false;
    setNfts(cachedNfts);
    setMessage(
      inv.fresh
        ? `Showing ${cachedNfts.length} cached Plank${cachedNfts.length === 1 ? "" : "s"}…`
        : `Showing ${cachedNfts.length} cached Plank${cachedNfts.length === 1 ? "" : "s"} · refreshing…`,
    );
    return true;
  }, []);

  const loadCollection = useCallback(async (wallet: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setSelected(null);
    setVisibleCount(PAGE_SIZE);
    setViewedAddress(wallet);
    if (gridScrollRef.current) gridScrollRef.current.scrollTop = 0;

    const hadCache = paintFromInventoryCache(wallet);
    if (!hadCache) {
      setNfts([]);
      setMessage("Fetching wallet collection…");
    }

    try {
      const { contract } = await getMintReadClient();
      if (requestId !== requestIdRef.current) return;

      const inv = getCachedInventory(wallet);
      let sortedIds: number[];

      if (inv?.fresh && inv.ids.length >= 0) {
        const balance = Number(await contract.balanceOf(wallet));
        touchMintReadClient();
        if (requestId !== requestIdRef.current) return;

        if (balance === inv.ids.length) {
          sortedIds = [...inv.ids].sort((a, b) => a - b);
        } else {
          const tokenIds = await Promise.all(
            Array.from({ length: balance }, (_, index) =>
              contract
                .tokenOfOwnerByIndex(wallet, index)
                .then((id: bigint) => Number(id)),
            ),
          );
          touchMintReadClient();
          sortedIds = [...tokenIds].sort((a, b) => a - b);
          setCachedInventory(wallet, sortedIds);
        }
      } else {
        const balance = Number(await contract.balanceOf(wallet));
        touchMintReadClient();
        if (requestId !== requestIdRef.current) return;

        if (balance === 0) {
          setCachedInventory(wallet, []);
          setNfts([]);
          setMessage("No RobinWood Planks found for this wallet.");
          setLoading(false);
          return;
        }

        const tokenIds = await Promise.all(
          Array.from({ length: balance }, (_, index) =>
            contract
              .tokenOfOwnerByIndex(wallet, index)
              .then((id: bigint) => Number(id)),
          ),
        );
        touchMintReadClient();
        sortedIds = [...tokenIds].sort((a, b) => a - b);
        setCachedInventory(wallet, sortedIds);
      }

      if (requestId !== requestIdRef.current) return;

      if (sortedIds.length === 0) {
        setNfts([]);
        setMessage("No RobinWood Planks found for this wallet.");
        setLoading(false);
        return;
      }

      const owned: OwnedNft[] = sortedIds.map((tokenId) => {
        const hit = nftFromCache(tokenId);
        if (hit) return hit;
        return {
          tokenId,
          tokenUri: "",
          name: `RobinWood Plank #${tokenId}`,
          description: "",
          imageUri: "",
          attributes: [],
        };
      });
      setNfts([...owned]);
      setMessage(
        `Loading ${sortedIds.length} Plank${sortedIds.length === 1 ? "" : "s"}…`,
      );

      for (let offset = 0; offset < sortedIds.length; offset += META_BATCH) {
        if (requestId !== requestIdRef.current) return;
        const slice = sortedIds.slice(offset, offset + META_BATCH);

        const batch = await Promise.all(
          slice.map(async (tokenId) => {
            const existing = nftFromCache(tokenId);
            // Need image + attributes — re-fetch if art missing (live mints)
            if (existing?.imageUri && existing.attributes.length > 0) return existing;

            const fallbackName = `RobinWood Plank #${tokenId}`;
            try {
              let tokenUri = getCachedToken(tokenId)?.tokenUri || existing?.tokenUri || "";
              // Always re-read URI when art missing — reveal can update URI
              if (!tokenUri || !existing?.imageUri) {
                tokenUri = (await contract.tokenURI(tokenId)) as string;
                if (tokenUri) putTokenUri(tokenId, tokenUri);
                touchMintReadClient();
              }
              if (!tokenUri) {
                return {
                  tokenId,
                  tokenUri: "",
                  name: fallbackName,
                  description: "",
                  imageUri: "",
                  attributes: [],
                  metadataError: "tokenURI unavailable",
                } satisfies OwnedNft;
              }

              const metadata: NftMetadata = await fetchNftMetadata(tokenUri, {
                force: !existing?.imageUri,
              });
              const name = metadata.name?.trim() || fallbackName;
              const description = metadata.description?.trim() || "";
              const attributes = Array.isArray(metadata.attributes)
                ? metadata.attributes
                : [];
              putTokenMetadata(tokenId, {
                tokenUri,
                name,
                description,
                imageUri: metadata.image || "",
                attributes,
                owner: wallet,
              });
              return {
                tokenId,
                tokenUri,
                name,
                description,
                imageUri: metadata.image || "",
                attributes,
              } satisfies OwnedNft;
            } catch (error) {
              return {
                tokenId,
                tokenUri: getCachedToken(tokenId)?.tokenUri || "",
                name: fallbackName,
                description: "",
                imageUri: existing?.imageUri || "",
                attributes: existing?.attributes || [],
                metadataError: errorMessage(error),
              } satisfies OwnedNft;
            }
          }),
        );

        const byId = new Map(batch.map((n) => [n.tokenId, n]));
        for (let i = 0; i < owned.length; i += 1) {
          const updated = byId.get(owned[i].tokenId);
          if (updated) owned[i] = updated;
        }
        if (requestId === requestIdRef.current) {
          setNfts([...owned]);
        }
      }

      if (requestId === requestIdRef.current) {
        const scored = owned.filter((n) => n.attributes.length > 0).length;
        setMessage(
          owned.length === 1
            ? `1 RobinWood Plank · ${scored ? "rarity live" : "awaiting traits"}`
            : `${owned.length} RobinWood Planks · ${scored} scored`,
        );
      }
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setMessage(
          hadCache
            ? `Refresh failed — showing cache. ${errorMessage(error)}`
            : `Unable to load collection. ${errorMessage(error)}`,
        );
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [paintFromInventoryCache]);

  useEffect(() => {
    ensureNftCacheHydrated();
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("address") || params.get("wallet");
    if (fromQuery && isAddress(fromQuery)) {
      const checksummed = getAddress(fromQuery);
      setInputAddress(checksummed);
      void loadCollection(checksummed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!window.ethereum) return;
    const handleAccounts = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      const next = accounts[0] ? getAddress(accounts[0]) : "";
      setConnectedAddress(next);
    };
    window.ethereum.on?.("accountsChanged", handleAccounts);
    return () => window.ethereum?.removeListener?.("accountsChanged", handleAccounts);
  }, []);

  async function connectWallet() {
    setMessage("");
    if (!window.ethereum) {
      setMessage("No wallet found — open in Robinhood Wallet or an EVM browser wallet.");
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (!accounts[0]) {
        setMessage("No wallet account returned.");
        return;
      }
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const next = getAddress(await signer.getAddress());
      setConnectedAddress(next);
      setInputAddress(next);
      await loadCollection(next);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const wallet = normalizeAddressInput(inputAddress);
    if (!wallet) {
      setMessage("Enter a valid EVM wallet address.");
      setNfts([]);
      setViewedAddress("");
      return;
    }
    setInputAddress(wallet);
    void loadCollection(wallet);
  }

  function onCardKeyDown(event: KeyboardEvent<HTMLButtonElement>, nft: OwnedNft) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelected(nft);
    }
  }

  const heading = viewedAddress
    ? `Collection · ${shortAddress(viewedAddress)}`
    : "Collection Viewer";

  const hasMore = visibleCount < sortedNfts.length;
  const remaining = Math.max(0, sortedNfts.length - visibleCount);
  const scoredInBag = nfts.filter((n) =>
    collectionRarity.byTokenId.has(n.tokenId),
  ).length;

  function showMore() {
    setVisibleCount((count) => Math.min(sortedNfts.length, count + PAGE_SIZE));
  }

  function showAll() {
    setVisibleCount(sortedNfts.length);
  }

  return (
    <section id="collection" className="scroll-mt-20 section-tight px-3 sm:px-5">
      <div className="mx-auto max-w-[1400px]">
        <Reveal>
          <h2 className="section-title text-center text-4xl text-gold-300 sm:text-5xl">
            Your Planks
          </h2>
          <p className="lede mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Connect a wallet or paste an address to view its Planks.
          </p>
        </Reveal>

        <Reveal delayMs={120}>
          <div className="wood-frame mx-auto mt-10 flex max-w-[1400px] flex-col overflow-hidden rounded-2xl bg-wood-900/95">
            <div className="border-b border-gold-500/20 p-4 sm:p-5">
              <form
                onSubmit={onSubmit}
                className="flex flex-col gap-3 sm:flex-row sm:items-stretch"
              >
                <label htmlFor="nft-viewer-address" className="sr-only">
                  Wallet address
                </label>
                <input
                  id="nft-viewer-address"
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={inputAddress}
                  onChange={(event) => setInputAddress(event.target.value)}
                  placeholder="0x… wallet address"
                  className="min-h-12 min-w-0 flex-1 rounded-lg border-2 border-gold-500/50 bg-wood-950 px-4 py-3 font-mono text-base font-bold text-foreground outline-none placeholder:text-foreground/40 focus:border-gold-300"
                />
                <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
                  <button
                    type="submit"
                    disabled={loading}
                    className="min-h-12 rounded-lg bg-gold-500 px-5 py-3 text-base font-extrabold text-wood-950 disabled:cursor-wait disabled:opacity-60"
                  >
                    {loading ? "Loading…" : "View NFTs"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void connectWallet()}
                    disabled={loading}
                    className="min-h-12 rounded-lg border border-gold-500/40 px-5 py-3 text-base font-extrabold text-gold-300 disabled:opacity-60"
                  >
                    {connectedAddress ? "My Wallet" : "Connect"}
                  </button>
                </div>
              </form>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-foreground/65">
                <p role="status" aria-live="polite">
                  {message || "Robinhood Chain · ERC-721 RobinWood collection"}
                </p>
                <a
                  href={`${ROBINHOOD_EXPLORER_URL}/token/${NFT_CONTRACT_ADDRESS}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold text-gold-300 hover:text-gold-400"
                >
                  Contract ↗
                </a>
              </div>
            </div>

            {/* Sort + rarity chrome */}
            <div className="flex flex-col gap-2 border-b border-gold-500/15 bg-black/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <h3 className="min-w-0 truncate font-display text-lg text-gold-300 sm:text-xl">
                {heading}
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                {loading && (
                  <span className="text-xs font-bold uppercase tracking-wide text-foreground/55">
                    Fetching…
                  </span>
                )}
                {nfts.length > 0 && (
                  <>
                    <span className="rounded-full border border-gold-500/30 px-2.5 py-1 text-xs font-bold text-gold-300">
                      {Math.min(visibleCount, sortedNfts.length)} / {sortedNfts.length}
                    </span>
                    <span className="rounded-full border border-gold-500/30 px-2.5 py-1 text-xs font-bold text-gold-300">
                      {scoredInBag} scored
                    </span>
                    <span className="rounded-full border border-gold-500/20 px-2.5 py-1 text-xs font-bold text-foreground/55">
                      sample {collectionRarity.scoredCount.toLocaleString()}
                    </span>
                  </>
                )}
              </div>
            </div>

            {nfts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-b border-gold-500/10 px-4 py-2.5 sm:px-5">
                {(
                  [
                    ["id", "Token #"],
                    ["rarest", "Rarest"],
                    ["score", "Score"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setSortMode(id);
                      setVisibleCount(PAGE_SIZE);
                      gridScrollRef.current?.scrollTo({ top: 0 });
                    }}
                    className={`min-h-9 rounded-lg px-3 py-1.5 text-xs font-extrabold sm:text-sm ${
                      sortMode === id
                        ? "bg-gold-500 text-wood-950"
                        : "border border-gold-500/40 text-gold-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <a
                  href="/gallery"
                  className="ml-auto inline-flex min-h-9 items-center rounded-lg border border-gold-500/30 px-3 py-1.5 text-xs font-extrabold text-gold-300/90 sm:text-sm"
                >
                  Full gallery rarity ↗
                </a>
              </div>
            )}

            {nfts.length > 0 && (
              <BagRaritySummary
                nfts={nfts}
                rarityById={collectionRarity.byTokenId}
                sampleSize={collectionRarity.scoredCount}
                tierCounts={bagTierCounts}
              />
            )}

            <div
              ref={gridScrollRef}
              className="max-h-[min(62dvh,560px)] overflow-y-auto overscroll-contain sm:max-h-[min(64dvh,640px)]"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              {loading && nfts.length === 0 && (
                <div
                  className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-3 sm:gap-4 sm:p-4"
                  aria-hidden="true"
                >
                  {Array.from({ length: 8 }).map((_, index) => (
                    <div
                      key={index}
                      className="animate-pulse overflow-hidden rounded-xl border border-gold-500/20 bg-wood-950/60"
                    >
                      <div className="aspect-square bg-wood-950/70" />
                      <div className="space-y-2 p-3">
                        <div className="h-4 w-3/4 rounded bg-gold-500/15" />
                        <div className="h-3 w-1/3 rounded bg-gold-500/10" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!loading && nfts.length === 0 && viewedAddress && (
                <div className="px-5 py-12 text-center">
                  <div className="text-4xl" aria-hidden="true">
                    🪵
                  </div>
                  <p className="mt-3 text-lg font-black text-foreground">Empty woodpile</p>
                  <p className="mt-2 text-foreground/65">No Planks in this wallet.</p>
                  <a
                    href="#mint"
                    className="mt-5 inline-flex min-h-12 items-center justify-center rounded-lg bg-gold-500 px-6 py-3 font-extrabold text-wood-950"
                  >
                    Mint RobinWood
                  </a>
                </div>
              )}

              {!viewedAddress && !loading && nfts.length === 0 && (
                <p className="px-5 py-10 text-center text-sm text-foreground/55">
                  Works with any public address.
                </p>
              )}

              {visibleNfts.length > 0 && (
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-3 sm:gap-4 sm:p-4">
                  {visibleNfts.map((nft) => {
                    const tokenRarity = collectionRarity.byTokenId.get(nft.tokenId);
                    return (
                      <li
                        key={nft.tokenId}
                        className="[content-visibility:auto] [contain-intrinsic-size:auto_240px]"
                      >
                        <button
                          type="button"
                          onClick={() => setSelected(nft)}
                          onKeyDown={(event) => onCardKeyDown(event, nft)}
                          className="group flex h-full w-full flex-col overflow-hidden rounded-xl border border-gold-500/30 bg-wood-950/70 text-left transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
                          aria-label={
                            tokenRarity
                              ? `Open ${nft.name}, ${tokenRarity.tier} rank ${tokenRarity.rank}`
                              : `Open details for ${nft.name}`
                          }
                        >
                          <div
                            className={`relative aspect-square w-full overflow-hidden bg-wood-950 ${
                              tokenRarity ? `${tierAnimationClass(tokenRarity.tier)} holo-card` : ""
                            }`}
                            style={
                              tokenRarity
                                ? { boxShadow: tierGlow(tokenRarity.tier), ...tierCardStyle(tokenRarity.tier) }
                                : undefined
                            }
                            {...(tokenRarity ? holoHandlers : {})}
                          >
                            <NftImage
                              imageUri={nft.imageUri}
                              alt=""
                              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                            />
                            <span className="absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[0.65rem] font-bold text-gold-300">
                              #{nft.tokenId}
                            </span>
                            {tokenRarity && (
                              <span
                                className="absolute bottom-1.5 right-1.5 rounded px-1.5 py-0.5 text-[0.6rem] font-black"
                                style={{
                                  color: tierColor(tokenRarity.tier),
                                  background: "rgba(0,0,0,0.75)",
                                  border: `1px solid ${tierColor(tokenRarity.tier)}55`,
                                }}
                              >
                                {formatRank(tokenRarity.rank)}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-1 flex-col gap-1 p-2.5 sm:p-3">
                            <p className="line-clamp-2 text-sm font-black leading-snug text-foreground sm:text-base">
                              {nft.name}
                            </p>
                            <div className="flex items-center justify-between gap-1">
                              {tokenRarity ? (
                                <span
                                  className="truncate text-[0.7rem] font-bold sm:text-xs"
                                  style={{ color: tierColor(tokenRarity.tier) }}
                                >
                                  {tokenRarity.tier}
                                </span>
                              ) : (
                                <span className="text-[0.7rem] text-foreground/40">
                                  {nft.attributes.length ? "…" : "unrevealed"}
                                </span>
                              )}
                              {tokenRarity && (
                                <span className="font-mono text-[0.7rem] text-foreground/55 sm:text-xs">
                                  {tokenRarity.normalizedScore.toFixed(0)}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {sortedNfts.length > PAGE_SIZE && (
              <div className="flex flex-col gap-2 border-t border-gold-500/20 bg-black/25 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <p className="text-sm text-foreground/65">
                  Showing {Math.min(visibleCount, sortedNfts.length)} of {sortedNfts.length}{" "}
                  Planks
                </p>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  {hasMore ? (
                    <>
                      <button
                        type="button"
                        onClick={showMore}
                        className="min-h-11 rounded-lg bg-gold-500 px-4 py-2 text-sm font-extrabold text-wood-950"
                      >
                        Show {Math.min(PAGE_SIZE, remaining)} more
                      </button>
                      <button
                        type="button"
                        onClick={showAll}
                        className="min-h-11 rounded-lg border border-gold-500/40 px-4 py-2 text-sm font-extrabold text-gold-300"
                      >
                        Show all
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setVisibleCount(PAGE_SIZE);
                        gridScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                      className="min-h-11 rounded-lg border border-gold-500/40 px-4 py-2 text-sm font-extrabold text-gold-300 sm:col-span-2"
                    >
                      Collapse to first {PAGE_SIZE}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </Reveal>
      </div>

      {selected && viewedAddress && (
        <NftDetailModal
          nft={selected}
          owner={viewedAddress}
          rarity={selectedRarity}
          sampleSize={collectionRarity.scoredCount}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
