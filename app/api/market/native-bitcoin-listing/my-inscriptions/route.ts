/**
 * Real inscriptions owned by a connected wallet, for
 * NativeBitcoinListingsPanel's "pick from your own inscriptions" flow --
 * keeps UNISAT_TESTNET_API_KEY/UNISAT_API_KEY off the client, same reason
 * every other UniSat-indexer call in this app goes through a route (see
 * bitcoin-utxo-safety.ts's own requireApiKey). Built 2026-08-20 to remove
 * the friction of hand-typing a raw inscription txid/vout/value.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchWalletInscriptions } from "@/lib/market/multichain/trading/bitcoin-utxo-safety";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-native-bitcoin-listing-my-inscriptions", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const address = req.nextUrl.searchParams.get("address");
  if (!address) {
    return NextResponse.json({ error: "address query param is required" }, { status: 400 });
  }

  try {
    const inscriptions = await fetchWalletInscriptions(address);
    return NextResponse.json({ inscriptions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to load your inscriptions");
  }
}
