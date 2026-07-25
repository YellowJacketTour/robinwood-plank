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
import { Contract, JsonRpcProvider } from "ethers";
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
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_RPC_URL,
} from "@/lib/mint-contract";

export type GalleryNft = {
  tokenId: number;
  tokenUri: string;
  name: string;
  description: string;
  imageUri: string;
  attributes: NftAttribute[];
  owner: string;
  searchText: string;
  searchWords: string[];
  loaded: boolean;
  error?: string;
};

const POLL_MS = 20_000;
const URI_BATCH = 24;
const META_CONCURRENCY = 10;
const PAGE_SIZE = 24;

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
  onClose,
}: {
  nft: GalleryNft;
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
              <dl className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                <div className="rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2.5">
                  <dt className="uppercase tracking-wide text-foreground/55">Token ID</dt>
                  <dd className="mt-1 font-mono">#{nft.tokenId}</dd>
                </div>
                <div className="min-w-0 rounded-lg border border-gold-500/20 bg-black/20 px-3 py-2.5">
                  <dt className="uppercase tracking-wide text-foreground/55">Owner</dt>
                  <dd className="mt-1 break-all font-mono text-sm" title={nft.owner || undefined}>
                    {nft.owner ? shortOwner(nft.owner) : "—"}
                  </dd>
                </div>
              </dl>
              {nft.owner && (
                <p className="break-all font-mono text-xs text-foreground/50">{nft.owner}</p>
              )}
              {nft.description && (
                <p className="text-sm leading-relaxed text-foreground/80">{nft.description}</p>
              )}
              {nft.attributes.length > 0 && (
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

  const knownIdsRef = useRef<Set<number>>(new Set());
  const loadingIdsRef = useRef<Set<number>>(new Set());
  const cancelledRef = useRef(false);

  const upsertItems = useCallback((incoming: GalleryNft[]) => {
    setItems((previous) => {
      const map = new Map(previous.map((item) => [item.tokenId, item]));
      for (const item of incoming) {
        map.set(item.tokenId, item);
      }
      return Array.from(map.values()).sort(sortNewestFirst);
    });
  }, []);

  const loadMetadataForIds = useCallback(
    async (tokenIds: number[], contract: Contract) => {
      const pending = tokenIds.filter(
        (id) => !loadingIdsRef.current.has(id),
      );
      if (!pending.length) return;

      for (const id of pending) loadingIdsRef.current.add(id);

      // Newest first within this batch set
      const ordered = [...pending].sort((a, b) => b - a);

      for (let offset = 0; offset < ordered.length; offset += URI_BATCH) {
        if (cancelledRef.current) return;
        const slice = ordered.slice(offset, offset + URI_BATCH);

        const withChain = await Promise.all(
          slice.map(async (tokenId) => {
            const [uriResult, ownerResult] = await Promise.allSettled([
              contract.tokenURI(tokenId) as Promise<string>,
              contract.ownerOf(tokenId) as Promise<string>,
            ]);
            return {
              tokenId,
              tokenUri: uriResult.status === "fulfilled" ? uriResult.value : "",
              owner: ownerResult.status === "fulfilled" ? ownerResult.value : "",
            };
          }),
        );

        // Metadata with limited concurrency
        for (let i = 0; i < withChain.length; i += META_CONCURRENCY) {
          if (cancelledRef.current) return;
          const chunk = withChain.slice(i, i + META_CONCURRENCY);
          const resolved = await Promise.all(
            chunk.map(async (entry) => {
              const fallbackName = `RobinWood Plank #${entry.tokenId}`;
              const owner = entry.owner || "";
              if (!entry.tokenUri) {
                const idx = indexNft({
                  tokenId: entry.tokenId,
                  name: fallbackName,
                  owner,
                });
                return {
                  tokenId: entry.tokenId,
                  tokenUri: "",
                  name: fallbackName,
                  description: "",
                  imageUri: "",
                  attributes: [] as NftAttribute[],
                  owner,
                  searchText: idx.searchText,
                  searchWords: idx.words,
                  loaded: true,
                  error: "tokenURI unavailable",
                } satisfies GalleryNft;
              }
              try {
                const metadata: NftMetadata = await fetchNftMetadata(entry.tokenUri);
                const name = metadata.name?.trim() || fallbackName;
                const description = metadata.description?.trim() || "";
                const attributes = Array.isArray(metadata.attributes)
                  ? metadata.attributes
                  : [];
                const idx = indexNft({
                  tokenId: entry.tokenId,
                  name,
                  description,
                  attributes,
                  owner,
                });
                return {
                  tokenId: entry.tokenId,
                  tokenUri: entry.tokenUri,
                  name,
                  description,
                  imageUri: metadata.image || "",
                  attributes,
                  owner,
                  searchText: idx.searchText,
                  searchWords: idx.words,
                  loaded: true,
                } satisfies GalleryNft;
              } catch {
                const idx = indexNft({
                  tokenId: entry.tokenId,
                  name: fallbackName,
                  owner,
                });
                return {
                  tokenId: entry.tokenId,
                  tokenUri: entry.tokenUri,
                  name: fallbackName,
                  description: "",
                  imageUri: "",
                  attributes: [],
                  owner,
                  searchText: idx.searchText,
                  searchWords: idx.words,
                  loaded: true,
                  error: "metadata unavailable",
                } satisfies GalleryNft;
              }
            }),
          );

          if (cancelledRef.current) return;
          upsertItems(resolved);
          setLoadedCount((count) => count + resolved.length);
        }
      }
    },
    [upsertItems],
  );

  const syncMinted = useCallback(async () => {
    try {
      const provider = new JsonRpcProvider(ROBINHOOD_RPC_URL, ROBINHOOD_CHAIN_ID, {
        staticNetwork: true,
      });
      const contract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, provider);
      const supply = Number(await contract.totalSupply());
      setTotalMinted(supply);

      if (supply === 0) {
        setStatus("No Planks minted yet.");
        setItems([]);
        knownIdsRef.current.clear();
        setLoadedCount(0);
        return;
      }

      // Sequential mint IDs 1..supply — only revealed/minted tokens
      const allIds: number[] = [];
      for (let id = supply; id >= 1; id -= 1) {
        allIds.push(id);
      }

      const newIds = allIds.filter((id) => !knownIdsRef.current.has(id));
      for (const id of allIds) knownIdsRef.current.add(id);

      // Placeholder cards so newest mints appear immediately (top-left)
      if (newIds.length) {
        const placeholders = newIds.map((tokenId) => {
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
          } satisfies GalleryNft;
        });
        upsertItems(placeholders);
        setStatus(
          newIds.length === allIds.length
            ? `Loading ${supply} minted Planks…`
            : `${newIds.length} new mint${newIds.length === 1 ? "" : "s"} — updating gallery…`,
        );
        setLivePulse(true);
        window.setTimeout(() => setLivePulse(false), 1200);
        await loadMetadataForIds(newIds, contract);
      }

      setStatus(
        `Live gallery · ${supply.toLocaleString()} minted · newest top-left`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to sync gallery.";
      setStatus(`Gallery sync issue: ${message}`);
    }
  }, [loadMetadataForIds, upsertItems]);

  useEffect(() => {
    cancelledRef.current = false;
    void syncMinted();
    const timer = window.setInterval(() => void syncMinted(), POLL_MS);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(timer);
    };
  }, [syncMinted]);

  // Reset pagination when query changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return items;
    return items.filter((item) =>
      matchesGalleryQuery(
        q,
        item.searchText || "",
        item.searchWords || [],
        item.owner || "",
      ),
    );
  }, [items, query]);

  const visible = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );

  const remaining = Math.max(0, filtered.length - visibleCount);
  const progress =
    totalMinted === 0 ? 0 : Math.min(100, Math.round((loadedCount / totalMinted) * 100));
  const searchActive = query.trim().length > 0;
  const metadataStillLoading = totalMinted > 0 && loadedCount < totalMinted;

  function onSearchSubmit(event: FormEvent) {
    event.preventDefault();
  }

  function onSearchChange(value: string) {
    setQuery(value);
    setVisibleCount(PAGE_SIZE);
  }

  return (
    <section id="gallery" className="scroll-mt-24 px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <div className="flex flex-col items-center text-center">
            <p className="text-xs font-extrabold uppercase tracking-[0.22em] text-gold-300">
              <span
                className={`mr-2 inline-block h-2 w-2 rounded-full bg-emerald-400 ${
                  livePulse ? "animate-ping" : "animate-pulse"
                }`}
                aria-hidden="true"
              />
              Live · Auto-updating
            </p>
            <h2 className="section-title mt-2 text-4xl text-gold-300 sm:text-5xl">Gallery</h2>
            <p className="lede mx-auto mt-3 max-w-2xl text-foreground/70">
              Every revealed RobinWood Plank — minted art only. Latest mint first (top left).
            </p>
          </div>
        </Reveal>

        <Reveal delayMs={100}>
          <div className="wood-frame mx-auto mt-10 overflow-hidden rounded-2xl bg-wood-900/95">
            {/* Toolbar */}
            <div className="border-b border-gold-500/20 p-4 sm:p-5">
              <form
                onSubmit={onSearchSubmit}
                className="flex flex-col gap-3 sm:flex-row sm:items-center"
                role="search"
              >
                <label htmlFor="gallery-search" className="sr-only">
                  Search names and traits
                </label>
                <input
                  id="gallery-search"
                  type="search"
                  value={query}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="Search: holo, rare, 0xabc…, vanity hex, #42…"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="search"
                  className="min-h-12 min-w-0 flex-1 rounded-lg border-2 border-gold-500/50 bg-wood-950 px-4 py-3 text-base font-bold text-foreground outline-none placeholder:text-foreground/40 focus:border-gold-300"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => onSearchChange("")}
                    className="min-h-12 rounded-lg border border-gold-500/40 px-5 py-3 font-extrabold text-gold-300 sm:shrink-0"
                  >
                    Clear
                  </button>
                )}
              </form>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-foreground/65">
                <p role="status" aria-live="polite">
                  {searchActive
                    ? metadataStillLoading
                      ? `${filtered.length.toLocaleString()} match${
                          filtered.length === 1 ? "" : "es"
                        } for “${query.trim()}” · indexing traits ${progress}%…`
                      : `${filtered.length.toLocaleString()} match${
                          filtered.length === 1 ? "" : "es"
                        } for “${query.trim()}”`
                    : status}
                </p>
                <div className="flex flex-wrap items-center gap-3 font-bold">
                  <span className="rounded-full border border-gold-500/30 px-2.5 py-1 text-gold-300">
                    {totalMinted.toLocaleString()} minted
                  </span>
                  {searchActive && (
                    <span className="rounded-full border border-emerald-400/40 px-2.5 py-1 text-emerald-300">
                      {filtered.length.toLocaleString()} shown
                    </span>
                  )}
                  {metadataStillLoading && (
                    <span className="text-foreground/50">Art {progress}%</span>
                  )}
                </div>
              </div>

              {totalMinted > 0 && loadedCount < totalMinted && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/35">
                  <div
                    className="h-full rounded-full bg-gold-500 transition-[width] duration-500"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
            </div>

            {/* Grid — newest (highest token id) top-left */}
            <div className="max-h-[min(72dvh,820px)] overflow-y-auto overscroll-contain p-3 sm:p-4">
              {totalMinted === 0 && (
                <p className="py-16 text-center text-foreground/60">
                  Waiting for the first mint…
                </p>
              )}

              {totalMinted > 0 && filtered.length === 0 && (
                <p className="py-16 text-center text-foreground/60">
                  {searchActive && metadataStillLoading
                    ? `No matches for “${query.trim()}” yet — still loading names & traits (${progress}%). Results appear as art indexes.`
                    : `No Planks match “${query.trim()}”. Try a partial trait (holo), base name, rarity, or #id.`}
                </p>
              )}

              {visible.length > 0 && (
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
                  {visible.map((nft, index) => (
                    <li
                      key={nft.tokenId}
                      className="[content-visibility:auto] [contain-intrinsic-size:auto_240px]"
                    >
                      <button
                        type="button"
                        onClick={() => setSelected(nft)}
                        className="group flex h-full w-full flex-col overflow-hidden rounded-xl border border-gold-500/30 bg-wood-950/70 text-left transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
                        aria-label={`Open ${nft.name}`}
                      >
                        <div className="relative aspect-square w-full overflow-hidden bg-wood-950">
                          {!nft.loaded && !nft.imageUri ? (
                            <div className="flex h-full w-full animate-pulse items-center justify-center bg-wood-950/80 text-2xl">
                              🪵
                            </div>
                          ) : (
                            <NftImage
                              imageUri={nft.imageUri}
                              alt=""
                              priority={index < 4}
                              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                            />
                          )}
                          <span className="absolute left-2 top-2 rounded-md bg-black/70 px-2 py-0.5 font-mono text-[0.7rem] font-bold text-gold-300">
                            #{nft.tokenId}
                          </span>
                        </div>
                        <div className="flex flex-1 flex-col gap-1 p-2.5 sm:p-3">
                          <p className="line-clamp-2 text-sm font-black leading-snug text-foreground sm:text-base">
                            {nft.name}
                          </p>
                          {nft.owner ? (
                            <p className="line-clamp-1 font-mono text-[0.7rem] text-foreground/50">
                              {shortOwner(nft.owner)}
                            </p>
                          ) : nft.attributes[0] ? (
                            <p className="line-clamp-1 text-xs text-foreground/55">
                              {nft.attributes[0].trait_type}: {String(nft.attributes[0].value)}
                            </p>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {filtered.length > PAGE_SIZE && (
              <div className="flex flex-col gap-2 border-t border-gold-500/20 bg-black/25 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <p className="text-sm text-foreground/65">
                  Showing {Math.min(visibleCount, filtered.length)} of{" "}
                  {filtered.length.toLocaleString()}
                  {query ? " matches" : " revealed Planks"}
                </p>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  {remaining > 0 ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setVisibleCount((count) =>
                            Math.min(filtered.length, count + PAGE_SIZE),
                          )
                        }
                        className="min-h-11 rounded-lg bg-gold-500 px-4 py-2 text-sm font-extrabold text-wood-950"
                      >
                        Show {Math.min(PAGE_SIZE, remaining)} more
                      </button>
                      <button
                        type="button"
                        onClick={() => setVisibleCount(filtered.length)}
                        className="min-h-11 rounded-lg border border-gold-500/40 px-4 py-2 text-sm font-extrabold text-gold-300"
                      >
                        Show all
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setVisibleCount(PAGE_SIZE)}
                      className="min-h-11 rounded-lg border border-gold-500/40 px-4 py-2 text-sm font-extrabold text-gold-300 sm:col-span-2"
                    >
                      Collapse
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </Reveal>
      </div>

      {selected && (
        <GalleryDetailModal nft={selected} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}
