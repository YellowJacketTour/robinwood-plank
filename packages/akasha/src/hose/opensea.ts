/**
 * OpenSea Stream is a venue feed. It may courier signed orders.
 * It may never create an Artifact or a Cluster.
 * Pinned by test.
 */
export type StreamKindAllowed = "courier_order" | "ignore";

export interface OpenSeaStreamEvent {
  event_type: string;
  payload: {
    collection?: { slug?: string; address?: string };
    item?: { nft_id?: string };
    order_hash?: string;
    protocol_data?: unknown;
  };
}

export interface CourierTicket {
  kind: "COURIER_ORDER";
  venue: "opensea";
  protocolData: unknown;
  orderHash?: string;
}

export function ingestOpenSeaStream(
  ev: OpenSeaStreamEvent,
): { artifactsCreated: 0; ticket: CourierTicket | undefined } {
  const hasOrder = !!(ev.payload.order_hash || ev.payload.protocol_data);
  if (!hasOrder) return { artifactsCreated: 0, ticket: undefined };
  return {
    artifactsCreated: 0,
    ticket: {
      kind: "COURIER_ORDER",
      venue: "opensea",
      protocolData: ev.payload.protocol_data,
      orderHash: ev.payload.order_hash,
    },
  };
}

export function assertNoArtifactWrite(): void {
  // Structural: this module does not import the archive writer.
}
