/**
 * Site-wide accent theme -- one hue/saturation pair plus four lightness
 * stops (see app/globals.css's --accent- custom properties and the
 * --color-gold- tokens derived from them). Every "gold" bg/text/border
 * utility in the app already resolves through those four vars, so
 * overwriting them on documentElement retints the entire site's accent in
 * one shot -- no per-component changes needed.
 *
 * Lightness stops are kept at a fixed relative spacing across every preset
 * (deltas from GOLD_BARK, this app's original literal gold hex values
 * re-expressed as HSL) so contrast/legibility stays close to what the app
 * has always shipped with, regardless of which hue is active -- "maximally
 * readable" per the live request this exists to satisfy, not just "any
 * color allowed."
 */
export type AccentTheme = {
  h: number;
  s: number;
  l600: number;
  l500: number;
  l400: number;
  l300: number;
};

const L_DELTA = { l500: 18, l400: 25, l300: 36 }; // offsets from l600, matching the original gold stops

function stops(h: number, s: number, l600: number): AccentTheme {
  return { h, s, l600, l500: l600 + L_DELTA.l500, l400: l600 + L_DELTA.l400, l300: l600 + L_DELTA.l300 };
}

/**
 * Named presets researched from real natural-material color references
 * (not invented arbitrarily): weathered/oiled hardwood tones, temperate
 * forest canopy greens, cedar/redwood heartwood reds, ripe-citrus "tang"
 * orange, and the violet/indigo range conventionally used for
 * arcane/"wizard" magic effects across game and fantasy-illustration
 * palettes. Each keeps the same lightness spacing as the app's own
 * original gold so every preset stays as readable as the current site.
 */
export const ACCENT_PRESETS: Record<string, AccentTheme> = {
  "amber-gold": stops(40, 78, 41), // the app's original, default gold
  "forest-canopy": stops(142, 42, 34),
  "cedar-wood": stops(16, 58, 40),
  "tang-citrus": stops(26, 88, 48),
  "wizard-violet": stops(266, 48, 46),
};

export const DEFAULT_ACCENT: AccentTheme = ACCENT_PRESETS["amber-gold"];

export const ACCENT_STORAGE_KEY = "plank:theme:accent-v1";

/** Any hue across the full spectrum, saturation/lightness spacing held at the current preset's -- the "one-tap primary color, any natural tone" slider. */
export function accentFromHue(hue: number, base: AccentTheme = DEFAULT_ACCENT): AccentTheme {
  return stops(((hue % 360) + 360) % 360, base.s, base.l600);
}

export function applyAccentTheme(theme: AccentTheme, root: HTMLElement = document.documentElement): void {
  root.style.setProperty("--accent-h", String(theme.h));
  root.style.setProperty("--accent-s", `${theme.s}%`);
  root.style.setProperty("--accent-l-600", `${theme.l600}%`);
  root.style.setProperty("--accent-l-500", `${theme.l500}%`);
  root.style.setProperty("--accent-l-400", `${theme.l400}%`);
  root.style.setProperty("--accent-l-300", `${theme.l300}%`);
}

export function loadSavedAccent(): AccentTheme | null {
  try {
    const raw = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AccentTheme>;
    if (
      typeof parsed.h === "number" &&
      typeof parsed.s === "number" &&
      typeof parsed.l600 === "number" &&
      typeof parsed.l500 === "number" &&
      typeof parsed.l400 === "number" &&
      typeof parsed.l300 === "number"
    ) {
      return parsed as AccentTheme;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveAccent(theme: AccentTheme): void {
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // Best-effort persistence only -- theme still applies for this session.
  }
}

/**
 * Per-wallet-address theme memory -- flagged live 2026-08-19 ("be sure it
 * remembers wallet addresses scheme settings and auto loads upon wallet
 * connect"). A SEPARATE key per address, distinct from ACCENT_STORAGE_KEY
 * (which stays the no-wallet-connected / not-yet-known fallback the
 * bootstrap script reads before any wallet state exists): a shared
 * device/browser can hold multiple wallets, each with its own pick, and
 * connecting a DIFFERENT wallet should switch to THAT wallet's theme, not
 * silently overwrite it with whatever the last wallet happened to leave
 * behind. Lowercased -- addresses are commonly copy/pasted with mixed
 * checksum casing, and this must match regardless.
 */
function perAddressKey(address: string): string {
  return `plank:theme:accent-by-address-v1:${address.toLowerCase()}`;
}

export function loadSavedAccentForAddress(address: string): AccentTheme | null {
  try {
    const raw = window.localStorage.getItem(perAddressKey(address));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AccentTheme>;
    if (
      typeof parsed.h === "number" &&
      typeof parsed.s === "number" &&
      typeof parsed.l600 === "number" &&
      typeof parsed.l500 === "number" &&
      typeof parsed.l400 === "number" &&
      typeof parsed.l300 === "number"
    ) {
      return parsed as AccentTheme;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveAccentForAddress(address: string, theme: AccentTheme): void {
  try {
    window.localStorage.setItem(perAddressKey(address), JSON.stringify(theme));
  } catch {
    // Best-effort persistence only -- theme still applies for this session.
  }
}

/**
 * Source string for the blocking bootstrap <script> in app/layout.tsx.
 * Runs before first paint so a returning visitor with a saved theme never
 * sees a flash back to default gold -- same reasoning as any dark-mode
 * bootstrap script, just for one custom accent instead of a light/dark
 * class. Kept as a plain string (not an import) since it must execute
 * standalone in the browser before any app JS/bundle has loaded.
 */
export const ACCENT_BOOTSTRAP_SCRIPT = `(function(){try{var raw=localStorage.getItem(${JSON.stringify(
  ACCENT_STORAGE_KEY
)});if(!raw)return;var t=JSON.parse(raw);if(typeof t.h!=="number")return;var r=document.documentElement.style;r.setProperty("--accent-h",String(t.h));r.setProperty("--accent-s",t.s+"%");r.setProperty("--accent-l-600",t.l600+"%");r.setProperty("--accent-l-500",t.l500+"%");r.setProperty("--accent-l-400",t.l400+"%");r.setProperty("--accent-l-300",t.l300+"%");}catch(e){}})();`;
