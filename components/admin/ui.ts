/**
 * Shared class vocabulary for /admin sections — one place so every card uses
 * the same DESIGN.md tokens (bg-panel cards, border-line hairlines, gold
 * primary / dark secondary controls at 44 px, label typography).
 */
export const LABEL =
  "text-[0.6875rem] font-black uppercase tracking-[0.12em] text-cream-muted";
export const INPUT =
  "h-11 w-full rounded-md border border-line bg-panel-strong px-3 text-sm text-cream placeholder:text-cream-muted/60 focus:border-line-strong focus:outline-none";
export const BUTTON_PRIMARY =
  "inline-flex h-11 items-center justify-center rounded-md bg-gold-500 px-4 text-[0.6875rem] font-black uppercase tracking-[0.12em] text-[#261105] transition-colors hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50";
export const BUTTON_SECONDARY =
  "inline-flex h-11 items-center justify-center rounded-md border border-line bg-panel-strong px-4 text-[0.6875rem] font-black uppercase tracking-[0.12em] text-gold-300 transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-50";
export const CARD = "rounded-lg border border-line bg-panel p-4 sm:p-5";
export const NOTE_OK =
  "mt-3 rounded-md bg-panel-strong p-2 text-sm text-emerald-400";
export const NOTE_ERR =
  "mt-3 rounded-md bg-panel-strong p-2 text-sm text-rose-400";
export const NOTE_MUTED =
  "mt-3 rounded-md bg-panel-strong p-2 text-sm text-cream-muted";
