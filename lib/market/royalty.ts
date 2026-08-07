/**
 * Royalty configuration shared by the marketplace builder, validator, and
 * sales catalog. The contract remains the authority; these values are the
 * expected EIP-2981 result used to fail closed when a deployment changes.
 */
export const ROBINWOOD_ROYALTY_BPS = 810;
export const ROBINWOOD_ROYALTY_RECEIVER =
  "0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d";

export type RoyaltyConfig = {
  bps: number;
  receiver: string;
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ROYALTY_INFO_SELECTOR = "0x2a55205a";
export const ROYALTY_PROBE_PRICE_WEI = BigInt("1000000000000000000");

export function encodeRoyaltyInfo(tokenId: string, salePriceWei: bigint): string {
  return (
    ROYALTY_INFO_SELECTOR +
    BigInt(tokenId).toString(16).padStart(64, "0") +
    salePriceWei.toString(16).padStart(64, "0")
  );
}

export function decodeRoyaltyInfo(raw: string): { receiver: string; amountWei: bigint } {
  const body = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (body.length < 128) throw new Error("royaltyInfo returned a short response.");
  const receiver = `0x${body.slice(24, 64)}`.toLowerCase();
  const amountWei = BigInt(`0x${body.slice(64, 128)}`);
  if (!/^0x[0-9a-f]{40}$/.test(receiver) || receiver === ZERO_ADDRESS) {
    throw new Error("royaltyInfo returned no receiver.");
  }
  return { receiver, amountWei };
}

export function bpsFromRoyaltyAmount(amountWei: bigint, salePriceWei: bigint): number {
  if (salePriceWei <= BigInt(0) || amountWei <= BigInt(0)) {
    throw new Error("royaltyInfo returned a non-positive royalty.");
  }
  const scaled = amountWei * BigInt(10_000);
  const bps = Number(scaled / salePriceWei);
  if (!Number.isSafeInteger(bps) || bps <= 0 || bps > 10_000) {
    throw new Error(`royaltyInfo returned implausible bps ${bps}.`);
  }
  return bps;
}

export function assertRoyaltyConfig(config: RoyaltyConfig): RoyaltyConfig {
  if (!Number.isInteger(config.bps) || config.bps <= 0 || config.bps > 10_000) {
    throw new Error("Royalty rate must be a whole number of basis points between 1 and 10000.");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.receiver) || config.receiver.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("Royalty receiver is not a valid non-zero address.");
  }
  return { bps: config.bps, receiver: config.receiver.toLowerCase() };
}
