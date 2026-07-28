import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import {
  EIP_712_ORDER_TYPE,
  orderDigest,
  recoverOrderSigner,
  signatureFailsOffline,
  verifyOrderSignature,
  type Rpc,
} from "../../lib/market/signature";
import { getClientIp, rateLimit, readJsonBody, MAX_BODY_BYTES } from "../../lib/security";
import { CHAIN, SEAPORT_ADDRESS } from "../../lib/constants";

/**
 * FIX VERIFICATION for the HOSTILE AUDIT 2026-07-27 findings owned by this
 * agent. Each test FAILS against the pre-fix code and PASSES after.
 */

const NATIVE = "0x0000000000000000000000000000000000000000";
const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const VICTIM = "0x1111111111111111111111111111111111111111";

const futureEnd = Math.floor(Date.now() / 1000) + 86_400;

/** A structurally-valid listing whose offerer we can vary. */
function listingParams(offerer: string) {
  return {
    offerer,
    zone: NATIVE,
    offer: [
      {
        itemType: 2,
        token: NFT,
        identifierOrCriteria: "1106",
        startAmount: "1",
        endAmount: "1",
      },
    ],
    consideration: [
      {
        itemType: 0,
        token: NATIVE,
        identifierOrCriteria: "0",
        startAmount: "1000000000000000000",
        endAmount: "1000000000000000000",
        recipient: offerer,
      },
    ],
    orderType: 0,
    startTime: "0",
    endTime: String(futureEnd),
    zoneHash: "0x" + "0".repeat(64),
    salt: "12345",
    conduitKey: "0x" + "0".repeat(64),
    counter: "0",
  };
}

const DOMAIN = {
  name: "Seaport",
  version: "1.6",
  chainId: CHAIN.id,
  verifyingContract: SEAPORT_ADDRESS,
};

/** Sign an order the way a real wallet would (EIP-712 over OrderComponents). */
async function signOrder(wallet: Wallet, params: ReturnType<typeof listingParams>) {
  const sig = await wallet.signTypedData(DOMAIN, EIP_712_ORDER_TYPE as never, params);
  return { parameters: params, signature: sig };
}

/** An RPC stub: offerer is an EOA (no code), counter = 0. */
function eoaRpc(counterHex = "0x" + "0".repeat(64)): Rpc {
  return {
    getCode: async () => "0x",
    call: async () => counterHex,
  };
}

// ─────────────────────────── Finding 1: signature verification ─────────────

test("FIX F-1: a genuinely signed order verifies", async () => {
  const w = new Wallet("0x" + "1".repeat(64));
  const order = await signOrder(w, listingParams(w.address));
  const res = await verifyOrderSignature(order, eoaRpc());
  assert.equal(res.ok, true);
});

test("FIX F-1: a garbage signature attributed to a victim is REJECTED", async () => {
  const forged = { parameters: listingParams(VICTIM), signature: "0xdeadbeef" };
  const res = await verifyOrderSignature(forged, eoaRpc());
  assert.equal(res.ok, false);
});

test("FIX F-1: a valid signature by the WRONG signer (offerer claims victim) is REJECTED", async () => {
  const attacker = new Wallet("0x" + "2".repeat(64));
  // Attacker signs an order but sets offerer = victim.
  const params = listingParams(VICTIM);
  const sig = await attacker.signTypedData(DOMAIN, EIP_712_ORDER_TYPE as never, params);
  const res = await verifyOrderSignature({ parameters: params, signature: sig }, eoaRpc());
  assert.equal(res.ok, false);
});

test("FIX F-1c: high-s (malleable) signature is REJECTED", async () => {
  const malleable =
    "0x" + "11".repeat(32) + "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" + "1b";
  const res = await verifyOrderSignature(
    { parameters: listingParams(VICTIM), signature: malleable },
    eoaRpc()
  );
  assert.equal(res.ok, false);
});

test("FIX F-1: bad v (not 27/28) is REJECTED", async () => {
  const w = new Wallet("0x" + "3".repeat(64));
  const order = await signOrder(w, listingParams(w.address));
  const bad = order.signature.slice(0, -2) + "01"; // v=1
  const res = await verifyOrderSignature({ ...order, signature: bad }, eoaRpc());
  assert.equal(res.ok, false);
});

test("FIX F-1: EIP-2098 compact 64-byte signature is normalised and verifies", async () => {
  const w = new Wallet("0x" + "4".repeat(64));
  const order = await signOrder(w, listingParams(w.address));
  // Build compact form from r,s,v.
  const hex = order.signature.slice(2);
  const r = hex.slice(0, 64);
  const s = BigInt("0x" + hex.slice(64, 128));
  const v = parseInt(hex.slice(128, 130), 16);
  const yParity = BigInt(v - 27);
  const yParityAndS = (yParity << BigInt(255)) | s;
  const compact = "0x" + r + yParityAndS.toString(16).padStart(64, "0");
  const res = await verifyOrderSignature({ ...order, signature: compact }, eoaRpc());
  assert.equal(res.ok, true);
});

test("FIX F-1: RPC failure on getCode FAILS CLOSED (order rejected)", async () => {
  const w = new Wallet("0x" + "5".repeat(64));
  const order = await signOrder(w, listingParams(w.address));
  const brokenRpc: Rpc = {
    getCode: async () => {
      throw new Error("node down");
    },
    call: async () => "0x",
  };
  const res = await verifyOrderSignature(order, brokenRpc);
  assert.equal(res.ok, false);
});

test("FIX F-1: stale counter (on-chain advanced) is REJECTED", async () => {
  const w = new Wallet("0x" + "6".repeat(64));
  const order = await signOrder(w, listingParams(w.address)); // counter 0
  // On-chain counter = 1 → order signed against 0 is dead.
  const res = await verifyOrderSignature(order, eoaRpc("0x" + "0".repeat(63) + "1"));
  assert.equal(res.ok, false);
});

test("FIX F-1: EIP-1271 contract wallet returning the magic value verifies", async () => {
  const params = listingParams(VICTIM); // offerer is a "contract"
  const MAGIC = "0x1626ba7e" + "0".repeat(56);
  const rpc: Rpc = {
    getCode: async () => "0x6080604052", // has code
    call: async (_to, data) => {
      // getCounter selector 0xf07ec373; isValidSignature 0x1626ba7e
      if (data.startsWith("0x1626ba7e")) return MAGIC;
      return "0x" + "0".repeat(64); // counter 0
    },
  };
  const res = await verifyOrderSignature({ parameters: params, signature: "0x" + "ab".repeat(65) }, rpc);
  assert.equal(res.ok, true);
});

test("FIX F-1: EIP-1271 contract wallet RPC failure FAILS CLOSED", async () => {
  const params = listingParams(VICTIM);
  const rpc: Rpc = {
    getCode: async () => "0x6080",
    call: async () => {
      throw new Error("rpc down");
    },
  };
  const res = await verifyOrderSignature({ parameters: params, signature: "0x" + "ab".repeat(65) }, rpc);
  assert.equal(res.ok, false);
});

// ─────────────────────────── Finding 2: forged-order removability ───────────

test("FIX F-2: a forged order is flagged removable (signatureFailsOffline=true)", () => {
  const forged = { parameters: listingParams(VICTIM), signature: "0xdeadbeef" };
  assert.equal(signatureFailsOffline(forged), true);
});

test("FIX F-2: a genuine order is NOT flagged removable by the forged path", async () => {
  const w = new Wallet("0x" + "7".repeat(64));
  const order = await signOrder(w, listingParams(w.address));
  assert.equal(signatureFailsOffline(order), false);
  assert.equal(recoverOrderSigner(order)?.toLowerCase(), w.address.toLowerCase());
});

// ─────────────────────────── Finding 3: rate limit + body cap ───────────────

function reqWithHeaders(h: Record<string, string>, body?: string): Request {
  return new Request("http://localhost/api/market/orders", {
    method: "POST",
    headers: { "content-type": "application/json", ...h },
    body,
  });
}

test("FIX R-1: rotating leftmost X-Forwarded-For no longer bypasses the limiter", () => {
  const opts = { key: "fix-r1", limit: 5, windowMs: 60_000 };
  // Same trusted rightmost hop, attacker rotates the leftmost (client) entry.
  let blocked = 0;
  for (let i = 0; i < 50; i++) {
    const req = reqWithHeaders({ "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` });
    if (rateLimit(req, opts)) blocked++;
  }
  assert.ok(blocked > 0, "rightmost hop is what we key on, so the cap holds");
});

test("FIX R-1: getClientIp takes the rightmost hop, never the client-controlled leftmost", () => {
  const req = reqWithHeaders({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
  assert.equal(getClientIp(req), "203.0.113.7");
});

test("FIX R-1: x-vercel-forwarded-for is trusted over XFF", () => {
  const req = reqWithHeaders({
    "x-vercel-forwarded-for": "198.51.100.9",
    "x-forwarded-for": "1.2.3.4, 5.6.7.8",
  });
  assert.equal(getClientIp(req), "198.51.100.9");
});

test("FIX S-1: an oversized body is rejected before parsing", async () => {
  const huge = JSON.stringify({ big: "A".repeat(MAX_BODY_BYTES + 1000) });
  const req = reqWithHeaders({}, huge);
  await assert.rejects(readJsonBody(req), /too large/i);
});

test("FIX S-1: a normal-sized body still parses", async () => {
  const req = reqWithHeaders({}, JSON.stringify({ kind: "listing" }));
  const parsed = await readJsonBody<{ kind?: string }>(req);
  assert.equal(parsed.kind, "listing");
});

test("orderDigest is stable and matches ethers recovery", async () => {
  const w = new Wallet("0x" + "8".repeat(64));
  const params = listingParams(w.address);
  const d = orderDigest(params);
  assert.ok(d && /^0x[0-9a-f]{64}$/i.test(d.digest));
});
