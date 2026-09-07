/**
 * Server-side proxy for posting a client-signed Seaport offer to OpenSea's
 * real orderbook (POST /v2/orders/{chain}/seaport/offers) -- the OpenSea
 * key must never reach the client bundle, same reason every other
 * OpenSea-calling route here is server-side. The client
 * (lib/market/multichain/trading/foreign-offer.ts) does all of the actual
 * signing itself; this route only relays the already-signed order.
 */
import { NextRequest, NextResponse } from "next/server";
import { pickOpenSeaKey } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { publicError, rateLimit } from "@/lib/security";
import { FOREIGN_CHAINS, FOREIGN_SEAPORT_ADDRESS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { fungibleAmountWei, gateForeignTradeUsd } from "@/lib/market/multichain/trading/canary-limits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPENSEA = "https://api.opensea.io/api/v2";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-submit-offer", limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = (await req.json()) as {
      openSeaChain?: string;
      parameters?: unknown;
      signature?: string;
      protocol_address?: string;
    };
    if (!body.openSeaChain || !body.parameters || !body.signature || !body.protocol_address) {
      return NextResponse.json({ error: "openSeaChain, parameters, signature, and protocol_address are required" }, { status: 400 });
    }
    // Allowlist, not string-interpolate-and-hope: openSeaChain reaches this
    // route from the client (foreign-offer.ts), and was being spliced
    // straight into the request URL below with no validation -- a crafted
    // value could redirect this server's OpenSea-authenticated POST to an
    // arbitrary path/host-adjacent segment. Only a real, known chain slug
    // from FOREIGN_CHAINS is accepted. protocol_address is pinned to the
    // one real Seaport address this app trusts (FOREIGN_SEAPORT_ADDRESS)
    // rather than trusting the client's copy of it, for the same reason.
    const chain = FOREIGN_CHAINS.find((c) => c.openSeaChain === body.openSeaChain);
    if (!chain) {
      return NextResponse.json({ error: `"${body.openSeaChain}" is not a supported OpenSea chain` }, { status: 400 });
    }
    if (body.protocol_address !== FOREIGN_SEAPORT_ADDRESS) {
      return NextResponse.json({ error: "Unexpected protocol_address." }, { status: 400 });
    }

    // AUDIT lens 3 D7 (2026-09-06): a signed offer is a real WETH
    // commitment the moment OpenSea lists it (any seller can fill it), so
    // the bid amount is canary-gated per offerer wallet/day before relay.
    const params = body.parameters as { offerer?: unknown; offer?: Array<{ itemType: number | string; startAmount: string }> };
    const offerer = typeof params.offerer === "string" ? params.offerer : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(offerer) || !Array.isArray(params.offer)) {
      return NextResponse.json({ error: "parameters.offerer and parameters.offer are required" }, { status: 400 });
    }
    const gate = await gateForeignTradeUsd({
      wallet: offerer.toLowerCase(),
      venue: "opensea",
      chainSlug: chain.chainSlug,
      amountWei: fungibleAmountWei(params.offer),
      txRef: "offer",
    });
    if (gate) return NextResponse.json(gate.body, { status: gate.status });

    const key = (await pickOpenSeaKey("live"))?.apiKey ?? null;
    if (!key) {
      return NextResponse.json({ error: "OpenSea API key is not configured on this deployment." }, { status: 503 });
    }

    const res = await fetch(`${OPENSEA}/orders/${encodeURIComponent(body.openSeaChain)}/seaport/offers`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        parameters: body.parameters,
        signature: body.signature,
        protocol_address: body.protocol_address,
      }),
    });
    const responseBody = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: responseBody.slice(0, 500) }, { status: res.status });
    }
    return new NextResponse(responseBody, { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    return publicError(error, "Failed to submit offer");
  }
}
