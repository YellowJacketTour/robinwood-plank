import type { NftAttribute } from "@/lib/ipfs";

/** Split CamelCase / snake / separators into lowercase tokens. */
export function tokenize(value: string): string[] {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function unique(words: string[]): string[] {
  return Array.from(new Set(words));
}

/** Normalize wallet / vanity input for comparison. */
export function normalizeAddressQuery(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/**
 * True when the query looks like a wallet, partial address, or vanity hex.
 * Examples: 0xabc…, full 40-hex, "dead", "beef01"
 */
export function isAddressLikeQuery(query: string): boolean {
  const q = normalizeAddressQuery(query);
  if (!q) return false;
  if (q.startsWith("0x")) {
    return /^0x[a-f0-9]{2,40}$/.test(q);
  }
  // bare hex / vanity fragments (avoid pure trait words like "rare" by requiring hex-only)
  if (/^[a-f0-9]{3,40}$/.test(q)) return true;
  return false;
}

/** Address fragments indexed for partial / vanity lookup. */
export function buildAddressSearchParts(owner?: string): string[] {
  if (!owner) return [];
  const full = normalizeAddressQuery(owner);
  if (!/^0x[a-f0-9]{40}$/.test(full) && !full.startsWith("0x")) {
    // non-standard vanity label
    return unique([full, ...tokenize(full)]);
  }

  const hex = full.startsWith("0x") ? full.slice(2) : full;
  const parts = [
    full,
    hex,
    `0x${hex}`,
    // common short forms
    full.slice(0, 6),
    full.slice(0, 8),
    full.slice(0, 10),
    `0x${hex.slice(0, 4)}`,
    hex.slice(0, 4),
    hex.slice(0, 6),
    // tail vanity (…dead, …beef)
    hex.slice(-4),
    hex.slice(-6),
    hex.slice(-8),
    full.slice(-4),
  ];

  return unique(parts.filter((part) => part.length >= 3));
}

export function addressMatchesOwner(query: string, owner?: string): boolean {
  if (!owner) return false;
  const q = normalizeAddressQuery(query);
  if (!q) return true;

  const full = normalizeAddressQuery(owner);
  const hex = full.startsWith("0x") ? full.slice(2) : full;
  const qHex = q.startsWith("0x") ? q.slice(2) : q;

  // Full or partial on full address / bare hex
  if (full.includes(q) || hex.includes(qHex) || full.includes(qHex)) return true;
  if (qHex.length >= 3 && (hex.startsWith(qHex) || hex.endsWith(qHex))) return true;
  if (q.length >= 3 && (full.startsWith(q) || full.endsWith(q))) return true;

  // Vanity label on owner string (non-hex display name)
  if (!isAddressLikeQuery(q) && full.includes(q)) return true;

  return false;
}

/**
 * Build a rich search index for one NFT: name, id, description, traits,
 * camelCase base names, type:value pairs, and owner wallet / vanity fragments.
 */
export function buildGallerySearchIndex(input: {
  tokenId: number;
  name: string;
  description?: string;
  attributes?: NftAttribute[];
  owner?: string;
  vanity?: string;
}): { searchText: string; words: string[]; owner: string } {
  const attributes = input.attributes ?? [];
  const owner = input.owner ? normalizeAddressQuery(input.owner) : "";
  const vanity = input.vanity?.trim() || "";

  const parts: string[] = [
    input.name,
    input.description ?? "",
    String(input.tokenId),
    `#${input.tokenId}`,
    `token ${input.tokenId}`,
    `plank ${input.tokenId}`,
    owner,
    vanity,
    ...buildAddressSearchParts(owner),
  ];

  if (vanity) {
    parts.push(...tokenize(vanity), vanity.toLowerCase());
  }

  for (const attribute of attributes) {
    const trait = String(attribute.trait_type ?? "").trim();
    const value = String(attribute.value ?? "").trim();
    if (trait) parts.push(trait);
    if (value) parts.push(value);
    if (trait && value) {
      parts.push(`${trait} ${value}`, `${trait}:${value}`, `${value} ${trait}`);
    }
  }

  const words = unique(parts.flatMap((part) => {
    // Keep unbroken address / long hex strings as single searchable words
    const lower = String(part).toLowerCase();
    if (/^0x[a-f0-9]{4,}$/.test(lower) || /^[a-f0-9]{6,}$/.test(lower)) {
      return [lower, lower.startsWith("0x") ? lower.slice(2) : lower];
    }
    return tokenize(part);
  }));

  // Joined blob for substring matches ("holo" in "holographic", partial addresses)
  const searchText = unique([
    ...words,
    owner,
    owner.startsWith("0x") ? owner.slice(2) : owner,
    vanity.toLowerCase(),
  ])
    .filter(Boolean)
    .join(" ");

  return { searchText, words, owner };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) row[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[b.length];
}

function fuzzyBudget(tokenLength: number): number {
  if (tokenLength <= 2) return 0;
  if (tokenLength <= 4) return 1;
  if (tokenLength <= 7) return 2;
  return 3;
}

export function tokenMatchesIndex(
  token: string,
  searchText: string,
  words: string[],
  owner?: string,
): boolean {
  const q = token.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (!q) return true;

  // Wallet / vanity / partial address path
  if (owner && addressMatchesOwner(q, owner)) return true;
  if (isAddressLikeQuery(q) && searchText.includes(q.replace(/^0x/, ""))) return true;

  if (searchText.includes(q)) return true;

  for (const word of words) {
    if (word === q) return true;
    if (q.length >= 2 && word.startsWith(q)) return true;
    if (q.length >= 3 && word.includes(q)) return true;

    const budget = fuzzyBudget(q.length);
    const lenDiff = Math.abs(word.length - q.length);
    if (
      budget > 0 &&
      lenDiff <= budget &&
      q.length <= word.length + 1 &&
      levenshtein(q, word) <= budget
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Multi-token query: every token must match (AND), unless the whole query
 * is a single address-like string (then match owner in one shot).
 */
export function matchesGalleryQuery(
  query: string,
  searchText: string,
  words: string[],
  owner?: string,
): boolean {
  const raw = query.trim();
  if (!raw) return true;

  // Whole-query address / vanity (allows spaces-stripped paste)
  const compact = normalizeAddressQuery(raw).replace(/\s+/g, "");
  if (owner && (addressMatchesOwner(raw, owner) || addressMatchesOwner(compact, owner))) {
    return true;
  }
  if (isAddressLikeQuery(compact) && searchText.includes(compact.replace(/^0x/, ""))) {
    return true;
  }

  const tokens = tokenize(raw);
  // If tokenize wiped a hex query, fall back to compact form
  if (!tokens.length) {
    return tokenMatchesIndex(compact, searchText, words, owner);
  }

  return tokens.every((token) =>
    tokenMatchesIndex(token, searchText, words, owner),
  );
}
