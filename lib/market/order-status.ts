import { Interface } from "ethers";
import { CHAIN, SEAPORT_ADDRESS } from "@/lib/constants";

/**
 * On-chain order liveness, read straight from Seaport.
 *
 * Why this exists: cancelling an order on-chain does not remove it from our
 * relay, so a cancelled listing kept showing in the book. Buyers would click
 * it, sign, and watch the transaction revert — which reads as a broken
 * marketplace and burns their gas.
 *
 * The obvious fix (a "delete my order" endpoint) would let anyone delete
 * anyone else's listing, so instead nothing is taken on trust: we ask Seaport
 * whether the order is actually dead, and only then drop it. That makes
 * removal unforgeable — a griefer cannot invalidate an order they don't own,
 * because they'd have to cancel it on-chain first, which only the offerer can
 * do.
 */

const SEAPORT_ABI = new Interface([
  "function getOrderHash((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter) order) view returns (bytes32)",
  "function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)",
  "function getCounter(address offerer) view returns (uint256)",
]);

type OrderComponentsLike = {
  offerer: string;
  zone?: string;
  offer: unknown[];
  consideration: unknown[];
  orderType?: number | string;
  startTime: string | number;
  endTime: string | number;
  zoneHash?: string;
  salt?: string | number;
  conduitKey?: string;
  counter?: string | number;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x" + "0".repeat(64);

async function ethCall(data: string): Promise<string | null> {
  try {
    const res = await fetch(CHAIN.rpcUrls.default, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: SEAPORT_ADDRESS, data }, "latest"],
      }),
      cache: "no-store",
    });
    const json = (await res.json()) as { result?: string; error?: unknown };
    return json.result ?? null;
  } catch {
    return null;
  }
}

export type OrderLiveness =
  | { known: true; dead: true; reason: "cancelled" | "filled" | "counter-advanced" }
  | { known: true; dead: false }
  /** RPC unavailable — caller must not treat this as permission to delete. */
  | { known: false };

/**
 * Ask Seaport whether an order can still be filled.
 *
 * Returns `known: false` on any RPC problem. Callers must fail closed on that:
 * an unreachable node is not evidence that an order is dead.
 */
export async function getOrderLiveness(rawOrder: unknown): Promise<OrderLiveness> {
  const order = rawOrder as { parameters?: OrderComponentsLike } | null;
  const p = order?.parameters;
  if (!p || !p.offerer) return { known: false };

  const components = {
    offerer: p.offerer,
    zone: p.zone ?? ZERO_ADDRESS,
    offer: p.offer ?? [],
    consideration: p.consideration ?? [],
    orderType: Number(p.orderType ?? 0),
    startTime: String(p.startTime ?? 0),
    endTime: String(p.endTime ?? 0),
    zoneHash: p.zoneHash ?? ZERO_HASH,
    salt: String(p.salt ?? 0),
    conduitKey: p.conduitKey ?? ZERO_HASH,
    counter: String(p.counter ?? 0),
  };

  let orderHash: string;
  try {
    const encoded = SEAPORT_ABI.encodeFunctionData("getOrderHash", [components]);
    const result = await ethCall(encoded);
    if (!result || result === "0x") return { known: false };
    [orderHash] = SEAPORT_ABI.decodeFunctionResult("getOrderHash", result) as unknown as [string];
  } catch {
    return { known: false };
  }

  try {
    const statusCall = SEAPORT_ABI.encodeFunctionData("getOrderStatus", [orderHash]);
    const statusRes = await ethCall(statusCall);
    if (!statusRes || statusRes === "0x") return { known: false };
    const [, isCancelled, totalFilled, totalSize] = SEAPORT_ABI.decodeFunctionResult(
      "getOrderStatus",
      statusRes
    ) as unknown as [boolean, boolean, bigint, bigint];

    if (isCancelled) return { known: true, dead: true, reason: "cancelled" };
    if (totalSize > BigInt(0) && totalFilled >= totalSize) {
      return { known: true, dead: true, reason: "filled" };
    }

    // A bulk cancel works by incrementing the offerer's counter, which
    // invalidates every order signed against the old one without touching
    // their individual statuses.
    const counterCall = SEAPORT_ABI.encodeFunctionData("getCounter", [p.offerer]);
    const counterRes = await ethCall(counterCall);
    if (counterRes && counterRes !== "0x") {
      const [current] = SEAPORT_ABI.decodeFunctionResult("getCounter", counterRes) as unknown as [bigint];
      if (current !== BigInt(components.counter)) {
        return { known: true, dead: true, reason: "counter-advanced" };
      }
    }

    return { known: true, dead: false };
  } catch {
    return { known: false };
  }
}
