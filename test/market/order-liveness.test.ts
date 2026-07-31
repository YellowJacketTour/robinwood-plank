import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { getOrderLiveness } from "../../lib/market/order-status";
import { clearRpcCache } from "../../lib/market/rpc-cache";
import { SEAPORT_ADDRESS } from "../../lib/constants";

/**
 * Seaport's getOrderStatus reports an order "valid" long after it has become
 * unfillable: it knows nothing about whether the offerer still holds the token
 * or still approves Seaport to move it. Measured on production 2026-07-31,
 * 9 of 29 live listings (31%) were unfillable for exactly that reason — sellers
 * who had moved the token on. Every one of them rendered a working-looking Buy
 * button that reverted.
 */

const SEAPORT_IFACE = new Interface([
  "function getOrderHash((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter) order) view returns (bytes32)",
  "function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)",
  "function getCounter(address offerer) view returns (uint256)",
]);
const ERC721_IFACE = new Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function getApproved(uint256 tokenId) view returns (address)",
]);

const SELLER = "0x1111111111111111111111111111111111111111";
const SOMEONE_ELSE = "0x2222222222222222222222222222222222222222";
const NFT = "0x3333333333333333333333333333333333333333";
const ORDER_HASH = `0x${"ab".repeat(32)}`;

function order() {
  return {
    parameters: {
      offerer: SELLER,
      zone: "0x0000000000000000000000000000000000000000",
      offer: [
        {
          itemType: 2, // ERC-721
          token: NFT,
          identifierOrCriteria: "42",
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [],
      orderType: 0,
      startTime: "0",
      endTime: "9999999999",
      zoneHash: `0x${"0".repeat(64)}`,
      salt: "1",
      conduitKey: `0x${"0".repeat(64)}`,
      counter: "0",
    },
    signature: "0x",
  };
}

type Stub = {
  owner?: string;
  approvedForAll?: boolean;
  approvedOne?: string;
  /** Make ownerOf look like an unreachable node rather than a revert. */
  ownerOfUnreachable?: boolean;
};

function stubChain(s: Stub) {
  const original = globalThis.fetch;
  // Liveness reads now go through ethCallFree, which coalesces via rpc-cache.
  // That is exactly what we want in production — one pass asks the same
  // getCounter for the same offerer over and over — but between tests it would
  // serve the previous case's owner and quietly invert the assertion.
  clearRpcCache();
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      params?: Array<{ to?: string; data?: string }>;
    };
    const to = (body.params?.[0]?.to ?? "").toLowerCase();
    const data = body.params?.[0]?.data ?? "";
    const reply = (result: string) => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result }),
    });

    if (to === SEAPORT_ADDRESS.toLowerCase()) {
      if (data.startsWith(SEAPORT_IFACE.getFunction("getOrderHash")!.selector)) {
        return reply(ORDER_HASH);
      }
      if (data.startsWith(SEAPORT_IFACE.getFunction("getOrderStatus")!.selector)) {
        // validated, not cancelled, nothing filled
        return reply(
          SEAPORT_IFACE.encodeFunctionResult("getOrderStatus", [true, false, 0n, 0n])
        );
      }
      if (data.startsWith(SEAPORT_IFACE.getFunction("getCounter")!.selector)) {
        return reply(SEAPORT_IFACE.encodeFunctionResult("getCounter", [0n]));
      }
    }

    if (to === NFT.toLowerCase()) {
      if (data.startsWith(ERC721_IFACE.getFunction("ownerOf")!.selector)) {
        if (s.ownerOfUnreachable) throw new Error("network down");
        return reply(ERC721_IFACE.encodeFunctionResult("ownerOf", [s.owner ?? SELLER]));
      }
      if (data.startsWith(ERC721_IFACE.getFunction("isApprovedForAll")!.selector)) {
        return reply(
          ERC721_IFACE.encodeFunctionResult("isApprovedForAll", [s.approvedForAll ?? true])
        );
      }
      if (data.startsWith(ERC721_IFACE.getFunction("getApproved")!.selector)) {
        return reply(
          ERC721_IFACE.encodeFunctionResult("getApproved", [
            s.approvedOne ?? "0x0000000000000000000000000000000000000000",
          ])
        );
      }
    }

    return reply("0x");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return () => {
    globalThis.fetch = original;
  };
}

test("a listing whose seller still owns and approves is live", async () => {
  const restore = stubChain({ owner: SELLER, approvedForAll: true });
  try {
    assert.deepEqual(await getOrderLiveness(order()), { known: true, dead: false });
  } finally {
    restore();
  }
});

test("a listing whose seller no longer owns the token is dead", async () => {
  const restore = stubChain({ owner: SOMEONE_ELSE, approvedForAll: true });
  try {
    const liveness = await getOrderLiveness(order());
    assert.equal(liveness.known, true);
    assert.equal(liveness.known && liveness.dead, true);
    assert.equal(liveness.known && liveness.dead && liveness.reason, "not-owned");
  } finally {
    restore();
  }
});

test("a listing whose seller revoked approval is dead", async () => {
  const restore = stubChain({
    owner: SELLER,
    approvedForAll: false,
    approvedOne: "0x0000000000000000000000000000000000000000",
  });
  try {
    const liveness = await getOrderLiveness(order());
    assert.equal(liveness.known && liveness.dead, true);
  } finally {
    restore();
  }
});

test("a per-token approval to Seaport still counts as fillable", async () => {
  const restore = stubChain({
    owner: SELLER,
    approvedForAll: false,
    approvedOne: SEAPORT_ADDRESS,
  });
  try {
    assert.deepEqual(await getOrderLiveness(order()), { known: true, dead: false });
  } finally {
    restore();
  }
});

test("an unreadable chain never hides a listing", async () => {
  // Failing open matters more than failing closed here: wrongly hiding a good
  // listing costs the seller a sale, and an RPC blip is not evidence.
  const restore = stubChain({ ownerOfUnreachable: true });
  try {
    assert.deepEqual(await getOrderLiveness(order()), { known: true, dead: false });
  } finally {
    restore();
  }
});
