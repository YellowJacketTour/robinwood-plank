"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Contract } from "ethers";
import Link from "next/link";
import Reveal from "@/components/Reveal";
import NftImage from "@/components/NftImage";
import { getConnectedAccounts } from "@/lib/wallet";
import {
  fetchNftMetadata,
  type NftAttribute,
  type NftMetadata,
} from "@/lib/ipfs";
import {
  buildGallerySearchIndex,
  matchesGalleryQuery,
} from "@/lib/gallery-search";
import {
  NFT_CONTRACT_ADDRESS,
  ROBINHOOD_EXPLORER_URL,
} from "@/lib/mint-contract";
import {
  getMintReadClient,
  touchMintReadClient,
} from "@/lib/robinhood-provider";
import {
  computeRaritySnapshot,
  formatRank,
  tierColor,
  TIER_ORDER,
  type RarityTier,
  type TokenRarity,
} from "@/lib/rarity";
import {
  Search,
  X,
  LayoutGrid,
  BarChart3,
  ExternalLink,
  Wallet,
  SlidersHorizontal,
} from "lucide-react";
import type { GalleryNft } from "@/lib/gallery-types";
import {
  GALLERY_TABS,
  DEFAULT_GALLERY_PANEL,
  parseGalleryTab,
  toNumericTokenIds,
  type GalleryPanel,
} from "@/lib/gallery-tabs";
import { useWallet } from "@/lib/wallet-context";
import { getOwnedTokenIds } from "@/lib/market/inventory";
import { startVisibleInterval } from "@/lib/useVisibleInterval";
import RarityInsights from "@/components/RarityInsights";
import { SkeletonCardGrid } from "@/components/Skeleton";
import {
  ensureNftCacheHydrated,
  getCachedSupply,
  getCachedToken,
  hasFreshMetadata,
  hasFreshOwner,
  invalidateIncompleteToken,
  needsMetadataRetry,
  putTokenMetadata,
  putTokenOwner,
  putTokenUri,
  setCachedSupply,
  type CachedTokenRecord,
} from "@/lib/nft-cache";

export type { GalleryNft };

// Supply is fixed (RobinWood is fully minted) and owner TTL is 10 minutes
// (TTL_OWNER_MS in nft-cache.ts) — no need to re-check totalSupply() every
// 25s anymore now that metadata comes from the one-shot collection dataset.
const POLL_MS = 90_000;
const META_CONCURRENCY = 6;
const PAGE_SIZE = 24;
/** builtAt of the collection dataset this browser last applied. Lets a server
 *  rebuild override the 7-day per-token metadata cache — see
 *  primeFromCollectionIndex. */
const INDEX_STAMP_KEY = "plank.love:collection-index-builtAt";
/** First paint: stage this many cards immediately (newest first). */
const INITIAL_STAGE = 48;

type TokenHistoryEntry = {
  kind: string;
  priceEth: string | null;
  txHash: string;
  timestamp: string | null;
  from: string;
  to: string;
};

/** Same compact relative-time format as the market's Activity feed. */
function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Compact 0xABCD…WXYZ — unobtrusive on cards; full address via title. */
function shortOwner(owner: string) {
  const raw = (owner || "").trim();
  if (!raw) return "";
  if (raw.length < 10) return raw;
  // 0x + 4 hex + … + last 4
  return `0x${raw.slice(2, 6)}…${raw.slice(-4)}`;
}

/**
 * Deployer put real plank names on the Base trait; metadata `name` is just
 * "RobinWood Plank #N". Prefer Base for display — token id is already on the card.
 */
function displayName(nft: {
  name: string;
  tokenId: number;
  attributes?: NftAttribute[];
}): string {
  const base = nft.attributes?.find(
    (a) => String(a.trait_type ?? "").trim().toLowerCase() === "base",
  );
  const baseName = base != null ? String(base.value ?? "").trim() : "";
  if (baseName) return baseName;
  const stripped = nft.name.replace(/^RobinWood Plank\s*/i, "").trim();
  // Skip pure #id / numeric names — id is already top-left
  if (stripped && !/^#?\d+$/.test(stripped)) return stripped;
  return nft.name?.trim() || `Plank #${nft.tokenId}`;
}

function indexNft(fields: {
  tokenId: number;
  name: string;
  description?: string;
  attributes?: NftAttribute[];
  owner?: string;
}) {
  return buildGallerySearchIndex({
    tokenId: fields.tokenId,
    name: fields.name,
    description: fields.description ?? "",
    attributes: fields.attributes ?? [],
    owner: fields.owner ?? "",
  });
}

function sortNewestFirst(a: GalleryNft, b: GalleryNft) {
  return b.tokenId - a.tokenId;
}

function recordToGalleryNft(rec: CachedTokenRecord, loaded: boolean): GalleryNft {
  const idx = indexNft({
    tokenId: rec.tokenId,
    name: rec.name,
    description: rec.description,
    attributes: rec.attributes,
    owner: rec.owner,
  });
  return {
    tokenId: rec.tokenId,
    tokenUri: rec.tokenUri,
    name: rec.name,
    description: rec.description,
    imageUri: rec.imageUri,
    attributes: rec.attributes,
    owner: rec.owner,
    searchText: idx.searchText,
    searchWords: idx.words,
    loaded,
    error: rec.error,
  };
}

function GalleryDetailModal({
  nft,
  rarity,
  onClose,
}: {
  nft: GalleryNft;
  rarity?: TokenRarity;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [history, setHistory] = useState<TokenHistoryEntry[] | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // One-shot read at modal open — enough to decide "owner" vs. "browsing"
  // actions without building wallet state machinery into the gallery.
  useEffect(() => {
    let alive = true;
    void getConnectedAccounts().then((accounts) => {
      if (alive && accounts[0]) setAccount(accounts[0]);
    });
    return () => {
      alive = false;
    };
  }, []);

  const isOwner = Boolean(
    account && nft.owner && account.toLowerCase() === nft.owner.toLowerCase(),
  );

  // Same endpoint + history=1 param ItemDetail uses — the gallery never
  // recomputes history itself, only reads the shared token detail route.
  // Mounted per token via the `key` at the call site, so there is no stale
  // state to clear here when the selected token changes (same pattern as
  // ItemDetail).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/market/token?tokenId=${encodeURIComponent(nft.tokenId)}&history=1`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { history?: TokenHistoryEntry[] }) => {
        if (!cancelled) setHistory(Array.isArray(d.history) ? d.history : []);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [nft.tokenId]);

  return (
    <div
      data-market-shell
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/85 p-0 sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[min(92dvh,880px)] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-panel-strong shadow-panel sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <p className="text-[0.6rem] font-black uppercase tracking-[0.14em] text-gold-300">
              Gallery · Minted
              {rarity && (
                <span className="ml-2" style={{ color: tierColor(rarity.tier) }}>
                  · {rarity.tier} {formatRank(rarity.rank)}
                </span>
              )}
            </p>
            <h3 id={titleId} className="mt-1 font-display text-lg text-cream sm:text-xl">
              {displayName(nft)}
            </h3>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line text-gold-300 transition hover:border-line-strong"
            aria-label="Close"
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="grid sm:grid-cols-2">
            <div className="relative mx-auto aspect-square w-full max-w-[360px] bg-wood-950 sm:max-w-none">
              <NftImage
                imageUri={nft.imageUri}
                alt={displayName(nft)}
                priority
                className="h-full w-full object-contain p-3"
              />
            </div>
            <div className="min-w-0 space-y-4 p-4 sm:p-5">
              <dl className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
                  <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Token</dt>
                  <dd className="mt-1 text-xs font-bold text-foreground">#{nft.tokenId}</dd>
                </div>
                <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
                  <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Owner</dt>
                  <dd className="mt-1 text-xs font-bold text-foreground" title={nft.owner || undefined}>
                    {nft.owner ? shortOwner(nft.owner) : "—"}
                  </dd>
                </div>
                {rarity && (
                  <>
                    <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
                      <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Rank</dt>
                      <dd className="mt-1 text-xs font-bold" style={{ color: tierColor(rarity.tier) }}>
                        {formatRank(rarity.rank)} · {rarity.tier}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
                      <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">
                        Exclusivity
                      </dt>
                      <dd className="mt-1 text-xs font-bold text-foreground">
                        {rarity.normalizedScore.toFixed(1)}
                        <span className="text-foreground/45"> · outranks %</span>
                      </dd>
                    </div>
                  </>
                )}
              </dl>
              {rarity && rarity.traits.length > 0 && (
                <div>
                  <h4 className="mb-1.5 text-[0.7rem] font-black uppercase tracking-[0.1em] text-foreground">
                    Trait rarity
                  </h4>
                  <ul className="space-y-1.5">
                    {rarity.traits.map((row) => (
                      <li
                        key={`${row.trait}-${row.value}`}
                        className="min-w-0 rounded-lg border border-line bg-wood-950 px-2.5 py-2"
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
                </div>
              )}
              <div>
                <h4 className="mb-1.5 text-[0.7rem] font-black uppercase tracking-[0.1em] text-foreground">
                  History
                </h4>
                {!history || history.length === 0 ? (
                  <p className="rounded-lg border border-line bg-wood-950 px-3 py-2.5 text-xs text-cream-muted">
                    {history === null ? "Loading history…" : "No transfers recorded."}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {history.map((h) => (
                      <li
                        key={h.txHash}
                        className="min-w-0 rounded-lg border border-line bg-wood-950 px-2.5 py-2"
                      >
                        <div className="flex items-center justify-between gap-2 text-[0.7rem]">
                          <a
                            href={`${ROBINHOOD_EXPLORER_URL}/tx/${h.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-bold capitalize text-gold-300 hover:underline"
                          >
                            {h.kind}
                          </a>
                          <span className="shrink-0 font-bold text-gold-300">
                            {h.priceEth
                              ? `${Number(h.priceEth).toFixed(4)} Ξ`
                              : h.kind === "sale"
                                ? "Unavailable"
                                : "—"}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-[0.6rem] text-foreground/45">
                          <span className="min-w-0 truncate font-mono">
                            {shortOwner(h.from)} → {shortOwner(h.to)}
                          </span>
                          <span className="shrink-0">{timeAgo(h.timestamp)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {!rarity && nft.attributes.length > 0 && (
                <ul className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
                  {nft.attributes.map((attribute, index) => (
                    <li
                      key={`${attribute.trait_type}-${index}`}
                      className="min-w-0 rounded-lg border border-line bg-wood-950 px-3 py-2.5"
                    >
                      <p className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">
                        {attribute.trait_type || "Trait"}
                      </p>
                      <p className="mt-1 text-xs font-bold text-foreground">
                        {String(attribute.value ?? "—")}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:flex-wrap sm:px-5">
          {/* Market hand-off only — the gallery never re-implements Offer,
              List, or Send; it just routes to /market with the right deep
              link so ItemDetail (item view) or My Listings (positions tab)
              picks up the verified flow. */}
          {isOwner ? (
            <>
              <Link
                href="/market?tab=positions"
                className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg bg-gold-500 px-4 py-3 text-sm font-bold text-wood-950 transition hover:bg-gold-400"
              >
                List for sale
              </Link>
              <Link
                href={`/market?item=${nft.tokenId}`}
                className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg border border-line-strong px-4 py-3 text-sm font-bold text-gold-300 transition hover:border-gold-400"
              >
                Send
              </Link>
            </>
          ) : (
            <Link
              href={`/market?item=${nft.tokenId}`}
              className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg bg-gold-500 px-4 py-3 text-sm font-bold text-wood-950 transition hover:bg-gold-400"
            >
              Make offer
            </Link>
          )}
          <a
            href={`${ROBINHOOD_EXPLORER_URL}/token/${NFT_CONTRACT_ADDRESS}/instance/${nft.tokenId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line-strong px-4 py-3 text-sm font-bold text-gold-300 transition hover:border-gold-400"
          >
            View on explorer <ExternalLink size={14} strokeWidth={2.5} />
          </a>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg border border-line-strong px-4 py-3 text-sm font-bold text-gold-300 transition hover:border-gold-400"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Gallery() {
  const [items, setItems] = useState<GalleryNft[]>([]);
  const [totalMinted, setTotalMinted] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  // `queryInput` is what the text box shows and updates on every keystroke.
  // `query` is debounced off it and is the only one the expensive filter
  // pass (matchesGalleryQuery over up to ~1,542 tokens, ~10-15ms/keystroke
  // measured) actually reads — so typing stays instant in the box while the
  // grid recomputes at most a few times a second instead of once a keystroke.
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [status, setStatus] = useState("Connecting to Robinhood Chain…");
  const [selected, setSelected] = useState<GalleryNft | null>(null);
  const [livePulse, setLivePulse] = useState(false);
  // Rarest is the default: on a fully-minted collection "newest" just means
  // "highest token id", which reads as random and tells a browser nothing.
  // Token id order is kept as an explicit, honestly-labeled option below
  // ("Token #") since it's still the only stable way to find a specific plank.
  const [sortMode, setSortMode] = useState<"rarest" | "tokenId">("rarest");
  const [panel, setPanel] = useState<GalleryPanel>(DEFAULT_GALLERY_PANEL);
  /** Token ids from Insights checkbox filters — null means no insight filter */
  const [insightFilterIds, setInsightFilterIds] = useState<number[] | null>(null);
  /** Tier multi-select — empty set means no tier filter. Composes with
   *  insightFilterIds/search/panel in the one `filtered` pipeline below. */
  const [tierFilter, setTierFilter] = useState<Set<RarityTier>>(() => new Set());
  const [holoOnly, setHoloOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // My NFTs tab. First wallet state in this file — the modal's one-shot
  // getConnectedAccounts() stays as it is, since it only decides which CTA to
  // show and does not need to react to connect/disconnect.
  const { address, isConnected, openConnect } = useWallet();
  /** The resolved bag, tagged with the wallet it belongs to. Tagging rather
   *  than clearing on change is what makes a stale bag structurally
   *  unshowable: `ownedIds` below simply does not match a different address,
   *  so a wallet switch can never render the previous wallet's planks even for
   *  a frame, and no reset write is needed. */
  const [owned, setOwned] = useState<{ owner: string; ids: Set<number> } | null>(null);
  /** Bumped by Recheck to force past the 45s inventory cache. */
  const [ownedNonce, setOwnedNonce] = useState(0);
  /** null = unresolved, which is also the disconnected state. One value, so
   *  there is no separate loading flag that could disagree with it. */
  const ownedIds =
    address && owned?.owner === address.toLowerCase() ? owned.ids : null;

  /** Max supply id we've staged placeholders for */
  const knownMaxRef = useRef(0);
  /** tokenIds currently in-flight for network hydrate */
  const loadingIdsRef = useRef<Set<number>>(new Set());
  /** tokenIds with metadata painted (loaded true) */
  const loadedIdsRef = useRef<Set<number>>(new Set());
  /** Bumped only on unmount — polls must NOT cancel hydration */
  const aliveRef = useRef(true);
  const hydratingRef = useRef(false);
  const queueRef = useRef<number[]>([]);

  const upsertItems = useCallback((incoming: GalleryNft[]) => {
    setItems((previous) => {
      const map = new Map(previous.map((item) => [item.tokenId, item]));
      for (const item of incoming) {
        map.set(item.tokenId, item);
      }
      return Array.from(map.values()).sort(sortNewestFirst);
    });
  }, []);

  const recountLoaded = useCallback(() => {
    setLoadedCount(loadedIdsRef.current.size);
  }, []);

  const makePlaceholder = useCallback((tokenId: number): GalleryNft => {
    const cached = getCachedToken(tokenId);
    // Only treat as fully loaded when art or traits actually exist
    if (cached && hasFreshMetadata(tokenId)) {
      const nft = recordToGalleryNft(cached, true);
      loadedIdsRef.current.add(tokenId);
      return nft;
    }
    if (cached && (cached.imageUri || cached.attributes?.length)) {
      // Partial success without full freshness check
      const nft = recordToGalleryNft(cached, Boolean(cached.imageUri));
      if (cached.imageUri) loadedIdsRef.current.add(tokenId);
      return nft;
    }
    if (cached?.error || (cached && !cached.imageUri)) {
      invalidateIncompleteToken(tokenId);
    }
    const name = cached?.name || `RobinWood Plank #${tokenId}`;
    const idx = indexNft({ tokenId, name, owner: cached?.owner || "" });
    return {
      tokenId,
      tokenUri: cached?.tokenUri || "",
      name,
      description: "",
      imageUri: "",
      attributes: [],
      owner: cached?.owner || "",
      searchText: idx.searchText,
      searchWords: idx.words,
      loaded: false,
    };
  }, []);

  const hydrateToken = useCallback(
    async (tokenId: number, contract: Contract): Promise<GalleryNft> => {
      const fallbackName = `RobinWood Plank #${tokenId}`;

      // Immutable metadata cache hit — only refresh owner if stale
      if (hasFreshMetadata(tokenId)) {
        const rec = getCachedToken(tokenId)!;
        let owner = rec.owner;
        if (!hasFreshOwner(tokenId)) {
          try {
            owner = (await contract.ownerOf(tokenId)) as string;
            putTokenOwner(tokenId, owner);
            touchMintReadClient();
          } catch {
            /* keep cached owner */
          }
        }
        const updated = putTokenMetadata(tokenId, {
          tokenUri: rec.tokenUri,
          name: rec.name,
          description: rec.description,
          imageUri: rec.imageUri,
          attributes: rec.attributes,
          owner,
        });
        return recordToGalleryNft(updated, true);
      }

      // Drop sticky bad cache so we re-pull tokenURI + IPFS
      invalidateIncompleteToken(tokenId);

      let tokenUri = getCachedToken(tokenId)?.tokenUri || "";
      let owner = hasFreshOwner(tokenId) ? getCachedToken(tokenId)?.owner || "" : "";

      // Always re-read tokenURI for incomplete newest mints (URI may update on reveal)
      const forceUri = !tokenUri || needsMetadataRetry(tokenId);
      if (forceUri) {
        try {
          tokenUri = (await contract.tokenURI(tokenId)) as string;
          if (tokenUri) putTokenUri(tokenId, tokenUri);
          touchMintReadClient();
        } catch {
          /* keep previous */
        }
      }

      if (!owner) {
        try {
          owner = (await contract.ownerOf(tokenId)) as string;
          putTokenOwner(tokenId, owner);
          touchMintReadClient();
        } catch {
          /* keep empty */
        }
      }

      if (!tokenUri) {
        // NOT permanent — short-lived failure so poll retries
        const rec = putTokenMetadata(tokenId, {
          tokenUri: "",
          name: fallbackName,
          description: "",
          imageUri: "",
          attributes: [],
          owner,
          error: "tokenURI unavailable",
        });
        // Mark incomplete so hasFreshMetadata is false
        invalidateIncompleteToken(tokenId);
        return recordToGalleryNft(rec, false);
      }

      try {
        // force:true when we already failed once — bypass stale empty metadata cache
        const metadata: NftMetadata = await fetchNftMetadata(tokenUri, {
          force: needsMetadataRetry(tokenId),
        });
        const name = metadata.name?.trim() || fallbackName;
        const description = metadata.description?.trim() || "";
        const attributes = Array.isArray(metadata.attributes)
          ? metadata.attributes
          : [];
        const imageUri = (metadata.image || "").trim();
        const rec = putTokenMetadata(tokenId, {
          tokenUri,
          name,
          description,
          imageUri,
          attributes,
          owner,
        });
        // Only "loaded" when we have art or traits
        const ok = Boolean(imageUri || attributes.length);
        if (!ok) invalidateIncompleteToken(tokenId);
        return recordToGalleryNft(rec, ok);
      } catch {
        const rec = putTokenMetadata(tokenId, {
          tokenUri,
          name: fallbackName,
          description: "",
          imageUri: "",
          attributes: [],
          owner,
          error: "metadata unavailable",
        });
        invalidateIncompleteToken(tokenId);
        return recordToGalleryNft(
          { ...rec, error: "metadata unavailable" },
          false,
        );
      }
    },
    [],
  );

  /**
   * Drain hydrate queue. Safe to call while already running — enqueues work.
   * Polls never cancel this; only unmount (aliveRef) stops it.
   */
  const drainHydrateQueue = useCallback(
    async (contract: Contract) => {
      if (hydratingRef.current) return;
      hydratingRef.current = true;

      try {
        while (aliveRef.current) {
          // Prefer newest first
          queueRef.current.sort((a, b) => b - a);
          const next: number[] = [];
          while (next.length < META_CONCURRENCY && queueRef.current.length) {
            const id = queueRef.current.shift()!;
            if (loadingIdsRef.current.has(id)) continue;
            if (loadedIdsRef.current.has(id) && hasFreshMetadata(id)) continue;
            loadingIdsRef.current.add(id);
            next.push(id);
          }
          if (!next.length) break;

          const resolved = await Promise.all(
            next.map(async (tokenId) => {
              try {
                return await hydrateToken(tokenId, contract);
              } finally {
                loadingIdsRef.current.delete(tokenId);
              }
            }),
          );

          if (!aliveRef.current) return;

          for (const nft of resolved) {
            if (nft.loaded && (nft.imageUri || nft.attributes.length)) {
              loadedIdsRef.current.add(nft.tokenId);
            } else {
              // Keep incomplete out of "done" so polls re-queue art
              loadedIdsRef.current.delete(nft.tokenId);
            }
          }
          upsertItems(resolved);
          recountLoaded();

          const supply = knownMaxRef.current;
          if (supply > 0) {
            const done = loadedIdsRef.current.size;
            setStatus(
              done >= supply
                ? `Live gallery · ${supply.toLocaleString()} minted · newest top-left`
                : `Indexing ${done.toLocaleString()} / ${supply.toLocaleString()} Planks…`,
            );
          }
        }
      } finally {
        hydratingRef.current = false;
        // If more work arrived while finishing, continue
        if (aliveRef.current && queueRef.current.length) {
          void drainHydrateQueue(contract);
        }
      }
    },
    [hydrateToken, recountLoaded, upsertItems],
  );

  const enqueueHydrate = useCallback(
    (ids: number[], contract: Contract, opts?: { force?: boolean }) => {
      const pending = ids.filter((id) => {
        if (opts?.force) return needsMetadataRetry(id) || !hasFreshMetadata(id);
        if (loadingIdsRef.current.has(id)) return false;
        if (hasFreshMetadata(id) && hasFreshOwner(id)) return false;
        return needsMetadataRetry(id) || !loadedIdsRef.current.has(id);
      });
      if (!pending.length) return;
      const queued = new Set(queueRef.current);
      // Newest first in queue head so live mints paint ASAP
      const ordered = [...pending].sort((a, b) => b - a);
      for (const id of ordered) {
        if (!queued.has(id) && !loadingIdsRef.current.has(id)) {
          queueRef.current.unshift(id);
          queued.add(id);
        }
      }
      void drainHydrateQueue(contract);
    },
    [drainHydrateQueue],
  );

  const stageIds = useCallback(
    (ids: number[]) => {
      if (!ids.length) return;
      const staged = ids.map(makePlaceholder);
      upsertItems(staged);
      recountLoaded();
    },
    [makePlaceholder, recountLoaded, upsertItems],
  );

  /**
   * Cold-start fast path: RobinWood is a fixed, fully-minted, immutable
   * collection, so instead of walking tokenURI + IPFS metadata per token
   * (what hydrateToken below does), pull the whole precomputed dataset in
   * ONE request and prime the same nft-cache the rest of the gallery reads
   * from. Ownership is intentionally NOT in this dataset — it stays on the
   * existing lazy path (hydrateToken's owner-only branch, modal open, owner
   * search), since only supply/metadata is static here.
   */
  const primeFromCollectionIndex = useCallback(async () => {
    try {
      // Revalidate rather than force-cache. force-cache reuses the stored
      // response indefinitely, so a server-side rebuild could never reach a
      // browser that had already visited — planks #1-180 stayed unrevealed on
      // screen for days after the data behind them was corrected. The payload
      // is unchanged in the common case and comes back as a 304.
      const res = await fetch("/api/market/collection-index", {
        cache: "no-cache",
      });
      if (!res.ok || !aliveRef.current) return;
      const data = (await res.json()) as {
        builtAt?: number;
        totalSupply?: number;
        entries?: Array<{
          tokenId: number;
          tokenUri: string;
          name: string;
          description: string;
          imageUri: string;
          attributes: NftAttribute[];
        }>;
      };
      const entries = Array.isArray(data.entries) ? data.entries : [];
      if (!entries.length || !aliveRef.current) return;

      // Did the server rebuild since we last applied this dataset?
      //
      // The per-token cache holds metadata for 7 days on the assumption that
      // it is immutable post-reveal. That assumption broke once: the server
      // shipped pre-reveal stubs, and when the server data was later fixed,
      // the hasFreshMetadata() guard below skipped every corrected token
      // precisely because the stale copy was still "fresh". A rebuild has to
      // be able to win, so compare builtAt and override wholesale when it
      // moves.
      const rebuilt = (() => {
        if (typeof data.builtAt !== "number") return false;
        try {
          const seen = Number(window.localStorage.getItem(INDEX_STAMP_KEY) || 0);
          if (data.builtAt <= seen) return false;
          window.localStorage.setItem(INDEX_STAMP_KEY, String(data.builtAt));
          return true;
        } catch {
          return false;
        }
      })();

      for (const entry of entries) {
        // Already fresh (e.g. a poll or prior session beat this here) —
        // don't clobber a possibly-newer cached owner/tokenUri pairing.
        // A server rebuild is the one thing that outranks that.
        if (!rebuilt && hasFreshMetadata(entry.tokenId)) continue;
        // Dataset entry itself is incomplete (rare: first-ever cold build
        // before the backing trait/image scans finished) — let the normal
        // chain+IPFS hydrate path fill this one in as before.
        if (!entry.imageUri && entry.attributes.length === 0) continue;
        putTokenMetadata(entry.tokenId, {
          tokenUri: entry.tokenUri,
          name: entry.name,
          description: entry.description,
          imageUri: entry.imageUri,
          attributes: entry.attributes,
        });
      }

      const supply = data.totalSupply || entries.length;
      if (supply > knownMaxRef.current) knownMaxRef.current = supply;
      setTotalMinted((prev) => Math.max(prev, supply));

      const painted: GalleryNft[] = [];
      for (let id = supply; id >= 1; id -= 1) {
        const rec = getCachedToken(id);
        if (rec && hasFreshMetadata(id)) {
          painted.push(recordToGalleryNft(rec, true));
          loadedIdsRef.current.add(id);
        } else {
          painted.push(makePlaceholder(id));
        }
      }
      if (!aliveRef.current) return;
      upsertItems(painted);
      recountLoaded();
      setStatus(`Live gallery · ${supply.toLocaleString()} minted · dataset loaded`);
    } catch {
      // Dataset endpoint unavailable — fall straight back to the existing
      // chain+IPFS per-token walk (syncMinted/hydrateToken), unchanged.
    }
  }, [makePlaceholder, recountLoaded, upsertItems]);

  const syncMinted = useCallback(
    async (mode: "full" | "poll" = "full") => {
      try {
        if (mode === "full") {
          setStatus((s) =>
            items.length || getCachedSupply()
              ? s.startsWith("Live") || s.startsWith("Indexing")
                ? s
                : "Refreshing gallery…"
              : "Connecting to Robinhood Chain…",
          );
        }

        const { contract } = await getMintReadClient();
        const supply = Number(await contract.totalSupply());
        if (!aliveRef.current) return;

        touchMintReadClient();
        setCachedSupply(supply);
        setTotalMinted(supply);

        if (supply === 0) {
          setStatus("No Planks minted yet.");
          setItems([]);
          knownMaxRef.current = 0;
          loadedIdsRef.current.clear();
          loadingIdsRef.current.clear();
          queueRef.current = [];
          setLoadedCount(0);
          return;
        }

        const prevMax = knownMaxRef.current;

        // Newly minted ids only
        if (supply > prevMax) {
          const newIds: number[] = [];
          for (let id = prevMax + 1; id <= supply; id += 1) newIds.push(id);
          knownMaxRef.current = supply;

          // Newest first for stage order
          newIds.sort((a, b) => b - a);
          const stageNow = newIds.slice(0, Math.max(INITIAL_STAGE, PAGE_SIZE));
          const stageLater = newIds.slice(stageNow.length);

          stageIds(stageNow);
          setLivePulse(true);
          window.setTimeout(() => setLivePulse(false), 900);
          setStatus(`Loading ${supply.toLocaleString()} minted Planks…`);

          enqueueHydrate(stageNow, contract);
          if (stageLater.length) {
            // Stage placeholders for the rest without blocking
            stageIds(stageLater);
            enqueueHydrate(stageLater, contract);
          }
        } else if (prevMax === 0 && supply > 0) {
          // First run with cache paint already done, or empty known
          knownMaxRef.current = supply;
        }

        // Always keep the newest window hot — never leave recent mints without art
        const newestWindow: number[] = [];
        for (let id = supply; id >= Math.max(1, supply - 47); id -= 1) {
          newestWindow.push(id);
        }
        stageIds(newestWindow);
        enqueueHydrate(newestWindow, contract, { force: true });

        // Re-queue anything still unloaded (recover from past stalls / bad cache)
        if (mode === "full" || loadedIdsRef.current.size < supply) {
          const missing: number[] = [];
          for (let id = supply; id >= 1; id -= 1) {
            if (!loadedIdsRef.current.has(id) || !hasFreshMetadata(id)) {
              missing.push(id);
            }
          }
          if (missing.length) {
            for (let i = 0; i < missing.length; i += INITIAL_STAGE) {
              stageIds(missing.slice(i, i + INITIAL_STAGE));
            }
            enqueueHydrate(missing, contract);
          }
        }

        const artReady = loadedIdsRef.current.size;
        if (artReady >= supply) {
          setStatus(
            `Live gallery · ${supply.toLocaleString()} minted · newest top-left`,
          );
        } else if (mode === "poll") {
          setStatus(
            `Live gallery · ${supply.toLocaleString()} minted · art ${artReady.toLocaleString()}/${supply.toLocaleString()}`,
          );
        }
      } catch (error) {
        if (!aliveRef.current) return;
        const message =
          error instanceof Error ? error.message : "Unable to sync gallery.";
        // Keep cached grid visible
        setStatus((prev) =>
          items.length || loadedIdsRef.current.size
            ? `Sync pause: ${message}`
            : `Gallery sync issue: ${message}`,
        );
      }
    },
    // items.length only used for status strings — omit to avoid resubscribe storms
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enqueueHydrate, stageIds],
  );

  // Bootstrap from local cache before any RPC
  useEffect(() => {
    aliveRef.current = true;
    ensureNftCacheHydrated();
    const cachedSupply = getCachedSupply();
    if (cachedSupply && cachedSupply.value > 0) {
      const supply = cachedSupply.value;
      setTotalMinted(supply);
      knownMaxRef.current = supply;
      const ids: number[] = [];
      for (let id = supply; id >= 1; id -= 1) ids.push(id);
      // Paint cached metadata immediately (newest first)
      const painted: GalleryNft[] = [];
      for (const id of ids) {
        const rec = getCachedToken(id);
        if (rec && (rec.imageUri || rec.metaAt)) {
          painted.push(recordToGalleryNft(rec, true));
          loadedIdsRef.current.add(id);
        } else {
          painted.push(makePlaceholder(id));
        }
      }
      setItems(painted);
      setLoadedCount(loadedIdsRef.current.size);
      setStatus(
        loadedIdsRef.current.size >= supply
          ? `Live gallery · ${supply.toLocaleString()} minted · cached`
          : `Restored ${loadedIdsRef.current.size.toLocaleString()} cached · syncing…`,
      );
    }

    // Dataset first (single request, primes the immutable metadata for the
    // whole fixed collection), THEN the chain walk — which will now see
    // hasFreshMetadata() true for every primed token and skip straight to
    // its cheap owner-only branch instead of re-fetching tokenURI + IPFS.
    void primeFromCollectionIndex().finally(() => {
      void syncMinted("full");
    });
    const stopPoll = startVisibleInterval(() => void syncMinted("poll"), POLL_MS);

    return () => {
      aliveRef.current = false;
      stopPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce the expensive filter pass off the keystroke. 160ms is short
  // enough that it never reads as lag (well under the ~250ms people notice as
  // "sluggish") but skips the recompute for every character of a fast typist.
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(queryInput), 160);
    return () => window.clearTimeout(id);
  }, [queryInput]);

  // Reset pagination whenever the result set changes underneath it. Not just
  // `query`: switching panels changes the set too, and carrying a visibleCount
  // of 240 into a three-plank bag renders a stale "Collapse" footer over
  // nothing. `ownedIds` resolving (null -> Set) is the same kind of change.
  // tierFilter/holoOnly are new filter axes that narrow the same list, so they
  // reset pagination for the same reason.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, panel, ownedIds, tierFilter, holoOnly]);

  // URL state. `?q=` is the deep link from the landing page's wallet lookup
  // (WalletLookupCard) and `?tab=` selects the panel.
  //
  // Both are read in an effect and never during render: the server has no
  // `location`, so seeding state from it would hydrate mismatched markup. Same
  // rule components/market/MarketView.tsx documents, and the reason this file
  // does not reach for useSearchParams.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => {
      const params = new URLSearchParams(window.location.search);
      const q = params.get("q") ?? "";
      // Seed both the box and the debounced filter value directly — a deep
      // link with `?q=` should show results on first paint, not after a
      // 160ms debounce delay it never actually needed.
      setQueryInput(q);
      setQuery(q);
      setPanel(parseGalleryTab(params.get("tab")));
    };
    sync();
    // Back/Forward, and the nav's same-route click on /gallery, which changes
    // only the query string and so cannot remount this component.
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  /**
   * Which planks this wallet holds.
   *
   * Deliberately NOT derived from items[].owner: that field is filled in by the
   * slow per-token ownerOf() chain walk, so on a cold load it is empty for
   * almost everything and the tab would look empty for a holder. tokenOfOwnerByIndex
   * via getOwnedTokenIds is the authoritative answer and is already cached.
   */
  useEffect(() => {
    // A tab nobody opens costs no RPC.
    if (panel !== "my-nfts" || !address) return;
    const owner = address.toLowerCase();
    let alive = true;
    void getOwnedTokenIds(NFT_CONTRACT_ADDRESS, address, {
      force: ownedNonce > 0,
    }).then((ids) => {
      if (alive) setOwned({ owner, ids: toNumericTokenIds(ids) });
    });
    return () => {
      alive = false;
    };
  }, [panel, address, ownedNonce]);

  /** Single URL writer, mirroring MarketView's: the default panel drops the
   *  param entirely so the canonical URL stays a bare /gallery, and everything
   *  else already in the query string (notably `?q=`) survives. */
  const selectPanel = useCallback((next: GalleryPanel) => {
    setPanel(next);
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (next === DEFAULT_GALLERY_PANEL) params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    window.history.pushState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, []);

  const rarity = useMemo(() => computeRaritySnapshot(items), [items]);

  /**
   * Panel + Insights cut only — the shared starting point both `filtered`
   * below and the empty-state diagnosis build on, split out so the two don't
   * silently drift out of sync (and so the diagnosis isn't a second copy of
   * this same narrowing).
   */
  const baseList = useMemo(() => {
    let list = items;
    // First cut, because it is the panel's defining constraint and the cheapest
    // (a Set.has over at most 200 ids). It narrows rather than replaces, so
    // search and sort still compose on top — searching inside your own bag is
    // the point, not a side effect.
    if (panel === "my-nfts") {
      if (!ownedIds) return [];
      list = list.filter((item) => ownedIds.has(item.tokenId));
    }
    if (insightFilterIds) {
      const allow = new Set(insightFilterIds);
      list = list.filter((item) => allow.has(item.tokenId));
    }
    return list;
  }, [items, panel, ownedIds, insightFilterIds]);

  const passesTierHolo = useCallback(
    (item: GalleryNft) => {
      if (tierFilter.size > 0) {
        const r = rarity.byTokenId.get(item.tokenId);
        if (!r || !tierFilter.has(r.tier)) return false;
      }
      if (holoOnly) {
        const r = rarity.byTokenId.get(item.tokenId);
        const holo = r?.traits.find(
          (t) => t.trait.trim().toLowerCase() === "holographic",
        );
        if (!holo || holo.value.trim().toLowerCase() !== "yes") return false;
      }
      return true;
    },
    [tierFilter, holoOnly, rarity],
  );

  const filtered = useMemo(() => {
    const q = query.trim();
    let list = baseList.filter(passesTierHolo);

    if (q) {
      list = list.filter((item) =>
        matchesGalleryQuery(
          q,
          item.searchText || "",
          item.searchWords || [],
          item.owner || "",
          item.tokenId,
        ),
      );
    }

    if (sortMode === "tokenId") {
      // Honest label for what this order actually is — ascending token id,
      // the one stable way to browse toward a specific plank.
      return [...list].sort((a, b) => a.tokenId - b.tokenId);
    }

    // Default: rarest first.
    return [...list].sort((a, b) => {
      const ra = rarity.byTokenId.get(a.tokenId);
      const rb = rarity.byTokenId.get(b.tokenId);
      if (ra && rb) return ra.rank - rb.rank || b.tokenId - a.tokenId;
      if (ra) return -1;
      if (rb) return 1;
      return b.tokenId - a.tokenId;
    });
  }, [baseList, passesTierHolo, query, sortMode, rarity]);

  /**
   * Which active constraint is responsible for an empty grid: the search
   * text, the tier/holo filters, or both together (each alone still finds
   * something, but not at the same time). Gated on `filtered.length === 0`
   * so it costs nothing on the common non-empty path — this never runs while
   * someone is just browsing.
   */
  const emptyCause = useMemo((): "search" | "filters" | "both" | null => {
    if (filtered.length > 0 || baseList.length === 0) return null;
    const q = query.trim();
    const tierHoloActive = tierFilter.size > 0 || holoOnly;
    if (!q && !tierHoloActive) return null;

    const searchHitsAnything = q
      ? baseList.some((item) =>
          matchesGalleryQuery(
            q,
            item.searchText || "",
            item.searchWords || [],
            item.owner || "",
            item.tokenId,
          ),
        )
      : true;
    const tierHoloHitsAnything = tierHoloActive
      ? baseList.some(passesTierHolo)
      : true;

    if (q && !searchHitsAnything) return "search";
    if (tierHoloActive && !tierHoloHitsAnything) return "filters";
    if (q && tierHoloActive) return "both";
    return null;
  }, [filtered.length, baseList, query, tierFilter, holoOnly, passesTierHolo]);

  const visible = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );

  const remaining = Math.max(0, filtered.length - visibleCount);
  const progress =
    totalMinted === 0
      ? 0
      : Math.min(100, Math.round((loadedCount / totalMinted) * 100));
  const searchActive = query.trim().length > 0;
  const metadataStillLoading = totalMinted > 0 && loadedCount < totalMinted;
  // Any filter axis that can legitimately explain an empty grid — used to
  // tell "no matches for these filters" apart from "still loading" in the
  // empty state below.
  const hasActiveFilters =
    tierFilter.size > 0 || holoOnly || insightFilterIds !== null;
  const selectedRarity = selected
    ? rarity.byTokenId.get(selected.tokenId)
    : undefined;

  function onSearchSubmit(event: FormEvent) {
    event.preventDefault();
  }

  function onSearchChange(value: string) {
    // Updates the box immediately; `query` (what actually drives filtering)
    // follows after the debounce effect above. visibleCount resets itself
    // once `query` lands, via the effect keyed on it.
    setQueryInput(value);
  }

  function clearSearch() {
    // Clearing is a decisive action, not a keystroke — skip the debounce so
    // the grid snaps back immediately instead of lagging behind an empty box.
    setQueryInput("");
    setQuery("");
  }

  function openToken(tokenId: number) {
    let nft = items.find((item) => item.tokenId === tokenId);
    // Insights may surface tokens from local cache before React state has them
    if (!nft) {
      const cached = getCachedToken(tokenId);
      if (cached && (cached.imageUri || cached.attributes?.length)) {
        const idx = indexNft({
          tokenId,
          name: cached.name,
          description: cached.description,
          attributes: cached.attributes,
          owner: cached.owner,
        });
        nft = {
          tokenId,
          tokenUri: cached.tokenUri,
          name: cached.name,
          description: cached.description,
          imageUri: cached.imageUri,
          attributes: cached.attributes,
          owner: cached.owner,
          searchText: idx.searchText,
          searchWords: idx.words,
          loaded: true,
        };
      }
    }
    if (nft) {
      setSelected(nft);
      // Stay on Insights if already there so art board isn't kicked out
    }
  }

  return (
    <section id="gallery" className="scroll-mt-20 px-3 py-10 sm:px-5 sm:py-12">
      {/* Capped to match the market mockup shell standard (1440px) — was
          max-w-6xl, then widened to 1800px for the grid; 1440px keeps the
          browsing surface roomy without the wide-monitor gutters. */}
      <div className="mx-auto max-w-[1440px]">
        <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-[0.7rem] font-extrabold uppercase tracking-[0.18em] text-gold-300">
              <span
                className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 ${
                  livePulse ? "animate-ping" : "animate-pulse"
                }`}
                aria-hidden="true"
              />
              Live rarity · revealed only
            </p>
            <h2 className="font-display text-3xl text-gold-300 sm:text-4xl">Gallery</h2>
            <p className="mt-1 max-w-xl text-sm text-foreground/65 sm:text-base">
              Minted art, live rarity, trait stats.
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {GALLERY_TABS.map(({ id, label }) => {
              const Icon =
                id === "insights" ? BarChart3 : id === "my-nfts" ? Wallet : LayoutGrid;
              return (
              <button
                key={id}
                type="button"
                onClick={() => selectPanel(id)}
                className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold transition ${
                  panel === id
                    ? "bg-gold-500 text-wood-950"
                    : "border border-line-strong text-gold-300 hover:border-gold-400"
                }`}
              >
                <Icon size={14} strokeWidth={2.5} />
                {label}
              </button>
              );
            })}
          </div>
        </div>

        <div data-market-shell className="overflow-hidden rounded-xl border border-line bg-panel shadow-panel">
          <div className="border-b border-line p-3 sm:p-3.5">
            <form
              onSubmit={onSearchSubmit}
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
              role="search"
            >
              <label htmlFor="gallery-search" className="sr-only">
                Search gallery
              </label>
              <div className="relative min-w-0 flex-1">
                <Search
                  size={14}
                  strokeWidth={2.5}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-cream-muted"
                  aria-hidden="true"
                />
                <input
                  id="gallery-search"
                  type="search"
                  value={queryInput}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="Filter: holo, rare, 0x…, vanity, #id"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="search"
                  className="min-h-11 w-full rounded-lg border border-line-strong bg-wood-950 py-2.5 pl-9 pr-3 text-sm font-bold text-foreground outline-none placeholder:text-foreground/40 focus:border-gold-300 sm:text-base"
                />
              </div>
              <div className="flex gap-1.5">
                {(
                  [
                    ["rarest", "Rarest"],
                    ["tokenId", "Token #"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setSortMode(id);
                      setVisibleCount(PAGE_SIZE);
                      // Sorting means "show me the grid", so leave Insights —
                      // but only Insights. Bouncing off My NFTs here would
                      // silently swap the result set out from under the sort
                      // the user just asked for.
                      if (panel === "insights") selectPanel("gallery");
                    }}
                    className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-bold sm:flex-none sm:text-sm ${
                      sortMode === id
                        ? "bg-gold-500 text-wood-950"
                        : "border border-line-strong text-gold-300 hover:border-gold-400"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                {panel !== "insights" && (
                  <button
                    type="button"
                    onClick={() => setFiltersOpen((v) => !v)}
                    aria-expanded={filtersOpen}
                    className={`inline-flex min-h-11 flex-1 items-center justify-center gap-1 rounded-lg px-3 py-2 text-xs font-bold sm:flex-none sm:text-sm ${
                      filtersOpen || tierFilter.size > 0 || holoOnly
                        ? "bg-gold-500 text-wood-950"
                        : "border border-line-strong text-gold-300 hover:border-gold-400"
                    }`}
                  >
                    <SlidersHorizontal size={12} strokeWidth={2.5} />
                    Filters
                    {tierFilter.size > 0 || holoOnly
                      ? ` · ${tierFilter.size + (holoOnly ? 1 : 0)}`
                      : ""}
                  </button>
                )}
                {queryInput && (
                  <button
                    type="button"
                    onClick={clearSearch}
                    className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-line-strong px-3 py-2 text-xs font-bold text-gold-300 sm:text-sm"
                  >
                    <X size={12} strokeWidth={2.5} />
                    Clear
                  </button>
                )}
              </div>
            </form>

            {/* Collapsible row — keeps the search bar itself from getting
                overloaded on mobile while still surfacing rarity/holo cuts.
                Counts come straight off the already-computed snapshot, so
                opening this costs no extra work. */}
            {panel !== "insights" && filtersOpen && (
              <div className="mt-2 flex flex-wrap gap-1.5 rounded-lg border border-line bg-wood-950 p-2">
                {TIER_ORDER.map((tier) => {
                  const active = tierFilter.has(tier);
                  const count = rarity.tierCounts[tier];
                  return (
                    <button
                      key={tier}
                      type="button"
                      onClick={() =>
                        setTierFilter((prev) => {
                          const next = new Set(prev);
                          if (next.has(tier)) next.delete(tier);
                          else next.add(tier);
                          return next;
                        })
                      }
                      className="min-h-9 rounded-full px-2.5 py-1 text-[0.7rem] font-extrabold"
                      style={
                        active
                          ? { background: tierColor(tier), color: "#261105" }
                          : {
                              border: `1px solid ${tierColor(tier)}66`,
                              color: tierColor(tier),
                              background: "transparent",
                            }
                      }
                    >
                      {tier} · {count.toLocaleString()}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setHoloOnly((v) => !v)}
                  className="min-h-9 rounded-full px-2.5 py-1 text-[0.7rem] font-extrabold"
                  style={
                    holoOnly
                      ? { background: "#67e8f9", color: "#083344" }
                      : {
                          border: "1px solid #67e8f966",
                          color: "#67e8f9",
                          background: "transparent",
                        }
                  }
                >
                  Holo · {rarity.holoYes.toLocaleString()}
                </button>
                {(tierFilter.size > 0 || holoOnly) && (
                  <button
                    type="button"
                    onClick={() => {
                      setTierFilter(new Set());
                      setHoloOnly(false);
                    }}
                    className="ml-auto min-h-9 rounded-lg px-2.5 py-1 text-[0.7rem] font-bold text-foreground/50 underline underline-offset-2 hover:text-gold-300"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-foreground/60 sm:text-sm">
              <p role="status" aria-live="polite" className="min-w-0">
                {searchActive
                  ? `${filtered.length.toLocaleString()} match${
                      filtered.length === 1 ? "" : "es"
                    }${metadataStillLoading ? ` · indexing ${progress}%` : ""}`
                  : status}
              </p>
              <div className="flex flex-wrap items-center gap-2 font-bold">
                <span className="rounded-full border border-line px-2 py-0.5 text-gold-300">
                  {totalMinted.toLocaleString()} minted
                </span>
                <span className="rounded-full border border-line px-2 py-0.5 text-gold-300">
                  {rarity.scoredCount.toLocaleString()} scored
                </span>
                {/* Every active filter is individually removable — a user who
                    lands on an empty grid can see and undo exactly what did
                    it, one chip at a time, without hunting for a reset. */}
                {Array.from(tierFilter).map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    onClick={() =>
                      setTierFilter((prev) => {
                        const next = new Set(prev);
                        next.delete(tier);
                        return next;
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
                    style={{ borderColor: `${tierColor(tier)}66`, color: tierColor(tier) }}
                    title={`Clear ${tier} filter`}
                  >
                    {tier}
                    <X size={10} strokeWidth={2.5} />
                  </button>
                ))}
                {holoOnly && (
                  <button
                    type="button"
                    onClick={() => setHoloOnly(false)}
                    className="inline-flex items-center gap-1 rounded-full border border-cyan-400/40 px-2 py-0.5 text-cyan-300"
                    title="Clear holo filter"
                  >
                    Holo
                    <X size={10} strokeWidth={2.5} />
                  </button>
                )}
                {insightFilterIds && (
                  <button
                    type="button"
                    onClick={() => setInsightFilterIds(null)}
                    className="inline-flex items-center gap-1 rounded-full border border-cyan-400/40 px-2 py-0.5 text-cyan-300"
                    title="Clear Insights dissect filters"
                  >
                    cut {insightFilterIds.length.toLocaleString()}
                    <X size={10} strokeWidth={2.5} />
                  </button>
                )}
                {metadataStillLoading && (
                  <span className="text-foreground/45">{progress}%</span>
                )}
              </div>
            </div>

            {metadataStillLoading && (
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-black/35">
                <div
                  className="h-full rounded-full bg-gold-500 transition-[width] duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
          </div>

          {panel === "insights" ? (
            <div className="max-h-[min(78dvh,900px)] overflow-y-auto overscroll-contain p-3 sm:p-4">
              <RarityInsights
                items={items}
                onSelectToken={openToken}
                onFilteredIdsChange={setInsightFilterIds}
              />
            </div>
          ) : (
            <>
              <div className="max-h-[min(70dvh,760px)] overflow-y-auto overscroll-contain p-2 sm:p-3">
                {/* My NFTs gates. Copy and framing are lifted from
                    components/market/MyNfts.tsx so the two wallet-scoped
                    surfaces read as one product rather than two features that
                    happen to share a name. */}
                {panel === "my-nfts" && !isConnected ? (
                  <div className="px-4 py-12 text-center">
                    <p className="text-sm text-cream-muted">
                      Connect a wallet to see the planks it holds.
                    </p>
                    <button
                      type="button"
                      onClick={openConnect}
                      className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-gold-500 px-4 text-sm font-bold text-wood-950 transition-colors hover:bg-gold-400"
                    >
                      Connect wallet
                    </button>
                  </div>
                ) : panel === "my-nfts" && ownedIds === null ? (
                  <p className="rounded-xl border border-line bg-panel px-4 py-8 text-center text-sm text-cream-muted">
                    Reading your planks from chain…
                  </p>
                ) : panel === "my-nfts" && ownedIds?.size === 0 ? (
                  // getOwnedTokenIds fails OPEN (lib/market/inventory.ts) — a
                  // transport blip and a genuinely empty wallet are the same
                  // value here, so there is no honest error state to render.
                  // Recheck (force: true) is the cover for the blip.
                  <p className="rounded-xl border border-line bg-panel px-4 py-8 text-center text-sm text-cream-muted">
                    This wallet holds no planks yet.
                    <button
                      type="button"
                      onClick={() => setOwnedNonce((n) => n + 1)}
                      className="ml-2 underline underline-offset-2 hover:text-gold-300"
                    >
                      Recheck
                    </button>
                  </p>
                ) : (
                <>
                {totalMinted === 0 && status.startsWith("Connecting") && (
                  // Cold, no-cache visit: the dataset request is still in
                  // flight. Same shape as the loaded grid — one shared
                  // implementation (components/Skeleton.tsx) instead of this
                  // file rolling its own card markup.
                  <SkeletonCardGrid count={INITIAL_STAGE} />
                )}

                {totalMinted === 0 && !status.startsWith("Connecting") && (
                  <p className="py-12 text-center text-sm text-foreground/60">
                    Waiting for the first mint…
                  </p>
                )}

                {totalMinted > 0 && filtered.length === 0 && (
                  <p className="py-12 text-center text-sm text-foreground/60">
                    {searchActive && metadataStillLoading
                      ? `No matches yet — indexing ${progress}%.`
                      : // With search and tier/holo filters both live, "nothing
                        // here" has more than one possible cause — emptyCause
                        // names which constraint(s) are actually responsible
                        // instead of leaving the user to guess and clear things
                        // one at a time.
                        emptyCause === "both"
                        ? `Nothing matches “${query.trim()}” together with the current filters — try clearing one.`
                        : emptyCause === "search"
                          ? `No matches for “${query.trim()}”.`
                          : emptyCause === "filters"
                            ? "No planks match the current tier/holo filters."
                            : searchActive
                              ? `No matches for “${query.trim()}”.`
                              : hasActiveFilters
                                ? // Distinguish "your filters did this" from the
                                  // still-loading case below — an empty grid
                                  // with active filters is not a bug to
                                  // investigate, it's a cut with zero members.
                                  "No planks match the current filters."
                                : // Reachable on My NFTs: the wallet holds
                                  // planks, but the collection index has not
                                  // staged those ids yet. Without this branch
                                  // it read `No matches for "".`
                                  "Loading your planks…"}
                  </p>
                )}

                {visible.length > 0 && (
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 sm:gap-2.5">
                    {visible.map((nft, index) => {
                      const tokenRarity = rarity.byTokenId.get(nft.tokenId);
                      return (
                        <li
                          key={nft.tokenId}
                          className="[content-visibility:auto] [contain-intrinsic-size:auto_200px]"
                        >
                          {/* Finalized mockup card: uniform quiet frame — rarity
                              communicated by the tier pill alone, no glow/holo/
                              animated border. Card lifts on hover instead. */}
                          <button
                            type="button"
                            onClick={() => setSelected(nft)}
                            className="dense-card group flex h-full w-full flex-col overflow-hidden p-0 text-left transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-line-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
                            aria-label={`Open ${displayName(nft)}`}
                          >
                            <div className="relative aspect-square w-full overflow-hidden bg-wood-900">
                              {!nft.loaded && !nft.imageUri ? (
                                <div className="flex h-full w-full animate-pulse items-center justify-center bg-wood-950/80 text-xl">
                                  🪵
                                </div>
                              ) : (
                                <NftImage
                                  imageUri={nft.imageUri}
                                  alt=""
                                  priority={index < 5}
                                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                                />
                              )}
                              <span className="card-overlay absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[0.65rem] font-bold text-gold-300">
                                #{nft.tokenId}
                              </span>
                              {tokenRarity && (
                                <span
                                  className="tier-badge card-overlay absolute bottom-1.5 right-1.5 rounded-full px-1.5 py-0.5 text-[0.55rem] font-black uppercase tracking-wide"
                                  style={{ color: tierColor(tokenRarity.tier) }}
                                  title={`Rank ${formatRank(tokenRarity.rank)}`}
                                >
                                  {formatRank(tokenRarity.rank)}
                                </span>
                              )}
                            </div>
                            <div className="space-y-0.5 p-2">
                              <p
                                className="line-clamp-1 text-xs font-bold text-foreground sm:text-sm"
                                title={displayName(nft)}
                              >
                                {displayName(nft)}
                              </p>
                              <div className="flex items-center justify-between gap-1">
                                {tokenRarity ? (
                                  <span
                                    className="truncate text-[0.65rem] font-bold"
                                    style={{ color: tierColor(tokenRarity.tier) }}
                                  >
                                    {tokenRarity.tier}
                                  </span>
                                ) : (
                                  <span className="text-[0.65rem] text-foreground/40">…</span>
                                )}
                                {tokenRarity && (
                                  <span className="font-mono text-[0.65rem] text-foreground/50">
                                    {tokenRarity.normalizedScore.toFixed(0)}
                                  </span>
                                )}
                              </div>
                              {nft.owner ? (
                                <p
                                  className="truncate font-mono text-[0.6rem] font-medium leading-none text-foreground/40"
                                  title={nft.owner}
                                >
                                  {shortOwner(nft.owner)}
                                </p>
                              ) : (
                                <p className="font-mono text-[0.6rem] leading-none text-foreground/25">
                                  0x····
                                </p>
                              )}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {/* getOwnedTokenIds caps its tokenOfOwnerByIndex walk at 200 so
                    a whale cannot stall the page. Say so rather than letting
                    the 201st plank vanish silently. */}
                {panel === "my-nfts" && ownedIds !== null && ownedIds.size >= 200 && (
                  <p className="px-2 pb-2 pt-3 text-center text-xs text-foreground/60">
                    Showing the first 200 planks this wallet holds.
                  </p>
                )}
                </>
                )}
              </div>

              {filtered.length > PAGE_SIZE && (
                <div className="flex flex-col gap-2 border-t border-line bg-panel-strong px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                  <p className="text-xs text-foreground/60 sm:text-sm">
                    {Math.min(visibleCount, filtered.length)} / {filtered.length.toLocaleString()}
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 sm:flex">
                    {remaining > 0 ? (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setVisibleCount((count) =>
                              Math.min(filtered.length, count + PAGE_SIZE),
                            )
                          }
                          className="min-h-10 rounded-lg bg-gold-500 px-3 py-2 text-xs font-bold text-wood-950 transition hover:bg-gold-400 sm:text-sm"
                        >
                          +{Math.min(PAGE_SIZE, remaining)} more
                        </button>
                        <button
                          type="button"
                          onClick={() => setVisibleCount(filtered.length)}
                          className="min-h-10 rounded-lg border border-line-strong px-3 py-2 text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:text-sm"
                        >
                          All
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setVisibleCount(PAGE_SIZE)}
                        className="min-h-10 rounded-lg border border-line-strong px-3 py-2 text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:col-span-2 sm:text-sm"
                      >
                        Collapse
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {selected && (
        <GalleryDetailModal
          key={selected.tokenId}
          nft={selected}
          rarity={selectedRarity}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
