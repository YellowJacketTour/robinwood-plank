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

/**
 * The isolation boundary, checked rather than asserted in a comment.
 *
 * A venue feed that can mint artifacts is a venue that can invent collections
 * in our archive, and a stream event is not a chain event: it is unsigned,
 * unwitnessed, and retractable. So this module is forbidden from reaching the
 * writer at all, and the ban is enforced by reading its own source instead of
 * trusting a reviewer to notice a new import.
 *
 * `readSource` is injected so the test supplies the file bytes; the runtime
 * has no filesystem dependency.
 */
export const FORBIDDEN_IMPORTS = ["./store.ts", "../hose/store.ts", "./coverage.ts"];

export function assertNoArtifactWrite(readSource: () => string): void {
  const src = readSource();
  for (const banned of FORBIDDEN_IMPORTS) {
    if (src.includes(`from "${banned}"`)) {
      throw new Error(
        `opensea.ts imports ${banned}: a venue feed may courier signed orders but may ` +
          `never create an Artifact or Cluster -- stream events carry no chain witness`
      );
    }
  }
  // A writer CALL, not a mention. This check reads its own source, and the
  // message below names the writers, so a bare substring scan would flag this
  // very function and make the guard permanently red.
  if (/\.\s*(putArtifact|putEvent|putCoverage|putCursor)\s*\(/.test(src)) {
    throw new Error("opensea.ts references an archive writer");
  }
}
