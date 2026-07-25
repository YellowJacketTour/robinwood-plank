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
import Reveal from "@/components/Reveal";
import NftImage from "@/components/NftImage";
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
  NFT_ABI,
  NFT_CONTRACT_ADDRESS,
  ROBINHOOD_EXPLORER_URL,
} from "@/lib/mint-contract";
import { getMintReadClient } from "@/lib/robinhood-provider";
import {
  computeRaritySnapshot,
  formatRank,
  tierColor,
  type TokenRarity,
} from "@/lib/rarity";
import type { GalleryNft } from "@/lib/gallery-types";
import RarityInsights from "@/components/RarityInsights";

export type { GalleryNft };

const POLL_MS = 20_000;
const URI_BATCH = 16;
const META_CONCURRENCY = 8;
const PAGE_SIZE = 24;
/** First paint: stage this many cards immediately (newest first). */
const INITIAL_STAGE = 48;

function shortOwner(owner: string) {
  if (!owner || owner.length < 10) return owner || "—";
  return `${owner.slice(0, 6)}…${owner.slice(-4)}`;
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
        className="nft-modal wood-frame relative flex max-h-[min(92dvh,880px)] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-wood-900 sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-gold-500/25 px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <p className="text-[0.7rem] font-extrabold uppercase tracking-[0.16em] text-gold-300">
              Gallery · Minted
              {rarity && (
                <span className="ml-2" style={{ color: tierColor(rarity.tier) }}>
                  · {rarity.tier} {formatRank(rarity.rank)}
                </span>
              )}
            </p>
            <h3 id={titleId} className="nft-modal-title mt-1 font-display text-foreground">
              {nft.name}
            </h3>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-gold-500/40 text-2xl leading-none text-gold-300"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="nft-modal-body min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="grid sm:grid-cols-2">
            <div className="relative mx-auto aspect-square w-full max-w-[360px] bg-wood-950 sm:max-w-none">
              <NftImage
                imageUri={nft.imageUri}
                alt={nft.name}
                priority
                className="h-full w-full object-contain p-3"
              />
            </div>
            <div className="min-w-0 space-y-4 p-4 sm:p-5">
              <dl className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2">
                  <dt className="uppercase tracking-wide text-foreground/55">Token</dt>
                  <dd className="mt-0.5 font-mono">#{nft.tokenId}</dd>
                </div>
                <div className="rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2">
                  <dt className="uppercase tracking-wide text-foreground/55">Owner</dt>
                  <dd className="mt-0.5 font-mono text-sm" title={nft.owner || undefined}>
                    {nft.owner ? shortOwner(nft.owner) : "—"}
                  </dd>
                </div>
                {rarity && (
                  <>
                    <div className="rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2">
                      <dt className="uppercase tracking-wide text-foreground/55">Rank</dt>
                      <dd className="mt-0.5 font-mono" style={{ color: tierColor(rarity.tier) }}>
                        {formatRank(rarity.rank)} · {rarity.tier}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2">
                      <dt className="uppercase tracking-wide text-foreground/55">Score</dt>
                      <dd className="mt-0.5 font-mono">
                        {rarity.normalizedScore.toFixed(1)}
                        <span className="text-foreground/45"> / 100</span>
                      </dd>
                    </div>
                  </>
                )}
              </dl>
              {rarity && rarity.traits.length > 0 && (
                <div>
                  <h4 className="mb-1.5 text-xs font-extrabold uppercase tracking-[0.12em] text-gold-300">
                    Trait rarity
                  </h4>
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
                </div>
              )}
              {!rarity && nft.attributes.length > 0 && (
                <ul className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
                  {nft.attributes.map((attribute, index) => (
                    <li
                      key={`${attribute.trait_type}-${index}`}
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
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-gold-500/25 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:px-5">
          <a
            href={`${ROBINHOOD_EXPLORER_URL}/token/${NFT_CONTRACT_ADDRESS}/instance/${nft.tokenId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg bg-gold-500 px-4 py-3 font-extrabold text-wood-950"
          >
            View on explorer ↗
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

export default function Gallery() {
  const [items, setItems] = useState<GalleryNft[]>([]);
  const [totalMinted, setTotalMinted] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [status, setStatus] = useState("Connecting to Robinhood Chain…");
  const [selected, setSelected] = useState<GalleryNft | null>(null);
  const [livePulse, setLivePulse] = useState(false);
  const [sortMode, setSortMode] = useState<"newest" | "rarest">("newest");
  const [panel, setPanel] = useState<"gallery" | "insights">("gallery");

  const knownIdsRef = useRef<Set<number>>(new Set());
  const loadingIdsRef = useRef<Set<number>>(new Set());
  const itemsCountRef = useRef(0);
  const syncGenRef = useRef(0);

  const upsertItems = useCallback((incoming: GalleryNft[]) => {
    setItems((previous) => {
      const map = new Map(previous.map((item) => [item.tokenId, item]));
      for (const item of incoming) {
        map.set(item.tokenId, item);
      }
      const next = Array.from(map.values()).sort(sortNewestFirst);
      itemsCountRef.current = next.length;
      return next;
    });
  }, []);

  const makePlaceholder = useCallback((tokenId: number): GalleryNft => {
    const name = `RobinWood Plank #${tokenId}`;
    const idx = indexNft({ tokenId, name, owner: "" });
    return {
      tokenId,
      tokenUri: "",
      name,
      description: "",
      imageUri: "",
      attributes: [],
      owner: "",
      searchText: idx.searchText,
      searchWords: idx.words,
      loaded: false,
    };
  }, []);

  const hydrateToken = useCallback(
    async (tokenId: number, contract: Contract): Promise<GalleryNft> => {
      const fallbackName = `RobinWood Plank #${tokenId}`;
      let tokenUri = "";
      let owner = "";
      try {
        tokenUri = (await contract.tokenURI(tokenId)) as string;
      } catch {
        /* keep empty */
      }
      try {
        owner = (await contract.ownerOf(tokenId)) as string;
      } catch {
        /* keep empty */
      }

      if (!tokenUri) {
        const idx = indexNft({ tokenId, name: fallbackName, owner });
        return {
          tokenId,
          tokenUri: "",
          name: fallbackName,
          description: "",
          imageUri: "",
          attributes: [],
          owner,
          searchText: idx.searchText,
          searchWords: idx.words,
          loaded: true,
          error: "tokenURI unavailable",
        };
      }

      try {
        const metadata: NftMetadata = await fetchNftMetadata(tokenUri);
        const name = metadata.name?.trim() || fallbackName;
        const description = metadata.description?.trim() || "";
        const attributes = Array.isArray(metadata.attributes)
          ? metadata.attributes
          : [];
        const idx = indexNft({
          tokenId,
          name,
          description,
          attributes,
          owner,
        });
        return {
          tokenId,
          tokenUri,
          name,
          description,
          imageUri: metadata.image || "",
          attributes,
          owner,
          searchText: idx.searchText,
          searchWords: idx.words,
          loaded: true,
        };
      } catch {
        const idx = indexNft({ tokenId, name: fallbackName, owner });
        return {
          tokenId,
          tokenUri,
          name: fallbackName,
          description: "",
          imageUri: "",
          attributes: [],
          owner,
          searchText: idx.searchText,
          searchWords: idx.words,
          loaded: true,
          error: "metadata unavailable",
        };
      }
    },
    [],
  );

  const loadMetadataForIds = useCallback(
    async (tokenIds: number[], contract: Contract, gen: number) => {
      const pending = tokenIds.filter((id) => !loadingIdsRef.current.has(id));
      if (!pending.length) return;

      for (const id of pending) loadingIdsRef.current.add(id);

      const ordered = [...pending].sort((a, b) => b - a);

      for (let offset = 0; offset < ordered.length; offset += URI_BATCH) {
        if (syncGenRef.current !== gen) return;
        const slice = ordered.slice(offset, offset + URI_BATCH);

        for (let i = 0; i < slice.length; i += META_CONCURRENCY) {
          if (syncGenRef.current !== gen) return;
          const chunk = slice.slice(i, i + META_CONCURRENCY);
          const resolved = await Promise.all(
            chunk.map((tokenId) => hydrateToken(tokenId, contract)),
          );
          if (syncGenRef.current !== gen) return;
          upsertItems(resolved);
          setLoadedCount((count) => count + resolved.length);
        }
      }
    },
    [hydrateToken, upsertItems],
  );

  const syncMinted = useCallback(async () => {
    const gen = ++syncGenRef.current;
    try {
      setStatus("Connecting to Robinhood Chain…");
      const { contract } = await getMintReadClient();
      const supply = Number(await contract.totalSupply());
      if (syncGenRef.current !== gen) return;

      setTotalMinted(supply);

      if (supply === 0) {
        setStatus("No Planks minted yet.");
        setItems([]);
        itemsCountRef.current = 0;
        knownIdsRef.current.clear();
        loadingIdsRef.current.clear();
        setLoadedCount(0);
        return;
      }

      // If we previously aborted before painting, recover by re-staging.
      if (itemsCountRef.current === 0 && knownIdsRef.current.size > 0) {
        knownIdsRef.current.clear();
        loadingIdsRef.current.clear();
        setLoadedCount(0);
      }

      // Newest first: supply … 1
      const allIds: number[] = [];
      for (let id = supply; id >= 1; id -= 1) allIds.push(id);

      const newIds = allIds.filter((id) => !knownIdsRef.current.has(id));

      if (newIds.length) {
        // Stage newest immediately so the grid never looks empty
        const stageNow = newIds.slice(0, Math.max(INITIAL_STAGE, PAGE_SIZE));
        const stageLater = newIds.slice(stageNow.length);

        for (const id of stageNow) knownIdsRef.current.add(id);
        upsertItems(stageNow.map(makePlaceholder));
        setStatus(`Loading ${supply.toLocaleString()} minted Planks…`);
        setLivePulse(true);
        window.setTimeout(() => setLivePulse(false), 900);

        // Hydrate visible/newest first
        await loadMetadataForIds(stageNow, contract, gen);
        if (syncGenRef.current !== gen) return;

        // Stage + hydrate the rest in the background
        if (stageLater.length) {
          for (const id of stageLater) knownIdsRef.current.add(id);
          upsertItems(stageLater.map(makePlaceholder));
          void loadMetadataForIds(stageLater, contract, gen);
        }
      } else if (itemsCountRef.current === 0) {
        // known set drifted without paint — hard reset
        knownIdsRef.current.clear();
        loadingIdsRef.current.clear();
        setLoadedCount(0);
        const stageNow = allIds.slice(0, INITIAL_STAGE);
        for (const id of stageNow) knownIdsRef.current.add(id);
        upsertItems(stageNow.map(makePlaceholder));
        await loadMetadataForIds(stageNow, contract, gen);
        if (syncGenRef.current !== gen) return;
        const rest = allIds.slice(INITIAL_STAGE);
        if (rest.length) {
          for (const id of rest) knownIdsRef.current.add(id);
          upsertItems(rest.map(makePlaceholder));
          void loadMetadataForIds(rest, contract, gen);
        }
      }

      if (syncGenRef.current === gen) {
        setStatus(
          `Live gallery · ${supply.toLocaleString()} minted · newest top-left`,
        );
      }
    } catch (error) {
      if (syncGenRef.current !== gen) return;
      const message =
        error instanceof Error ? error.message : "Unable to sync gallery.";
      setStatus(`Gallery sync issue: ${message}`);
      // Allow retry to re-stage everything
      knownIdsRef.current.clear();
      loadingIdsRef.current.clear();
    }
  }, [loadMetadataForIds, makePlaceholder, upsertItems]);

  useEffect(() => {
    void syncMinted();
    const timer = window.setInterval(() => void syncMinted(), POLL_MS);
    return () => {
      // Invalidate in-flight work without permanently blocking the next mount
      syncGenRef.current += 1;
      window.clearInterval(timer);
    };
  }, [syncMinted]);

  // Reset pagination when query changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query]);

  const rarity = useMemo(() => computeRaritySnapshot(items), [items]);

  const filtered = useMemo(() => {
    const q = query.trim();
    let list = items;
    if (q) {
      list = items.filter((item) =>
        matchesGalleryQuery(
          q,
          item.searchText || "",
          item.searchWords || [],
          item.owner || "",
        ),
      );
    }

    if (sortMode === "rarest") {
      return [...list].sort((a, b) => {
        const ra = rarity.byTokenId.get(a.tokenId);
        const rb = rarity.byTokenId.get(b.tokenId);
        if (ra && rb) return ra.rank - rb.rank || b.tokenId - a.tokenId;
        if (ra) return -1;
        if (rb) return 1;
        return b.tokenId - a.tokenId;
      });
    }

    return [...list].sort(sortNewestFirst);
  }, [items, query, sortMode, rarity]);

  const visible = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );

  const remaining = Math.max(0, filtered.length - visibleCount);
  const progress =
    totalMinted === 0 ? 0 : Math.min(100, Math.round((loadedCount / totalMinted) * 100));
  const searchActive = query.trim().length > 0;
  const metadataStillLoading = totalMinted > 0 && loadedCount < totalMinted;
  const selectedRarity = selected
    ? rarity.byTokenId.get(selected.tokenId)
    : undefined;

  function onSearchSubmit(event: FormEvent) {
    event.preventDefault();
  }

  function onSearchChange(value: string) {
    setQuery(value);
    setVisibleCount(PAGE_SIZE);
  }

  function openToken(tokenId: number) {
    const nft = items.find((item) => item.tokenId === tokenId);
    if (nft) {
      setPanel("gallery");
      setSelected(nft);
    }
  }

  return (
    <section id="gallery" className="scroll-mt-20 px-3 py-10 sm:px-5 sm:py-12">
      <div className="mx-auto max-w-6xl">
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
              Minted art, live scores, and trait analytics — densest view on any screen.
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {(
              [
                ["gallery", "Grid"],
                ["insights", "Insights"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setPanel(id)}
                className={`min-h-10 rounded-lg px-4 py-2 text-sm font-extrabold ${
                  panel === id
                    ? "bg-gold-500 text-wood-950"
                    : "border border-gold-500/40 text-gold-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="wood-frame overflow-hidden rounded-xl bg-wood-900/95">
          {/* Compact toolbar */}
          <div className="border-b border-gold-500/20 p-3 sm:p-3.5">
            <form
              onSubmit={onSearchSubmit}
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
              role="search"
            >
              <label htmlFor="gallery-search" className="sr-only">
                Search gallery
              </label>
              <input
                id="gallery-search"
                type="search"
                value={query}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Filter: holo, rare, 0x…, vanity, #id"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="search"
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-gold-500/45 bg-wood-950 px-3 py-2.5 text-sm font-bold text-foreground outline-none placeholder:text-foreground/40 focus:border-gold-300 sm:text-base"
              />
              <div className="flex gap-1.5">
                {(
                  [
                    ["newest", "Newest"],
                    ["rarest", "Rarest"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setSortMode(id);
                      setVisibleCount(PAGE_SIZE);
                      setPanel("gallery");
                    }}
                    className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-extrabold sm:flex-none sm:text-sm ${
                      sortMode === id
                        ? "bg-gold-500 text-wood-950"
                        : "border border-gold-500/40 text-gold-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                {query && (
                  <button
                    type="button"
                    onClick={() => onSearchChange("")}
                    className="min-h-11 rounded-lg border border-gold-500/40 px-3 py-2 text-xs font-extrabold text-gold-300 sm:text-sm"
                  >
                    Clear
                  </button>
                )}
              </div>
            </form>

            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-foreground/60 sm:text-sm">
              <p role="status" aria-live="polite" className="min-w-0">
                {searchActive
                  ? `${filtered.length.toLocaleString()} match${
                      filtered.length === 1 ? "" : "es"
                    }${metadataStillLoading ? ` · indexing ${progress}%` : ""}`
                  : status}
              </p>
              <div className="flex flex-wrap items-center gap-2 font-bold">
                <span className="rounded-full border border-gold-500/30 px-2 py-0.5 text-gold-300">
                  {totalMinted.toLocaleString()} minted
                </span>
                <span className="rounded-full border border-gold-500/30 px-2 py-0.5 text-gold-300">
                  {rarity.scoredCount.toLocaleString()} scored
                </span>
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
              <RarityInsights items={items} onSelectToken={openToken} />
            </div>
          ) : (
            <>
              <div className="max-h-[min(70dvh,760px)] overflow-y-auto overscroll-contain p-2 sm:p-3">
                {totalMinted === 0 && (
                  <p className="py-12 text-center text-sm text-foreground/60">
                    Waiting for the first mint…
                  </p>
                )}

                {totalMinted > 0 && filtered.length === 0 && (
                  <p className="py-12 text-center text-sm text-foreground/60">
                    {searchActive && metadataStillLoading
                      ? `No matches yet — indexing ${progress}%.`
                      : `No matches for “${query.trim()}”.`}
                  </p>
                )}

                {visible.length > 0 && (
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5 md:grid-cols-4 lg:grid-cols-5">
                    {visible.map((nft, index) => {
                      const tokenRarity = rarity.byTokenId.get(nft.tokenId);
                      return (
                        <li
                          key={nft.tokenId}
                          className="[content-visibility:auto] [contain-intrinsic-size:auto_200px]"
                        >
                          <button
                            type="button"
                            onClick={() => setSelected(nft)}
                            className="group flex h-full w-full flex-col overflow-hidden rounded-lg border border-gold-500/25 bg-wood-950/70 text-left transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
                            aria-label={`Open ${nft.name}`}
                          >
                            <div className="relative aspect-square w-full overflow-hidden bg-wood-950">
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
                            <div className="space-y-0.5 p-2">
                              <p className="line-clamp-1 text-xs font-black text-foreground sm:text-sm">
                                {nft.name.replace(/^RobinWood Plank\s*/i, "") || nft.name}
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
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {filtered.length > PAGE_SIZE && (
                <div className="flex flex-col gap-2 border-t border-gold-500/20 bg-black/25 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
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
                          className="min-h-10 rounded-lg bg-gold-500 px-3 py-2 text-xs font-extrabold text-wood-950 sm:text-sm"
                        >
                          +{Math.min(PAGE_SIZE, remaining)} more
                        </button>
                        <button
                          type="button"
                          onClick={() => setVisibleCount(filtered.length)}
                          className="min-h-10 rounded-lg border border-gold-500/40 px-3 py-2 text-xs font-extrabold text-gold-300 sm:text-sm"
                        >
                          All
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setVisibleCount(PAGE_SIZE)}
                        className="min-h-10 rounded-lg border border-gold-500/40 px-3 py-2 text-xs font-extrabold text-gold-300 sm:col-span-2 sm:text-sm"
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
          nft={selected}
          rarity={selectedRarity}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
