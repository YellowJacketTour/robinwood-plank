"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  classifyTrackUrl,
  resolveTrackUrl,
  sanitizePlaylist,
  sunoAudioUrl,
  titleFromPost,
  type WoodAmpTrack,
} from "@/lib/woodamp-playlist";
import { adminMessage, adminPayloadHash } from "@/lib/admin-auth";
import { signMessage } from "@/lib/wallet";
import { importXTrack, uploadMediaFile, type XImportOutcome } from "../api";
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  CARD,
  INPUT,
  LABEL,
  NOTE_ERR,
  NOTE_MUTED,
  NOTE_OK,
} from "../ui";

const PLAYLIST_ACTION = "woodamp-playlist";

const SOURCE_LABELS: Record<WoodAmpTrack["source"], string> = {
  hosted: "hosted file",
  remote: "direct audio URL",
  "embed-youtube": "YouTube embed",
  "embed-soundcloud": "SoundCloud embed",
  external: "external link (won't play — opens on the platform)",
};

type SaveState =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "saving" }
  | { kind: "saved"; count: number }
  | { kind: "error"; message: string };

export default function MusicSection({ address }: { address: string | null }) {
  return (
    <>
      <PlaylistManager address={address} />
      <UploadsManager address={address} />
    </>
  );
}

// --- Planklist -------------------------------------------------------------

function PlaylistManager({ address }: { address: string | null }) {
  const [tracks, setTracks] = useState<WoodAmpTrack[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/music/playlist", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { tracks?: unknown };
      const parsed = sanitizePlaylist(data.tracks);
      if (!parsed.ok) throw new Error();
      setTracks(parsed.tracks);
      setDirty(false);
      setSave({ kind: "idle" });
      setLoadError(false);
    } catch {
      setTracks(null);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount from an external system — the same suppression as
    // WoodAmpProvider's stored-state hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const mutate = useCallback((fn: (prev: WoodAmpTrack[]) => WoodAmpTrack[]) => {
    setTracks((prev) => (prev ? fn(prev) : prev));
    setDirty(true);
    setSave({ kind: "idle" });
  }, []);

  const move = useCallback(
    (from: number, to: number) => {
      mutate((prev) => {
        if (to < 0 || to >= prev.length) return prev;
        const next = [...prev];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        return next;
      });
    },
    [mutate]
  );

  const edit = useCallback(
    (index: number, patch: Partial<WoodAmpTrack>) => {
      mutate((prev) =>
        prev.map((t, i) => (i === index ? { ...t, ...patch } : t))
      );
    },
    [mutate]
  );

  const remove = useCallback(
    (index: number) => {
      mutate((prev) => prev.filter((_, i) => i !== index));
    },
    [mutate]
  );

  const handleSave = useCallback(
    async (override?: WoodAmpTrack[]) => {
    const list = override ?? tracks;
    if (!list || !address) return;
    const parsed = sanitizePlaylist(list);
    if (!parsed.ok) {
      setSave({
        kind: "error",
        message:
          parsed.error.index >= 0
            ? `Track ${parsed.error.index + 1}: ${parsed.error.message}`
            : parsed.error.message,
      });
      return;
    }
    try {
      setSave({ kind: "signing" });
      // Sign exactly what the server will verify: the sanitized JSON.
      const payloadJson = JSON.stringify(parsed.tracks);
      const timestamp = Date.now();
      const signature = await signMessage(
        address,
        adminMessage(PLAYLIST_ACTION, timestamp, adminPayloadHash(payloadJson))
      );
      setSave({ kind: "saving" });
      const res = await fetch("/api/music/playlist", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: parsed.tracks,
          auth: { address, timestamp, signature },
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        count?: number;
        message?: string;
      };
      if (!res.ok || !data.ok) {
        setSave({
          kind: "error",
          message: data.message || "The server rejected the save.",
        });
        return;
      }
      setTracks(parsed.tracks);
      setDirty(false);
      setSave({ kind: "saved", count: data.count ?? parsed.tracks.length });
    } catch (err) {
      setSave({
        kind: "error",
        message: err instanceof Error ? err.message : "Save failed.",
      });
    }
    },
    [address, tracks]
  );

  /**
   * Adding a track is one action, not two. An imported track used to land in
   * an unsaved list, so the admin had to notice a second button and press it
   * before anything was live — easy to miss, and the work was already done.
   */
  const add = useCallback(
    (track: WoodAmpTrack) => {
      const next = tracks ? [...tracks, track] : [track];
      mutate(() => next);
      void handleSave(next);
    },
    [handleSave, mutate, tracks]
  );

  const busy = save.kind === "signing" || save.kind === "saving";

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-gold-300">Planklist</h2>
          <p className={`mt-1 ${LABEL}`}>WoodAmp community playlist</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={() => void load()}
            disabled={busy}
          >
            {dirty ? "Discard changes" : "Reload"}
          </button>
          <button
            type="button"
            className={BUTTON_PRIMARY}
            onClick={() => void handleSave()}
            disabled={!dirty || !address || busy || !tracks}
          >
            {save.kind === "signing"
              ? "Sign in wallet…"
              : save.kind === "saving"
                ? "Saving…"
                : "Sign & save"}
          </button>
        </div>
      </div>

      {save.kind === "error" ? <p className={NOTE_ERR}>{save.message}</p> : null}
      {save.kind === "saved" ? (
        <p className={NOTE_OK}>
          Saved — {save.count} track{save.count === 1 ? "" : "s"} live.
        </p>
      ) : null}
      {dirty && save.kind === "idle" ? (
        <p className={NOTE_MUTED}>
          Unsaved changes — nothing is live until you sign &amp; save.
        </p>
      ) : null}

      {loadError ? (
        <div className="mt-4 rounded-md bg-panel-strong p-3">
          <p className="text-sm text-rose-400">Could not load the playlist.</p>
          <button
            type="button"
            className={`${BUTTON_SECONDARY} mt-3`}
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {tracks === null && !loadError ? (
        <p className="mt-4 text-sm text-cream-muted">Loading…</p>
      ) : null}

      {tracks ? (
        <>
          <ol className="mt-4 space-y-3">
            {tracks.map((track, i) => (
              <TrackRow
                key={track.id}
                track={track}
                index={i}
                count={tracks.length}
                busy={busy}
                onEdit={edit}
                onMove={move}
                onRemove={remove}
              />
            ))}
          </ol>
          <AddTrackForm
            existing={tracks}
            onAdd={add}
            busy={busy}
            address={address}
          />
        </>
      ) : null}
    </section>
  );
}

function TrackRow({
  track,
  index,
  count,
  busy,
  onEdit,
  onMove,
  onRemove,
}: {
  track: WoodAmpTrack;
  index: number;
  count: number;
  busy: boolean;
  onEdit: (index: number, patch: Partial<WoodAmpTrack>) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <li className="rounded-md border border-line bg-panel-soft p-3">
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-2 w-8 text-right text-sm tabular-nums text-cream-muted">
          {index + 1}.
        </span>
        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>Title</span>
            <input
              className={`${INPUT} mt-1`}
              value={track.title}
              onChange={(e) => onEdit(index, { title: e.target.value })}
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className={LABEL}>Artist / credit</span>
            <input
              className={`${INPUT} mt-1`}
              value={track.artist}
              onChange={(e) => onEdit(index, { artist: e.target.value })}
              disabled={busy}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={LABEL}>URL (audio file, YouTube, SoundCloud, X)</span>
            <input
              className={`${INPUT} mt-1 font-mono text-xs`}
              value={track.src}
              onChange={(e) =>
                onEdit(index, {
                  src: e.target.value,
                  source: classifyTrackUrl(e.target.value) ?? track.source,
                })
              }
              disabled={busy}
              spellCheck={false}
            />
          </label>
          <p className={`${LABEL} sm:col-span-2`}>
            id: {track.id} · {SOURCE_LABELS[track.source]}
            {track.link ? (
              <>
                {" · credited to "}
                <a
                  href={track.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-dotted"
                >
                  {track.link.replace(/^https:\/\/(www\.)?/, "").slice(0, 48)}
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            aria-label={`Move ${track.title} up`}
            className={`${BUTTON_SECONDARY} w-11 px-0`}
            onClick={() => onMove(index, index - 1)}
            disabled={busy || index === 0}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${track.title} down`}
            className={`${BUTTON_SECONDARY} w-11 px-0`}
            onClick={() => onMove(index, index + 1)}
            disabled={busy || index === count - 1}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label={`Remove ${track.title}`}
            className={`${BUTTON_SECONDARY} w-11 px-0 text-rose-400`}
            onClick={() => onRemove(index)}
            disabled={busy || count === 1}
          >
            ✕
          </button>
        </div>
      </div>
    </li>
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** X/Twitter post — the audio is in a video player we cannot stream from. */
function isXLink(src: string): boolean {
  try {
    const host = new URL(src.trim()).hostname.toLowerCase().replace(/^www\./, "");
    return host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com";
  } catch {
    return false;
  }
}

function AddTrackForm({
  existing,
  onAdd,
  busy,
  address,
}: {
  existing: WoodAmpTrack[];
  onAdd: (track: WoodAmpTrack) => void;
  busy: boolean;
  address: string | null;
}) {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [src, setSrc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [looking, setLooking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Which URL we last auto-filled from, so re-editing the title doesn't get
  // clobbered and the same URL isn't looked up twice.
  const filledFor = useRef<string | null>(null);

  const existingIds = useMemo(
    () => new Set(existing.map((t) => t.id)),
    [existing]
  );

  const trimmed = src.trim();
  const classified = trimmed ? classifyTrackUrl(trimmed) : null;
  // X posts are the one case where the pasted URL can never become audio, so
  // the form asks for the file instead of quietly adding a link-out.
  const needsUpload = isXLink(trimmed);
  const suno = sunoAudioUrl(trimmed);

  // Ask the source what the track is called as soon as a URL is pasted.
  // Debounced because this fires per keystroke, and every lookup is an
  // outbound request on the server's behalf.
  useEffect(() => {
    if (!trimmed || filledFor.current === trimmed) return;
    const supported =
      needsUpload ||
      classified === "embed-youtube" ||
      classified === "embed-soundcloud" ||
      Boolean(suno);
    if (!supported) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLooking(true);
      try {
        const res = await fetch(
          `/api/music/track-meta?url=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal }
        );
        const data = (await res.json()) as {
          meta?: { title?: string; artist?: string } | null;
        };
        if (controller.signal.aborted) return;
        filledFor.current = trimmed;
        // Never overwrite something already typed — the admin's wording wins.
        if (data.meta?.title) setTitle((prev) => prev || data.meta!.title!);
        if (data.meta?.artist) setArtist((prev) => prev || data.meta!.artist!);
      } catch {
        // A failed lookup is not an error the admin needs to see; the fields
        // simply stay empty and typing still works.
      } finally {
        if (!controller.signal.aborted) setLooking(false);
      }
    }, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [classified, needsUpload, suno, trimmed]);

  const nextId = useCallback(
    (base: string) => {
      let id = base;
      let n = 2;
      while (existingIds.has(id)) id = `${base}-${n++}`.slice(0, 64);
      return id;
    },
    [existingIds]
  );

  const commit = useCallback(
    (track: WoodAmpTrack) => {
      const parsed = sanitizePlaylist([...existing, track]);
      if (!parsed.ok) {
        setError(parsed.error.message);
        return false;
      }
      onAdd(track);
      setTitle("");
      setArtist("");
      setSrc("");
      if (fileRef.current) fileRef.current.value = "";
      return true;
    },
    [existing, onAdd]
  );

  const handleAdd = useCallback(async () => {
    setError(null);

    if (needsUpload) {
      if (!address) {
        setError("Connect the admin wallet to import.");
        return;
      }
      const file = fileRef.current?.files?.[0];
      setUploading(true);
      // Rip the post's audio server-side. A file, if one was picked, is the
      // manual fallback for posts we can't resolve (private, deleted, or
      // audio that didn't come from X in the first place).
      const outcome = file
        ? await uploadMediaFile(file, address)
        : await importXTrack(trimmed, address);
      setUploading(false);
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      // A rip already knows the post's text and handle, so nothing has to be
      // typed in first — requiring a title up front meant going and reading
      // the post to supply what the import was about to fetch anyway. Typed
      // values still win; these are only the fallback.
      const post = file
        ? null
        : (outcome as XImportOutcome & { ok: true }).post;
      const derived = post ? titleFromPost(post.text, post.author) : "";
      const finalTitle = title.trim() || derived;
      if (!slugify(finalTitle)) {
        setError("Give the track a title — this post had no text to borrow.");
        return;
      }
      // We host the audio; the post stays attached as the credit.
      commit({
        id: nextId(slugify(finalTitle)),
        title: finalTitle,
        artist: artist.trim() || post?.author || "Plank Community Radio",
        src: outcome.upload.url,
        source: "hosted",
        link: trimmed,
      });
      return;
    }

    const baseId = slugify(title);
    if (!baseId) {
      setError("Give the track a title first.");
      return;
    }

    // Suno share pages are rewritten to their CDN audio here, so what gets
    // stored is what plays.
    const resolved = resolveTrackUrl(trimmed);
    const source = classifyTrackUrl(resolved);
    if (!source) {
      setError("Enter a valid URL (audio file, YouTube, SoundCloud, Suno, or X link).");
      return;
    }
    commit({
      id: nextId(baseId),
      title: title.trim(),
      artist: artist.trim() || "Plank Community Radio",
      src: resolved,
      source,
      ...(suno ? { link: trimmed } : {}),
    });
  }, [address, artist, commit, needsUpload, nextId, suno, title, trimmed]);

  const disabled = busy || uploading;

  return (
    <div className="mt-4 rounded-md border border-line bg-panel-soft p-3">
      <h3 className={LABEL}>Add a track</h3>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <input
          className={INPUT}
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={disabled}
        />
        <input
          className={INPUT}
          placeholder="Artist / community credit"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          disabled={disabled}
        />
        <input
          className={`${INPUT} font-mono text-xs sm:col-span-2`}
          placeholder="/audio/track.mp3, https://…/track.mp3, YouTube/SoundCloud/Suno/X link"
          value={src}
          onChange={(e) => setSrc(e.target.value)}
          disabled={disabled}
          spellCheck={false}
        />
      </div>

      {needsUpload ? (
        <div className="mt-3 rounded-md border border-gold-500/30 bg-panel-strong p-3">
          <p className={LABEL}>X post — audio will be ripped and hosted</p>
          <p className="mt-1 text-xs text-cream-muted">
            The post&apos;s audio is pulled once and served from here, so it
            streams in WoodAmp instead of bouncing to x.com, with the post kept
            as the credit. Title and artist are taken from the post — fill them
            in above only to override. Leave the file picker empty unless the
            rip fails: private and deleted posts can&apos;t be read, and then
            you can supply the audio yourself.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".mp3,.m4a,.ogg,.wav"
            className="mt-2 text-sm text-cream-muted file:mr-3 file:h-11 file:cursor-pointer file:rounded-md file:border-0 file:bg-gold-500 file:px-4 file:text-[0.6875rem] file:font-black file:uppercase file:tracking-[0.12em] file:text-[#261105] hover:file:bg-gold-400"
            disabled={disabled || !address}
          />
        </div>
      ) : null}

      <p className="mt-2 text-xs text-cream-muted">
        {looking
          ? "Reading the title and artist from the source…"
          : needsUpload
          ? "Ripped, added, and saved in one go — two wallet prompts: one for the import, one for the playlist."
          : suno
            ? "Suno track — plays from Suno's CDN, credited to the song page. Upload the file here if you want it to outlive their link."
            : classified
              ? `Will be added as: ${SOURCE_LABELS[classified]}.`
              : "Direct audio plays everywhere; YouTube/SoundCloud play inside the WoodAmp window; paste an X or Suno link to upload or stream it."}
      </p>
      {error ? <p className="mt-2 text-sm text-rose-400">{error}</p> : null}
      <button
        type="button"
        className={`${BUTTON_SECONDARY} mt-3`}
        onClick={() => void handleAdd()}
        disabled={disabled}
      >
        {uploading
          ? needsUpload
            ? "Ripping audio…"
            : "Uploading…"
          : needsUpload
            ? "Rip, add & save"
            : "Add to Planklist"}
      </button>
    </div>
  );
}

// --- Uploads ---------------------------------------------------------------

type UploadListing = { name: string; url: string; bytes: number };

function UploadsManager({ address }: { address: string | null }) {
  const [uploads, setUploads] = useState<UploadListing[] | null>(null);
  const [statusMsg, setStatusMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/music/upload", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { uploads?: UploadListing[] };
      setUploads(Array.isArray(data.uploads) ? data.uploads : []);
    } catch {
      setUploads([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleUpload = useCallback(async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || !address) return;
    setBusy(true);
    setStatusMsg(null);
    const outcome = await uploadMediaFile(file, address);
    setBusy(false);
    if (!outcome.ok) {
      setStatusMsg({ kind: "err", text: outcome.message });
      return;
    }
    setStatusMsg({
      kind: "ok",
      text: `Uploaded — use it as a hosted track: ${outcome.upload.url}`,
    });
    if (fileRef.current) fileRef.current.value = "";
    void load();
  }, [address, load]);

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-gold-300">Uploads</h2>
          <p className={`mt-1 ${LABEL}`}>
            Audio &amp; image files · survives releases, no deploy needed
          </p>
        </div>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          onClick={() => void load()}
          disabled={busy}
        >
          Reload
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".mp3,.m4a,.ogg,.wav,.webp,.png,.jpg,.jpeg,.gif"
          className="text-sm text-cream-muted file:mr-3 file:h-11 file:cursor-pointer file:rounded-md file:border-0 file:bg-gold-500 file:px-4 file:text-[0.6875rem] file:font-black file:uppercase file:tracking-[0.12em] file:text-[#261105] hover:file:bg-gold-400"
          disabled={busy || !address}
        />
        <button
          type="button"
          className={BUTTON_PRIMARY}
          onClick={() => void handleUpload()}
          disabled={busy || !address}
        >
          {busy ? "Uploading…" : "Sign & upload"}
        </button>
      </div>
      <p className="mt-2 text-xs text-cream-muted">
        Max 25 MB. mp3 / m4a / ogg / wav for tracks; webp / png / jpg / gif for
        CMS assets. The signature covers the file&apos;s hash — what you sign is
        exactly what&apos;s stored.
      </p>
      {statusMsg ? (
        <p className={statusMsg.kind === "ok" ? NOTE_OK : NOTE_ERR}>
          {statusMsg.text}
        </p>
      ) : null}

      {uploads === null ? (
        <p className="mt-4 text-sm text-cream-muted">Loading…</p>
      ) : uploads.length === 0 ? (
        <p className="mt-4 text-sm text-cream-muted">No uploads yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-gold-500/10 rounded-md border border-line bg-panel-strong">
          {uploads.map((u) => (
            <li
              key={u.name}
              className="flex flex-wrap items-center gap-2 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-cream">
                {u.url}
              </span>
              <span className="text-xs tabular-nums text-cream-muted">
                {Math.max(1, Math.round(u.bytes / 1024))} KB
              </span>
              <button
                type="button"
                className={`${BUTTON_SECONDARY} h-8 px-2 text-[0.5625rem]`}
                onClick={() => void navigator.clipboard.writeText(u.url)}
              >
                Copy URL
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
