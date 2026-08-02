"use client";

import { useRef, useState } from "react";
import { Upload, X, CheckCircle2 } from "lucide-react";

/**
 * Submit a meme to the Community Meme Vault.
 *
 * Posts to /api/memes/submit, never upstream directly — the key is
 * submit-capable and the whole site shares a 20/hour budget, so both the
 * credential and the throttle have to live on the server.
 *
 * Everything lands in a moderation queue and is not public until approved.
 * The copy says so plainly: a form that implies "posted!" and then shows
 * nothing reads as broken, and people re-submit.
 */

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm";
const MAX_BYTES = 25 * 1024 * 1024;

type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; message: string; duplicate: boolean }
  | { kind: "error"; message: string };

export default function MemeSubmit({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [creatorName, setCreatorName] = useState("");
  const [tags, setTags] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (f: File | null) => {
    if (preview) URL.revokeObjectURL(preview);
    if (!f) {
      setFile(null);
      setPreview(null);
      return;
    }
    if (f.size > MAX_BYTES) {
      setState({ kind: "error", message: "That file is over the 25 MB limit." });
      return;
    }
    setState({ kind: "idle" });
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !title.trim() || state.kind === "sending") return;
    setState({ kind: "sending" });
    const body = new FormData();
    body.set("media", file);
    body.set("title", title.trim());
    if (creatorName.trim()) body.set("creatorName", creatorName.trim());
    if (tags.trim()) body.set("tags", tags.trim());
    try {
      const res = await fetch("/api/memes/submit", { method: "POST", body });
      const data = (await res.json()) as {
        message?: string;
        duplicate?: boolean;
      };
      if (!res.ok) {
        setState({ kind: "error", message: data.message || "That didn't go through." });
        return;
      }
      setState({
        kind: "sent",
        message: data.message || "Submitted for review.",
        duplicate: Boolean(data.duplicate),
      });
    } catch {
      setState({ kind: "error", message: "Could not reach the meme vault. Try again." });
    }
  };

  if (state.kind === "sent") {
    return (
      <div className="rounded-xl border border-line bg-panel p-4 text-center">
        <CheckCircle2 size={20} strokeWidth={2.5} className="mx-auto text-emerald-400" aria-hidden="true" />
        <p className="mt-2 text-sm font-bold text-cream">{state.message}</p>
        {state.duplicate && (
          <p className="mt-1 text-xs text-foreground/60">
            Heads up: something very similar is already in the queue.
          </p>
        )}
        <div className="mt-3 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => {
              pick(null);
              setTitle("");
              setTags("");
              setState({ kind: "idle" });
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="min-h-11 rounded-lg border border-line-strong px-4 text-sm font-bold text-gold-300 hover:border-gold-400"
          >
            Submit another
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-lg bg-gold-500 px-4 text-sm font-bold text-wood-950 hover:bg-gold-400"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-panel p-3 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-cream">Submit a meme</p>
          <p className="mt-0.5 text-xs text-foreground/60">
            Goes to a moderator first — it appears here once approved, not straight away.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1 text-foreground/60 hover:text-gold-300"
        >
          <X size={16} strokeWidth={2.5} />
        </button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
        <div>
          <input
            ref={inputRef}
            id="meme-file"
            type="file"
            accept={ACCEPT}
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            className="sr-only"
          />
          <label
            htmlFor="meme-file"
            className="flex aspect-square w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-line-strong bg-wood-950 text-center hover:border-gold-400"
          >
            {preview ? (
              file?.type.startsWith("video/") ? (
                <video src={preview} muted loop autoPlay playsInline className="h-full w-full object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="" className="h-full w-full object-cover" />
              )
            ) : (
              <span className="px-3 text-xs text-foreground/55">
                <Upload size={18} strokeWidth={2.5} className="mx-auto mb-1" aria-hidden="true" />
                Pick an image, GIF or video
                <span className="mt-1 block text-[0.65rem] text-foreground/40">
                  JPEG, PNG, WebP, GIF, MP4, WebM · 25 MB max
                </span>
              </span>
            )}
          </label>
        </div>

        <div className="space-y-2">
          <div>
            <label htmlFor="meme-title" className="sr-only">
              Title
            </label>
            <input
              id="meme-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title (required)"
              maxLength={120}
              className="min-h-11 w-full rounded-lg border border-line-strong bg-wood-950 px-3 text-sm text-cream placeholder:text-foreground/40"
            />
          </div>
          <div>
            <label htmlFor="meme-creator" className="sr-only">
              Your name or handle
            </label>
            <input
              id="meme-creator"
              value={creatorName}
              onChange={(e) => setCreatorName(e.target.value)}
              placeholder="Your name or handle (optional)"
              maxLength={60}
              className="min-h-11 w-full rounded-lg border border-line-strong bg-wood-950 px-3 text-sm text-cream placeholder:text-foreground/40"
            />
          </div>
          <div>
            <label htmlFor="meme-tags" className="sr-only">
              Tags
            </label>
            <input
              id="meme-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="Tags, comma separated (optional)"
              maxLength={200}
              className="min-h-11 w-full rounded-lg border border-line-strong bg-wood-950 px-3 text-sm text-cream placeholder:text-foreground/40"
            />
          </div>
        </div>
      </div>

      {state.kind === "error" && (
        <p role="alert" className="mt-3 rounded-lg border border-rose-400/30 bg-panel-strong px-3 py-2 text-sm text-rose-400">
          {state.message}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[0.68rem] text-foreground/50">
          Only submit work you have the right to share.
        </p>
        <button
          type="submit"
          disabled={!file || !title.trim() || state.kind === "sending"}
          className="min-h-11 rounded-lg bg-gold-500 px-4 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          {state.kind === "sending" ? "Sending…" : "Submit for review"}
        </button>
      </div>
    </form>
  );
}
