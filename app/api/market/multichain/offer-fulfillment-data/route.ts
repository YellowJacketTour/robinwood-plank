/**
 * Server-side proxy for OpenSea's real offer fulfillment-data endpoint
 * (POST /v2/offers/fulfillment_data, confirmed live 2026-08-18 via a real
 * "Order not found" error for a fake hash -- proves the request shape is
 * right, not a guess). Same reason every OpenSea-calling route here is
 * server-side: the API key must never reach the client bundle.
 *
 * Mirrors fetchListingFulfillmentData's own reasoning
 * (foreign-orders.ts): the summary/display offer data carries no usable
 * signature, so accepting an offer needs this separate, fulfiller-specific
 * call immediately before building the transaction.
 *
 * AUDIT lens 3 #5 / lens 2 #5 + RESEARCH R3 (5) (2026-09-06): criteria
 * (collection-wide / trait) offers are fulfillable ONLY with the criteria
 * resolvers OpenSea computes -- proofs for a non-zero root cannot be built
 * client-side. So this route now POSTs `consideration: {asset_contract_address,
 * token_id}` (OpenSea validates the seller's token against the criteria)
 * and returns OpenSea's own `fulfillment_data.transaction`
 * ({function, to, value, input_data}) next to the raw order; the client
 * (acceptForeignOffer) sends that calldata verbatim after asserting `to`
 * is Seaport and the value/price match what the user was shown.
 *
 * AUDIT lens 3 D7: the seller's side of an accept is a real foreign-chain
 * send, so it is canary-gated per wallet/day on the bid amount.
 */
import { NextRequest, NextResponse } from "next/server";
import { foreignChainByChainSlug, FOREIGN_SEAPORT_ADDRESS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { pickOpenSeaKey } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { fungibleAmountWei, gateForeignTradeUsd } from "@/lib/market/multichain/trading/canary-limits";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type OpenSeaFulfillmentTransaction = {
  function: string;
  chain: number;
  to: string;
  value: number | string;
  input_data: unknown;
};

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-offer-fulfillment", limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = (await req.json()) as {
      chainSlug?: string;
      orderHash?: string;
      fulfillerAddress?: string;
      tokenId?: string;
      /** The NFT contract the seller delivers -- required with tokenId for criteria offers (OpenSea's consideration.asset_contract_address). */
      contractAddress?: string;
    };
    if (!body.chainSlug || !body.orderHash || !body.fulfillerAddress) {
      return NextResponse.json({ error: "chainSlug, orderHash, and fulfillerAddress are required" }, { status: 400 });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.fulfillerAddress)) {
      return NextResponse.json({ error: "fulfillerAddress must be an EVM address" }, { status: 400 });
    }
    if (body.tokenId && !/^\d+$/.test(body.tokenId)) {
      return NextResponse.json({ error: "tokenId must be a decimal token id" }, { status: 400 });
    }
    if (body.contractAddress && !/^0x[0-9a-fA-F]{40}$/.test(body.contractAddress)) {
      return NextResponse.json({ error: "contractAddress must be an EVM address" }, { status: 400 });
    }
    const chain = foreignChainByChainSlug(body.chainSlug);
    if (!chain) {
      return NextResponse.json({ error: `"${body.chainSlug}" is not a supported foreign chain` }, { status: 400 });
    }
    // No OpenSea orderbook for this chain (zkSync today) -- an order hash
    // claiming to be fulfillable here can only be a caller bug, since no
    // OpenSea order could ever legitimately reference this chain.
    if (!chain.openSeaChain) {
      return NextResponse.json({ error: `"${body.chainSlug}" has no OpenSea orderbook.` }, { status: 400 });
    }

    const key = (await pickOpenSeaKey("live"))?.apiKey ?? null;
    if (!key) {
      return NextResponse.json({ error: "OpenSea API key is not configured on this deployment." }, { status: 503 });
    }

    const res = await fetch("https://api.opensea.io/api/v2/offers/fulfillment_data", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        offer: { hash: body.orderHash, chain: chain.openSeaChain, protocol_address: FOREIGN_SEAPORT_ADDRESS },
        fulfiller: { address: body.fulfillerAddress },
        ...(body.tokenId
          ? {
              consideration: {
                ...(body.contractAddress ? { asset_contract_address: body.contractAddress } : {}),
                token_id: body.tokenId,
              },
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return NextResponse.json({ error: errText.slice(0, 300) }, { status: res.status });
    }
    const data = (await res.json()) as {
      fulfillment_data: {
        transaction?: OpenSeaFulfillmentTransaction;
        orders: Array<{ parameters: { offer: Array<{ itemType: number | string; startAmount: string }> }; signature: string }>;
      };
    };
    const order = data.fulfillment_data.orders[0];
    if (!order) {
      return NextResponse.json({ error: "No fulfillable order returned." }, { status: 404 });
    }
    const transaction = data.fulfillment_data.transaction ?? null;
    if (!transaction || !transaction.to || !transaction.function) {
      return NextResponse.json({ error: "OpenSea returned no fulfillment transaction for this offer." }, { status: 502 });
    }

    // Canary gate on the bid amount (what the seller receives, gross).
    const bidWei = fungibleAmountWei(order.parameters.offer ?? []);
    const gate = await gateForeignTradeUsd({
      wallet: body.fulfillerAddress.toLowerCase(),
      venue: "opensea",
      chainSlug: body.chainSlug,
      amountWei: bidWei,
      txRef: `accept:${body.orderHash}`,
    });
    if (gate) return NextResponse.json(gate.body, { status: gate.status });

    return NextResponse.json(
      {
        parameters: order.parameters,
        signature: order.signature,
        transaction,
        protocolAddress: FOREIGN_SEAPORT_ADDRESS,
        bidWei: bidWei.toString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return publicError(error, "Failed to fetch offer fulfillment data");
  }
}
