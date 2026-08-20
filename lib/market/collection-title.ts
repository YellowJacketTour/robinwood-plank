/**
 * Hub/display spam titles — BNB scan showed etherscan tx URLs and
 * "world wide vandals" as collection names. Not a grade; a reject list
 * of strings that are not collectible titles. Keep this in a client-safe
 * file (no postgres).
 */
const SPAM =
  /https?:\/\/|etherscan\.io|bscscan\.com|solscan\.io|polygonscan|snowtrace|arbiscan|basescan|optimistic\.etherscan|buying transaction|world wide vandals|gorillapool|webcommodore|imageproof|rainbet|state transaction action|token world wide|this wallet belongs/i;

export function isSpamCollectionTitle(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  if (n.length > 80) return true;
  if (/^[-_*\s.]+$/.test(n)) return true;
  if (SPAM.test(n)) return true;
  if (/^\*+\s*https?:/i.test(n)) return true;
  return false;
}

export function looksLikeContractName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  return /^0x[0-9a-fA-F]{12,}$/.test(n) || /^erc-?721$/i.test(n) || n === "..";
}
