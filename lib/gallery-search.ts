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

/**
 * Build a rich search index for one NFT: name, id, description, traits,
 * camelCase base names (IronWood → iron wood), and type:value pairs.
 */
export function buildGallerySearchIndex(input: {
  tokenId: number;
  name: string;
  description?: string;
  attributes?: NftAttribute[];
}): { searchText: string; words: string[] } {
  const attributes = input.attributes ?? [];
  const parts: string[] = [
    input.name,
    input.description ?? "",
    String(input.tokenId),
    `#${input.tokenId}`,
    `token ${input.tokenId}`,
    `plank ${input.tokenId}`,
  ];

  for (const attribute of attributes) {
    const trait = String(attribute.trait_type ?? "").trim();
    const value = String(attribute.value ?? "").trim();
    if (trait) parts.push(trait);
    if (value) parts.push(value);
    if (trait && value) {
      parts.push(`${trait} ${value}`, `${trait}:${value}`, `${value} ${trait}`);
    }
  }

  const words = unique(parts.flatMap(tokenize));
  // Also keep the joined blob for substring matches ("holo" in "holographic")
  const searchText = words.join(" ");
  return { searchText, words };
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
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + cost,
      );
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Max edit distance allowed for a query token length. */
function fuzzyBudget(tokenLength: number): number {
  if (tokenLength <= 2) return 0;
  if (tokenLength <= 4) return 1;
  if (tokenLength <= 7) return 2;
  return 3;
}

/**
 * True if a single query token matches the NFT index via:
 * - substring ("holo" → holographic)
 * - word prefix (query is start of a metadata word)
 * - near/fuzzy spellings (small edit distance)
 */
export function tokenMatchesIndex(
  token: string,
  searchText: string,
  words: string[],
): boolean {
  const q = token.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (!q) return true;

  // Fast path: full blob substring (partial fit across joined words)
  if (searchText.includes(q)) return true;

  for (const word of words) {
    if (word === q) return true;

    // Partial: user typed a prefix of a trait/name word ("holo" → holographic)
    if (q.length >= 2 && word.startsWith(q)) return true;

    // Interior partial on a single word ("wood" in "ironwood")
    if (q.length >= 3 && word.includes(q)) return true;

    // Near spelling only when lengths are similar (rare ↔ raer), not loose prefixes
    const budget = fuzzyBudget(q.length);
    if (
      budget > 0 &&
      Math.abs(word.length - q.length) <= budget &&
      levenshtein(q, word) <= budget
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Multi-token query: every token must match (AND).
 * Spaces separate terms; empty query matches all.
 */
export function matchesGalleryQuery(
  query: string,
  searchText: string,
  words: string[],
): boolean {
  const raw = query.trim();
  if (!raw) return true;

  const tokens = tokenize(raw);
  if (!tokens.length) return true;

  return tokens.every((token) => tokenMatchesIndex(token, searchText, words));
}
