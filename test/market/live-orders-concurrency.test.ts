import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { splitLiveOrders } from "../../lib/market/order-status";
import { clearRpcCache } from "../../lib/market/rpc-cache";
import { SEAPORT_ADDRESS } from "../../lib/constants";

/**
 * splitLiveOrders used to await each order in a plain sequential loop. Each
 * check makes up to five chained eth_calls, so ~72 listings meant ~300 serial
 * round-trips — 12.2s on a cold process in production, close enough to a proxy
 * timeout that a slow RPC took the whole order book down.
 *
 * It now runs a bounded worker pool. These tests pin the properties that a
 * concurrency change is most likely to break, with MORE ORDERS THAN THE POOL
 * SIZE so the pool actually cycles.
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

function rawOrder(tokenId: number) {
  return {
    parameters: {
      offerer: SELLER,
      zone: "0x0000000000000000000000000000000000000000",
      offer: [
        {
          itemType: 2,
          token: NFT,
          identifierOrCriteria: String(tokenId),
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: "0x0000000000000000000000000000000000000000",
          identifierOrCriteria: "0",
          startAmount: "1000",
          endAmount: "1000",
          recipient: SELLER,
        },
      ],
      orderType: 0,
      startTime: "0",
      endTime: String(Math.floor(Date.now() / 1000) + 86_400),
      zoneHash: `0x${"00".repeat(32)}`,
      salt: String(tokenId),
      conduitKey: `0x${"00".repeat(32)}`,
      counter: "0",
    },
    signature: "0x",
  };
}

/** Chain where every seller either still holds the token, or never does. */
function stubChain(opts: { owner: string; delayMs?: number }) {
  const original = globalThis.fetch;
  clearRpcCache();
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    // A varying delay makes completion order differ from input order, which
    // is the whole point — a pool that returned results in completion order
    // would scramble the book and this would catch it.
    if (opts.delayMs) {
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * opts.delayMs)));
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      params?: Array<{ to?: string; data?: string }>;
    };
    const to = (body.params?.[0]?.to ?? "").toLowerCase();
    const data = body.params?.[0]?.data ?? "";
    const reply = (result: string) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });

    if (to === SEAPORT_ADDRESS.toLowerCase()) {
      if (data.startsWith(SEAPORT_IFACE.getFunction("getOrderHash")!.selector)) {
        return reply(`0x${"ab".repeat(32)}`);
      }
      if (data.startsWith(SEAPORT_IFACE.getFunction("getOrderStatus")!.selector)) {
        return reply(SEAPORT_IFACE.encodeFunctionResult("getOrderStatus", [true, false, 0n, 0n]));
      }
      if (data.startsWith(SEAPORT_IFACE.getFunction("getCounter")!.selector)) {
        return reply(SEAPORT_IFACE.encodeFunctionResult("getCounter", [0n]));
      }
    }
    if (to === NFT.toLowerCase()) {
      if (data.startsWith(ERC721_IFACE.getFunction("ownerOf")!.selector)) {
        return reply(ERC721_IFACE.encodeFunctionResult("ownerOf", [opts.owner]));
      }
      if (data.startsWith(ERC721_IFACE.getFunction("isApprovedForAll")!.selector)) {
        return reply(ERC721_IFACE.encodeFunctionResult("isApprovedForAll", [true]));
      }
      if (data.startsWith(ERC721_IFACE.getFunction("getApproved")!.selector)) {
        return reply(
          ERC721_IFACE.encodeFunctionResult("getApproved", [
            "0x0000000000000000000000000000000000000000",
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

/** 20 orders — comfortably more than the pool size, so the pool cycles. */
function book() {
  return Array.from({ length: 20 }, (_, i) => ({
    id: `listing-${i}`,
    rawOrder: rawOrder(1000 + i),
  }));
}

test("live orders come back in input order, not completion order", async () => {
  // The pool is smaller than the book and the stub finishes out of order, so
  // a result array built by push-on-completion would scramble here.
  const restore = stubChain({ owner: SELLER, delayMs: 8 });
  try {
    const items = book();
    const { live, dead } = await splitLiveOrders(items);
    assert.equal(dead.length, 0);
    assert.equal(live.length, items.length);
    assert.deepEqual(
      live.map((l) => l.id),
      items.map((i) => i.id),
      "the book must not reshuffle just because checks finished out of order"
    );
  } finally {
    restore();
  }
});

test("dead orders are all detected, and also keep input order", async () => {
  // Seller no longer holds the token, so every order is provably unfillable.
  const restore = stubChain({ owner: SOMEONE_ELSE, delayMs: 8 });
  try {
    const items = book().map((it, i) => ({ ...it, id: `dead-${i}` }));
    const { live, dead } = await splitLiveOrders(items);
    assert.equal(live.length, 0, "none of these can be filled");
    assert.equal(dead.length, items.length, "a pooled check must not skip any order");
    assert.deepEqual(
      dead.map((d) => d.item.id),
      items.map((i) => i.id)
    );
    assert.ok(dead.every((d) => typeof d.reason === "string" && d.reason.length > 0));
  } finally {
    restore();
  }
});

test("an empty book does not hang the pool", async () => {
  // The worker count is min(CONCURRENCY, items.length); zero items must
  // produce zero workers rather than six that spin.
  const { live, dead } = await splitLiveOrders([]);
  assert.deepEqual(live, []);
  assert.deepEqual(dead, []);
});
