import { looksLikeSolanaPubkey } from "@/lib/market/multichain/solana-pubkey";

/** True when a "name" is actually a mint / inscription id, not a human title. */
export function looksLikeRawTokenId(value: string): boolean {
  const t = value.trim().replace(/^#/, "");
  if (!t) return true;
  if (looksLikeSolanaPubkey(t)) return true;
  if (/^[0-9a-f]{64}i[0-9]+$/i.test(t)) return true;
  return false;
}

export function shortTokenId(tokenId: string): string {
  if (!tokenId) return "";
  if (tokenId.length <= 12) return `#${tokenId}`;
  return `#${tokenId.slice(0, 4)}…${tokenId.slice(-4)}`;
}

/** Prefer metadata name; never show a 44-char mint as the title. */
export function displayTokenLabel(opts: {
  tokenId: string;
  tokenName?: string | null;
  rarityName?: string | null;
}): string {
  for (const candidate of [opts.tokenName, opts.rarityName]) {
    const n = candidate?.trim();
    if (n && !looksLikeRawTokenId(n)) return n;
  }
  return shortTokenId(opts.tokenId);
}
