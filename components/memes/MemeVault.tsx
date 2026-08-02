"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X, ExternalLink } from "lucide-react";
import { SkeletonBlock, SkeletonStatus } from "@/components/Skeleton";
import MemeSubmit from "@/components/memes/MemeSubmit";

/**
 * Community Meme Vault feed for the RobinWood project.
 *
 * Reads through /api/memes (never the upstream directly) so the key stays
 * server-side and our visitors share one cached, rate-limited budget instead
 * of each browser spending its own — see that route's header.
 *
 * Attribution is flagged `required: true` by the upstream API and is rendered
 * unconditionally below the feed. It is built from the `text`/`url` fields
 * rather than injecting their `html`: the requirement is that credit appears,
 * not that we hand a third party an HTML injection point into our page.
 */

type MemeAsset = {
  id: string;
  title?: string;
  project?: string;
  tags?: string[];
  creatorName?: string;
  mediaType?: "image" | "video" | string;
  mimeType?: string;
  createdAt?: string;
  description?: string;
  sourceUrl?: string;
  mediaUrl?: string;
  downloadUrl?: string;
  /** The asset's own page upstream. */
  url?: string;
  /** The project's page upstream. */
  projectUrl?: string;
  /** Removed upstream in favour of `url` — kept so an older response, or a
   *  cached one written before the change, still resolves. */
  pageUrl?: string;
};

/**
 * Where a card should send you: the meme's own detail page first.
 *
 * `pageUrl` was removed upstream and replaced by `url`, so the old
 * `pageUrl || mediaUrl` chain silently degraded to linking the raw media
 * file — a bare image with no title, creator or context. Falling all the way
 * back to the media URL is still better than a dead link, but it is the last
 * resort, not the default it had quietly become.
 */
const detailHref = (a: MemeAsset): string | null =>
  a.url || a.pageUrl || a.projectUrl || a.mediaUrl || null;

type Attribution = { text?: string; url?: string; required?: boolean } | null;
/**
 * "gif" is OURS, not theirs. The upstream `type` param only accepts
 * image|video, so a GIF arrives as an image and was invisible as a category —
 * which is what "GIF is not there" meant. We ask for images and narrow on
 * mimeType client-side; `upstreamType` is the bit the API actually sees.
 */
type TypeFilter = "all" | "image" | "gif" | "video";

const TYPES: Array<{ id: TypeFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "gif", label: "GIFs" },
  { id: "video", label: "Video" },
];

/**
 * Which `type` to ask upstream for. GIF asks for NOTHING on purpose.
 *
 * Measured against the live API: unfiltered returns 7 assets including one
 * image/gif, while `type=image` returns 6 and excludes it — so upstream does
 * not classify a GIF as an image. Asking for `type=image` and then narrowing
 * to GIFs, which is what this did, could only ever return zero. GIFs are
 * therefore selected from the unfiltered feed.
 */
const upstreamType = (t: TypeFilter): "image" | "video" | null =>
  t === "video" ? "video" : t === "image" ? "image" : null;

const isGif = (a: MemeAsset) =>
  a.mimeType === "image/gif" || /\.gif($|\?)/i.test(a.mediaUrl ?? "");

/** Short format badge from the mime type — PNG, GIF, MP4. */
function formatLabel(a: MemeAsset): string | null {
  const sub = (a.mimeType ?? "").split("/")[1];
  return sub ? sub.replace("quicktime", "mov").toUpperCase() : null;
}

export default function MemeVault() {
  const [assets, setAssets] = useState<MemeAsset[] | null>(null);
  const [attribution, setAttribution] = useState<Attribution>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [type, setType] = useState<TypeFilter>("all");
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const reqRef = useRef(0);

  const load = useCallback(
    async (nextPage: number, nextType: TypeFilter, nextQuery: string, append: boolean) => {
      const token = ++reqRef.current;
      if (append) setLoadingMore(true);
      else setAssets(null);
      setError(null);
      try {
        const qs = new URLSearchParams({ page: String(nextPage) });
        const upstream = upstreamType(nextType);
        if (upstream) qs.set("type", upstream);
        if (nextQuery) qs.set("q", nextQuery);
        const res = await fetch(`/api/memes?${qs.toString()}`, { cache: "no-store" });
        const data = (await res.json()) as {
          assets?: MemeAsset[];
          hasMore?: boolean;
          attribution?: Attribution;
          message?: string;
        };
        // A late response from an abandoned filter must never overwrite the
        // current one — the user has already moved on.
        if (token !== reqRef.current) return;
        if (!res.ok) {
          setError(data.message || "Could not load the meme vault.");
          if (!append) setAssets([]);
          return;
        }
        // GIF is a client-side narrowing of the image feed, so a page can
        // legitimately yield none while more pages still hold some — that is
        // why "Load more" stays available on `hasMore`, not on row count.
        const all = Array.isArray(data.assets) ? data.assets : [];
        const rows = nextType === "gif" ? all.filter(isGif) : all;
        setAssets((prev) => (append && prev ? [...prev, ...rows] : rows));
        setHasMore(Boolean(data.hasMore));
        if (data.attribution) setAttribution(data.attribution);
      } catch {
        if (token !== reqRef.current) return;
        setError("Could not reach the meme vault.");
        if (!append) setAssets([]);
      } finally {
        if (token === reqRef.current) setLoadingMore(false);
      }
    },
    []
  );

  // Page is reset by the controls that change the result set, not here — a
  // setState in the effect body would cascade an extra render for a value the
  // handler already knows.
  useEffect(() => {
    // Fetch-on-mount from an external system — the standard suppression used
    // for this pattern elsewhere (see contentDocCard.tsx). `load` sets state
    // synchronously to clear the grid before the request, which is the point:
    // the previous filter's results must not sit under the new one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(1, type, applied, false);
  }, [load, type, applied]);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setApplied(query.trim());
    setPage(1);
  };

  const showing = assets ?? [];

  return (
    <section className="mx-auto w-full max-w-6xl px-3 py-6 sm:px-4 sm:py-8">
      <div className="mb-4 sm:mb-5">
        <p className="text-[0.7rem] font-extrabold uppercase tracking-[0.18em] text-gold-300">
          Community meme vault
        </p>
        <h1 className="font-display text-3xl text-gold-300 sm:text-4xl">Memes</h1>
        <p className="mt-1 max-w-xl text-sm text-foreground/65 sm:text-base">
          Plank art, memes and clips made by the community. Moderated upstream —
          everything here is already approved.
        </p>
        <button
          type="button"
          onClick={() => setSubmitOpen((v) => !v)}
          className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-gold-500 px-4 text-sm font-bold text-wood-950 transition hover:bg-gold-400"
        >
          {submitOpen ? "Close" : "Submit a meme"}
        </button>
      </div>

      {submitOpen && (
        <div className="mb-4">
          <MemeSubmit onClose={() => setSubmitOpen(false)} />
        </div>
      )}

      <div data-market-shell className="overflow-hidden rounded-xl border border-line bg-panel shadow-panel">
        <div className="border-b border-line p-3 sm:p-3.5">
          <form onSubmit={onSearch} className="flex flex-col gap-2 sm:flex-row sm:items-center" role="search">
            <label htmlFor="meme-search" className="sr-only">
              Search memes
            </label>
            <div className="relative min-w-0 flex-1">
              <Search
                size={14}
                strokeWidth={2.5}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground/40"
              />
              <input
                id="meme-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search titles, tags, creators"
                className="min-h-11 w-full rounded-lg border border-line-strong bg-wood-950 pl-9 pr-3 text-sm text-cream placeholder:text-foreground/40"
              />
            </div>
            <div className="flex gap-1.5">
              {TYPES.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setType(id);
                    setPage(1);
                  }}
                  className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-bold sm:flex-none sm:text-sm ${
                    type === id
                      ? "bg-gold-500 text-wood-950"
                      : "border border-line-strong text-gold-300 hover:border-gold-400"
                  }`}
                >
                  {label}
                </button>
              ))}
              {applied && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setApplied("");
                    setPage(1);
                  }}
                  className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-line-strong px-3 py-2 text-xs font-bold text-gold-300 sm:text-sm"
                >
                  <X size={12} strokeWidth={2.5} />
                  Clear
                </button>
              )}
            </div>
          </form>
          {applied && (
            <p className="mt-2 text-xs text-foreground/60">
              Showing matches for “{applied}”.
            </p>
          )}
        </div>

        <div className="p-2 sm:p-3">
          {error && (
            <p role="alert" className="mb-3 rounded-lg border border-rose-400/30 bg-panel-strong px-3 py-2 text-sm text-rose-400">
              {error}
            </p>
          )}

          {assets === null ? (
            <>
              <SkeletonStatus>Loading community memes</SkeletonStatus>
              <ul className="columns-2 gap-2 sm:columns-3 sm:gap-2.5 lg:columns-4" aria-hidden="true">
                {/* Varied heights on purpose: a masonry wall of identical
                    tiles resolves into a ragged one, which is the layout jump
                    the skeleton exists to prevent. */}
                {[220, 300, 180, 260, 340, 200, 280, 240, 320, 190, 270, 230].map((h, i) => (
                  <li key={i} className="dense-card mb-2 overflow-hidden p-0 sm:mb-2.5 [break-inside:avoid]">
                    <div
                      style={{ height: h }}
                      className="w-full animate-pulse bg-panel motion-reduce:animate-none"
                    />
                    <div className="space-y-1.5 p-2">
                      <SkeletonBlock className="h-3 w-2/3" />
                      <SkeletonBlock className="h-2.5 w-1/3" />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : showing.length === 0 ? (
            // Distinguish "nothing matched your filters" from "the vault is
            // empty" — the two look identical otherwise and the first reads
            // as a broken page.
            <p className="py-12 text-center text-sm text-foreground/60">
              {applied || type !== "all"
                ? type === "gif"
                ? "No GIFs on this page yet — try Load more, or clear the filters."
                : "No memes match that. Try clearing the filters."
                : "No memes in the vault yet."}
            </p>
          ) : (
            // Masonry via CSS columns. These are arbitrary user uploads, so a
            // fixed square cropped every tall or wide meme — the punchline of
            // a screenshot is often exactly what got cut. Trade-off accepted:
            // columns flow top-to-bottom per column rather than left-to-right,
            // so reading order is column-major. For a browse-y wall of memes
            // that is fine; it would not be for a ranked list.
            <ul className="columns-2 gap-2 sm:columns-3 sm:gap-2.5 lg:columns-4">
              {showing.map((a) => (
                <li
                  key={a.id}
                  className="dense-card mb-2 block overflow-hidden p-0 sm:mb-2.5 [break-inside:avoid]"
                >
                  <a
                    href={detailHref(a) ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group block"
                    title={a.description || a.title || undefined}
                  >
                    <div className="relative w-full overflow-hidden bg-wood-950">
                      {a.mediaType === "video" ? (
                        <video
                          src={a.mediaUrl}
                          muted
                          loop
                          playsInline
                          preload="metadata"
                          className="block h-auto w-full"
                          onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
                          onMouseLeave={(e) => {
                            e.currentTarget.pause();
                            e.currentTarget.currentTime = 0;
                          }}
                        />
                      ) : (
                        // Deliberately a plain <img>: these are arbitrary
                        // third-party URLs, and routing them through next/image
                        // would need the upstream host in remotePatterns and
                        // would proxy every asset through our server.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={a.mediaUrl}
                          alt={a.title || "Community meme"}
                          loading="lazy"
                          className="block h-auto w-full transition group-hover:opacity-95"
                        />
                      )}
                      {/* Format, not category: "Video" told you nothing a
                          playing clip did not, and hid GIF entirely. */}
                      {formatLabel(a) && (
                        <span className="absolute right-1.5 top-1.5 rounded-full border border-line bg-wood-950/80 px-1.5 py-0.5 text-[0.55rem] font-bold uppercase text-gold-300">
                          {formatLabel(a)}
                        </span>
                      )}
                    </div>
                    <div className="space-y-0.5 p-2">
                      <p className="truncate text-xs font-bold text-cream">
                        {a.title || "Untitled"}
                      </p>
                      <p className="flex items-center gap-1 truncate text-[0.68rem] text-foreground/60">
                        {a.creatorName ? <span className="truncate">by {a.creatorName}</span> : null}
                        {/* Says the card opens a PAGE, not the raw file. The
                            distinction matters now that these link to the
                            asset's own detail page upstream. */}
                        <ExternalLink
                          size={10}
                          strokeWidth={2.5}
                          aria-hidden="true"
                          className="ml-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-70"
                        />
                      </p>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        {hasMore && assets !== null && showing.length > 0 && (
          <div className="border-t border-line bg-panel-strong px-3 py-2.5 text-center sm:px-4">
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => {
                const next = page + 1;
                setPage(next);
                void load(next, type, applied, true);
              }}
              className="min-h-11 rounded-lg bg-gold-500 px-4 py-2 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-60"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>

      {/* Required by the upstream API (`attribution.required: true`). Rendered
          from text/url rather than their raw HTML — the obligation is that
          credit appears, not that a third party gets to inject markup here. */}
      <p className="mt-3 text-center text-xs text-foreground/55">
        {attribution?.url ? (
          <a
            href={attribution.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-gold-300"
          >
            {attribution.text || "Community Meme Vault"}
            <ExternalLink size={11} strokeWidth={2.5} aria-hidden="true" />
          </a>
        ) : (
          <a
            href="https://memes.smoothbrain.app"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-gold-300"
          >
            Community Meme Vault
            <ExternalLink size={11} strokeWidth={2.5} aria-hidden="true" />
          </a>
        )}
      </p>
    </section>
  );
}
