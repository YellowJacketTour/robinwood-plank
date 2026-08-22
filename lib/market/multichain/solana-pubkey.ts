/** Base58 Solana pubkey / mint (no 0 O I l). ME symbols like Claynosaurz fail this. */
export function looksLikeSolanaPubkey(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}
