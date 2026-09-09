import { validDecorations, type Decoration } from "./layout";

/** Public scenery metadata only. This is not a store for prose or media drafts. */
export type LayoutDraft = { version: 1; revision: string; decorations: Decoration[] };

export function layoutDraftKey(wallet: string, handle: string): string {
  return `charmville-layout-draft:${wallet.toLowerCase()}:${handle.toLowerCase()}`;
}

export function parseLayoutDraft(raw: string | null): LayoutDraft | null {
  if (!raw || raw.length > 8192) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || typeof value.revision !== "string" ||
      !/^(0|[1-9][0-9]{0,19})$/.test(value.revision) || !validDecorations(value.decorations)) return null;
    // Project only the permitted metadata, even if local storage was modified.
    return { version: 1, revision: value.revision,
      decorations: value.decorations.map(({id,x,y}: Decoration) => ({id,x,y})) };
  } catch { return null; }
}
