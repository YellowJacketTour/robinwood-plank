/**
 * CMS document shapes + sanitizers, shared client/server (no Node imports —
 * the /admin console signs the sanitized JSON and the server verifies the
 * same bytes, exactly like lib/woodamp-playlist.ts).
 *
 * Each document is one database value edited whole from /admin. Public pages read
 * the doc through /api/content/<slug> (or server-side via
 * lib/content-store.ts) and every doc has a hardcoded fallback, so an empty
 * or unreachable store can never blank a public surface — the CMS is an
 * override layer, not the source of truth for first paint.
 */

const MAX_TEXT = 300;
const MAX_LONG_TEXT = 2000;
const MAX_LIST = 100;

export type SanitizeResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanText(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// --- learn: per-section visibility ----------------------------------------

/**
 * Per-section visibility plus optional per-section TEXT OVERRIDES. A section
 * with no override renders its coded JSX from LearnGuide.tsx (the permanent
 * fallback — clearing an override restores the coded text, so there is no
 * drift, only explicit replacement). Overrides are plain text: blank lines
 * split paragraphs; no HTML/markup is interpreted (nothing an admin types
 * can inject markup into the page).
 */
export type LearnDoc = {
  /** Section ids from LearnGuide's TOC that are hidden on the public page. */
  hidden: string[];
  /** Section id -> replacement body text ("" is dropped = use coded text). */
  overrides: Record<string, string>;
};

export const LEARN_FALLBACK: LearnDoc = { hidden: [], overrides: {} };

const MAX_OVERRIDE_CHARS = 20_000;

export function sanitizeLearn(v: unknown): SanitizeResult<LearnDoc> {
  if (!isRecord(v) || !Array.isArray(v.hidden)) {
    return { ok: false, message: "learn doc needs a hidden: string[] field." };
  }
  if (v.hidden.length > MAX_LIST) {
    return { ok: false, message: `At most ${MAX_LIST} hidden ids.` };
  }
  const hidden: string[] = [];
  for (const id of v.hidden) {
    if (typeof id !== "string" || !SLUG.test(id)) {
      return { ok: false, message: `Bad section id: ${String(id)}` };
    }
    if (!hidden.includes(id)) hidden.push(id);
  }
  const overrides: Record<string, string> = {};
  if (v.overrides !== undefined) {
    if (!isRecord(v.overrides)) {
      return { ok: false, message: "overrides must be an object of id -> text." };
    }
    for (const [id, text] of Object.entries(v.overrides)) {
      if (!SLUG.test(id)) {
        return { ok: false, message: `Bad override section id: ${id}` };
      }
      if (typeof text !== "string") {
        return { ok: false, message: `${id}: override must be a string.` };
      }
      if (text.length > MAX_OVERRIDE_CHARS) {
        return {
          ok: false,
          message: `${id}: override exceeds ${MAX_OVERRIDE_CHARS} characters.`,
        };
      }
      const trimmed = text.trim();
      if (trimmed) overrides[id] = trimmed;
    }
  }
  return { ok: true, value: { hidden, overrides } };
}

// --- intro: rotating splash phrases ---------------------------------------

export type IntroPhrase = {
  /** Small eyebrow line, e.g. "Warming the workshop". */
  eyebrow: string;
  /** Display headline, e.g. "🔨 Nailing the planks". */
  headline: string;
  /** Supporting line under the headline. */
  subline: string;
};

export type IntroDoc = {
  phrases: IntroPhrase[];
};

/** The phrase shipped in components/SplashIntro.tsx — always the fallback.
 * The 🔨 hammer (with its swing animation) is rendered by the component in
 * front of every headline; don't put an emoji in `headline`. */
export const INTRO_FALLBACK: IntroDoc = {
  phrases: [
    {
      eyebrow: "Warming the workshop",
      headline: "Nailing the planks",
      subline:
        "The fence is almost up — 1,542 RobinWood Planks are waiting on the other side.",
    },
  ],
};

export function sanitizeIntro(v: unknown): SanitizeResult<IntroDoc> {
  if (!isRecord(v) || !Array.isArray(v.phrases)) {
    return { ok: false, message: "intro doc needs a phrases array." };
  }
  if (v.phrases.length === 0) {
    return { ok: false, message: "Keep at least one phrase." };
  }
  if (v.phrases.length > MAX_LIST) {
    return { ok: false, message: `At most ${MAX_LIST} phrases.` };
  }
  const phrases: IntroPhrase[] = [];
  for (const raw of v.phrases) {
    if (!isRecord(raw)) return { ok: false, message: "Phrase must be an object." };
    const eyebrow = cleanText(raw.eyebrow);
    const headline = cleanText(raw.headline);
    const subline = cleanText(raw.subline);
    if (!eyebrow || !headline || !subline) {
      return {
        ok: false,
        message: `Every phrase needs eyebrow, headline, and subline (max ${MAX_TEXT} chars).`,
      };
    }
    phrases.push({ eyebrow, headline, subline });
  }
  return { ok: true, value: { phrases } };
}

// --- banner: site-wide announcement ---------------------------------------

export type BannerDoc = {
  enabled: boolean;
  text: string;
  /** Optional link; internal path or https URL. Empty string = no link. */
  href: string;
};

export const BANNER_FALLBACK: BannerDoc = { enabled: false, text: "", href: "" };

export function sanitizeBanner(v: unknown): SanitizeResult<BannerDoc> {
  if (!isRecord(v) || typeof v.enabled !== "boolean") {
    return { ok: false, message: "banner doc needs enabled: boolean." };
  }
  const text = typeof v.text === "string" ? v.text.trim() : "";
  if (v.enabled && !text) {
    return { ok: false, message: "An enabled banner needs text." };
  }
  if (text.length > MAX_TEXT) {
    return { ok: false, message: `Banner text max ${MAX_TEXT} chars.` };
  }
  const href = typeof v.href === "string" ? v.href.trim() : "";
  if (href) {
    const internal = /^\/[^\s]*$/.test(href) && !href.startsWith("//");
    let externalOk = false;
    try {
      externalOk = new URL(href).protocol === "https:";
    } catch {
      externalOk = false;
    }
    if (!internal && !externalOk) {
      return {
        ok: false,
        message: "Banner link must be an internal path or an https URL.",
      };
    }
  }
  return { ok: true, value: { enabled: v.enabled, text, href } };
}

// --- flags: runtime overrides ---------------------------------------------

/**
 * Runtime overrides for build-baked env flags. null = no override (the baked
 * env value stands). Only flags with a server-side consumption path can take
 * effect at runtime; today that is trade pause via /api/trade/status (which
 * clients already fetch-and-OR). The others render read-only in /admin until
 * a runtime path exists for them.
 */
export type FlagsDoc = {
  tradePaused: boolean | null;
  /** Runtime kill switch / enable for /market. Consumed server-side by
   * app/market/page.tsx, so both directions work without a deployment.
   * RULES_RELAXED deliberately has NO runtime override: it relaxes trade
   * protections inside lib/boards.ts and stays a reviewed env change. */
  marketEnabled: boolean | null;
};

export const FLAGS_FALLBACK: FlagsDoc = { tradePaused: null, marketEnabled: null };

function triState(
  v: unknown,
  name: string
): { ok: true; value: boolean | null } | { ok: false; message: string } {
  if (v !== null && v !== undefined && typeof v !== "boolean") {
    return { ok: false, message: `${name} must be true, false, or null.` };
  }
  return { ok: true, value: (v as boolean | null | undefined) ?? null };
}

export function sanitizeFlags(v: unknown): SanitizeResult<FlagsDoc> {
  if (!isRecord(v)) return { ok: false, message: "flags doc must be an object." };
  const tradePaused = triState(v.tradePaused, "tradePaused");
  if (!tradePaused.ok) return tradePaused;
  const marketEnabled = triState(v.marketEnabled, "marketEnabled");
  if (!marketEnabled.ok) return marketEnabled;
  return {
    ok: true,
    value: { tradePaused: tradePaused.value, marketEnabled: marketEnabled.value },
  };
}

// --- collections: admin-staged market collections -------------------------

/**
 * Admin-staged collection entries. NOT yet consumed by the market runtime:
 * lib/market/collections.ts remains the authoritative allowlist (it feeds the
 * wallet destination allowlist, which must stay a build-time constant — see
 * that file). This doc is the staging list an admin edits; wiring it into the
 * server-side market routes is a separate, deliberate change.
 */
export type StagedCollection = {
  slug: string;
  name: string;
  contractAddress: string;
  tokenStandard: "ERC721" | "ERC1155";
  feeBps: number;
  /** Instant Swap vault address once one is deployed for this collection.
   * "" = trading only (the normal starting state — a vault is optional and
   * comes later, if ever). ERC721 collections only. */
  vaultAddress: string;
  notes: string;
};

export type CollectionsDoc = {
  staged: StagedCollection[];
};

export const COLLECTIONS_FALLBACK: CollectionsDoc = { staged: [] };

export function sanitizeCollections(v: unknown): SanitizeResult<CollectionsDoc> {
  if (!isRecord(v) || !Array.isArray(v.staged)) {
    return { ok: false, message: "collections doc needs a staged array." };
  }
  if (v.staged.length > MAX_LIST) {
    return { ok: false, message: `At most ${MAX_LIST} staged collections.` };
  }
  const staged: StagedCollection[] = [];
  const seen = new Set<string>();
  for (const raw of v.staged) {
    if (!isRecord(raw)) {
      return { ok: false, message: "Collection must be an object." };
    }
    const slug = typeof raw.slug === "string" ? raw.slug : "";
    if (!SLUG.test(slug)) {
      return { ok: false, message: `Bad collection slug: ${slug}` };
    }
    if (seen.has(slug)) {
      return { ok: false, message: `Duplicate slug ${slug}.` };
    }
    seen.add(slug);
    const name = cleanText(raw.name);
    if (!name) return { ok: false, message: `${slug}: name required.` };
    const contractAddress =
      typeof raw.contractAddress === "string" ? raw.contractAddress.trim() : "";
    if (!HEX_ADDRESS.test(contractAddress)) {
      return { ok: false, message: `${slug}: bad contract address.` };
    }
    if (raw.tokenStandard !== "ERC721" && raw.tokenStandard !== "ERC1155") {
      return { ok: false, message: `${slug}: tokenStandard must be ERC721 or ERC1155.` };
    }
    const feeBps = raw.feeBps;
    if (
      typeof feeBps !== "number" ||
      !Number.isInteger(feeBps) ||
      feeBps < 0 ||
      feeBps > 1000
    ) {
      return { ok: false, message: `${slug}: feeBps must be an integer 0-1000.` };
    }
    const vaultAddress =
      typeof raw.vaultAddress === "string" ? raw.vaultAddress.trim() : "";
    if (vaultAddress && !HEX_ADDRESS.test(vaultAddress)) {
      return { ok: false, message: `${slug}: bad vault address.` };
    }
    if (vaultAddress && raw.tokenStandard !== "ERC721") {
      return {
        ok: false,
        message: `${slug}: vaults are ERC721-only (MarketplankVault takes an IERC721).`,
      };
    }
    const notes =
      typeof raw.notes === "string" ? raw.notes.trim().slice(0, MAX_LONG_TEXT) : "";
    staged.push({
      slug,
      name,
      contractAddress: contractAddress.toLowerCase(),
      tokenStandard: raw.tokenStandard,
      feeBps,
      vaultAddress: vaultAddress.toLowerCase(),
      notes,
    });
  }
  return { ok: true, value: { staged } };
}

// --- registry --------------------------------------------------------------

export type ContentSlug = "learn" | "intro" | "banner" | "flags" | "collections";

export const CONTENT_SLUGS: readonly ContentSlug[] = [
  "learn",
  "intro",
  "banner",
  "flags",
  "collections",
] as const;

export function isContentSlug(v: string): v is ContentSlug {
  return (CONTENT_SLUGS as readonly string[]).includes(v);
}

/** Sanitize a doc payload for its slug. */
export function sanitizeContent(
  slug: ContentSlug,
  value: unknown
): SanitizeResult<unknown> {
  switch (slug) {
    case "learn":
      return sanitizeLearn(value);
    case "intro":
      return sanitizeIntro(value);
    case "banner":
      return sanitizeBanner(value);
    case "flags":
      return sanitizeFlags(value);
    case "collections":
      return sanitizeCollections(value);
  }
}

export function contentFallback(slug: ContentSlug): unknown {
  switch (slug) {
    case "learn":
      return LEARN_FALLBACK;
    case "intro":
      return INTRO_FALLBACK;
    case "banner":
      return BANNER_FALLBACK;
    case "flags":
      return FLAGS_FALLBACK;
    case "collections":
      return COLLECTIONS_FALLBACK;
  }
}
