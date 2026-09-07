/**
 * OKX Onchain OS -- Ordinals marketplace listing reader (2026-09-06, AUDIT
 * Batch E4-bitcoin). The signed-request client lives in
 * adapters/okx-ordinals.ts (web3.okx.com/onchainos/docs/waas/marketplace-
 * ordinals-api; OK-ACCESS-KEY/SIGN/TIMESTAMP/PASSPHRASE). This module adds
 * the one thing the listings route needs and the raw adapter does not
 * express: WHY a result is empty. `credential-missing` (no
 * OKX_API_KEY/OKX_API_SECRET/OKX_API_PASSPHRASE), `queried` (a real
 * response, possibly a genuinely empty book), or `upstream-error`. The
 * hub's bookCoverage.sources labels read these states verbatim so "no key"
 * is never rendered as "no listings".
 */
import { fetchOkxCollectionStats, fetchOkxOrdinalsListings, type OkxCollectionStats, type OkxListing } from "@/lib/market/multichain/adapters/okx-ordinals";

export type OkxReadState = "credential-missing" | "queried" | "upstream-error";

export function okxCredentialState(env: NodeJS.ProcessEnv = process.env): "credential-missing" | "ready" {
  return env.OKX_API_KEY && env.OKX_API_SECRET && env.OKX_API_PASSPHRASE ? "ready" : "credential-missing";
}

export async function readOkxOrdinalsListings(collectionSlug: string, limit = 50): Promise<{ state: OkxReadState; listings: OkxListing[] }> {
  if (okxCredentialState() === "credential-missing") return { state: "credential-missing", listings: [] };
  try {
    return { state: "queried", listings: await fetchOkxOrdinalsListings(collectionSlug, limit) };
  } catch {
    return { state: "upstream-error", listings: [] };
  }
}

export async function readOkxCollectionStats(collectionSlug: string): Promise<{ state: OkxReadState; stats: OkxCollectionStats | null }> {
  if (okxCredentialState() === "credential-missing") return { state: "credential-missing", stats: null };
  try {
    return { state: "queried", stats: await fetchOkxCollectionStats(collectionSlug) };
  } catch {
    return { state: "upstream-error", stats: null };
  }
}
