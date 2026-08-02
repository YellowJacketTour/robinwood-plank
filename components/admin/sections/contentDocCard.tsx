"use client";

import { useCallback, useEffect, useState } from "react";
import type { ContentSlug } from "@/lib/content-docs";
import { saveContentDoc } from "../api";
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  CARD,
  LABEL,
  NOTE_ERR,
  NOTE_MUTED,
  NOTE_OK,
} from "../ui";

/**
 * Shared load / edit / sign-and-save scaffolding for one CMS document card —
 * every Content/Collections/Flags card is this hook plus a form body.
 */

export type DocSaveState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function useContentDocCard<T>(
  slug: ContentSlug,
  sanitize: (
    v: unknown
  ) => { ok: true; value: T } | { ok: false; message: string },
  address: string | null
) {
  const [doc, setDoc] = useState<T | null>(null);
  const [dirty, setDirty] = useState(false);
  const [save, setSave] = useState<DocSaveState>({ kind: "idle" });
  /** A load has failed and nothing was ever loaded. Lets a card show the
   *  error instead of a skeleton that will never resolve. */
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/content/${slug}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { doc?: unknown };
      const parsed = sanitize(data.doc);
      if (!parsed.ok) throw new Error();
      setDoc(parsed.value);
      setDirty(false);
      setLoadFailed(false);
      setSave({ kind: "idle" });
    } catch {
      // Do NOT clear an already-loaded doc here.
      //
      // This used to setDoc(null), which had two costs. It discarded whatever
      // the operator was looking at — including unsaved edits, so a Reload
      // click during a network blip silently destroyed their work. And it
      // dropped the card back into its "nothing yet" branch, so the body
      // rendered a loading placeholder underneath a fixed error line: an
      // animation promising data that is not coming.
      //
      // A failed reload now leaves the last good values on screen with the
      // error above them, which is both truthful and non-destructive. Only a
      // first load that never succeeded leaves doc null.
      setLoadFailed(true);
      setSave({ kind: "error", message: "Could not load — retry." });
    }
  }, [sanitize, slug]);

  useEffect(() => {
    // Fetch-on-mount from an external system — the standard suppression.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const mutate = useCallback((fn: (prev: T) => T) => {
    setDoc((prev) => (prev === null ? prev : fn(prev)));
    setDirty(true);
    setSave({ kind: "idle" });
  }, []);

  const persist = useCallback(async () => {
    if (doc === null || !address) return;
    const parsed = sanitize(doc);
    if (!parsed.ok) {
      setSave({ kind: "error", message: parsed.message });
      return;
    }
    setSave({ kind: "busy" });
    const outcome = await saveContentDoc(slug, parsed.value, address);
    if (!outcome.ok) {
      setSave({ kind: "error", message: outcome.message });
      return;
    }
    setDoc(parsed.value);
    setDirty(false);
    setSave({ kind: "saved" });
  }, [address, doc, sanitize, slug]);

  // `pending` is the only state a loading placeholder belongs in: nothing has
  // ever loaded AND nothing has failed. Cards branch on it rather than on
  // doc === null, which conflated "still waiting" with "gave up".
  const pending = doc === null && !loadFailed;
  return { doc, dirty, save, load, mutate, persist, loadFailed, pending };
}

export function CardChrome({
  title,
  subtitle,
  dirty,
  save,
  onReload,
  onSave,
  canSave,
  children,
}: {
  title: string;
  subtitle: string;
  dirty: boolean;
  save: DocSaveState;
  onReload: () => void;
  onSave: () => void;
  canSave: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-gold-300">{title}</h2>
          <p className={`mt-1 ${LABEL}`}>{subtitle}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={onReload}
            disabled={save.kind === "busy"}
          >
            {dirty ? "Discard" : "Reload"}
          </button>
          <button
            type="button"
            className={BUTTON_PRIMARY}
            onClick={onSave}
            disabled={!dirty || !canSave || save.kind === "busy"}
          >
            {save.kind === "busy" ? "Saving…" : "Sign & save"}
          </button>
        </div>
      </div>
      {save.kind === "error" ? <p className={NOTE_ERR}>{save.message}</p> : null}
      {save.kind === "saved" ? <p className={NOTE_OK}>Saved — live now.</p> : null}
      {dirty && save.kind === "idle" ? (
        <p className={NOTE_MUTED}>Unsaved changes.</p>
      ) : null}
      {children}
    </section>
  );
}
