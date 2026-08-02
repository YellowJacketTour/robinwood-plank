import { Interface, TypedDataEncoder, recoverAddress } from "ethers";
import { CHAIN, SEAPORT_ADDRESS } from "@/lib/constants";
import { SERVER_RPC_URLS } from "@/lib/server/rpc-urls";

/**
 * Seaport 1.6 order-signature verification — the control that was entirely
 * missing (HOSTILE AUDIT 2026-07-27, finding F-1/F-2).
 *
 * Before this file existed the relay accepted ANY order whose displayed fields
 * were internally consistent, regardless of whether the claimed `offerer`
 * actually signed it. A forged listing with signature "0xdeadbeef" and a
 * victim's address as offerer was stored and served publicly. This module
 * recomputes the exact EIP-712 digest Seaport itself would sign, recovers the
 * signer, and refuses anything that does not verify.
 *
 * DESIGN: FAIL CLOSED. Every ambiguous or unreachable condition rejects. An
 * order is admitted only on positive proof of a valid signature by the offerer
 * (EOA ecrecover, or EIP-1271 magic value for contract wallets) AND a matching
 * on-chain counter. A missing RPC is never treated as permission.
 */

/** Canonical Seaport 1.6 EIP-712 struct, copied verbatim from
 * @opensea/seaport-js/lib/constants.js (EIP_712_ORDER_TYPE) so the digest is
 * byte-identical to what a real wallet signed. Do not hand-edit. */
export const EIP_712_ORDER_TYPE = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
} as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x" + "0".repeat(64);

/** secp256k1 curve order and its half — reject high-s to block signature
 * malleability (EIP-2 / homestead rule). */
const SECP256K1N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
);
const SECP256K1N_HALF = SECP256K1N / BigInt(2);

const EIP1271_MAGIC = "0x1626ba7e";

const IFACE = new Interface([
  "function getCounter(address offerer) view returns (uint256)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

/**
 * How the module talks to the chain. Injectable so tests drive it without a
 * live node, and so a missing implementation deterministically FAILS CLOSED.
 */
export type Rpc = {
  /** eth_getCode(address) → hex ("0x" for an EOA). */
  getCode(address: string): Promise<string>;
  /** eth_call to a contract, returns hex result. */
  call(to: string, data: string): Promise<string>;
};

export type VerifyResult =
  | { ok: true }
  // `transient: true` marks a failure caused by not being able to reach the
  // chain (RPC down, undecodable response) rather than a genuine defect in
  // the order. The two must never be conflated: for ADMITTING a new order,
  // fail-closed correctly means "reject on transient failure too" (see
  // POST). For DELETING an existing one, fail-closed means the opposite —
  // an RPC hiccup must never be grounds to purge a listing that may be
  // perfectly valid. Callers that remove orders on `ok: false` MUST check
  // `!transient` first.
  | { ok: false; reason: string; transient?: boolean };

function normalizedSignature(sig: unknown): { r: string; s: string; v: number; serialized: string } | null {
  if (typeof sig !== "string") return null;
  if (!/^0x[0-9a-fA-F]+$/.test(sig)) return null;
  const hex = sig.slice(2);

  let r: string;
  let sHex: string;
  let v: number;

  if (hex.length === 130) {
    // 65-byte r||s||v
    r = "0x" + hex.slice(0, 64);
    sHex = "0x" + hex.slice(64, 128);
    v = parseInt(hex.slice(128, 130), 16);
  } else if (hex.length === 128) {
    // EIP-2098 compact 64-byte: r || yParityAndS
    r = "0x" + hex.slice(0, 64);
    const yParityAndS = BigInt("0x" + hex.slice(64, 128));
    const yParity = Number((yParityAndS >> BigInt(255)) & BigInt(1));
    const sVal = yParityAndS & ((BigInt(1) << BigInt(255)) - BigInt(1));
    sHex = "0x" + sVal.toString(16).padStart(64, "0");
    v = 27 + yParity;
  } else {
    return null;
  }

  const sVal = BigInt(sHex);
  // Reject high-s (malleable). Fail closed.
  if (sVal > SECP256K1N_HALF || sVal === BigInt(0)) return null;
  if (BigInt(r) === BigInt(0)) return null;
  // Reject v outside {27,28}.
  if (v !== 27 && v !== 28) return null;

  const serialized = r + sHex.slice(2) + v.toString(16).padStart(2, "0");
  return { r, s: sHex, v, serialized };
}

type Params = {
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

/** Coerce raw items into the shape TypedDataEncoder expects (all strings). */
function normItem(it: unknown, withRecipient: boolean): Record<string, string> {
  const i = it as Record<string, unknown>;
  const base: Record<string, string> = {
    itemType: String(i.itemType ?? 0),
    token: String(i.token ?? ZERO_ADDRESS),
    identifierOrCriteria: String(i.identifierOrCriteria ?? 0),
    startAmount: String(i.startAmount ?? 0),
    endAmount: String(i.endAmount ?? 0),
  };
  if (withRecipient) base.recipient = String(i.recipient ?? ZERO_ADDRESS);
  return base;
}

/**
 * Build the OrderComponents value and compute the EIP-712 digest exactly as
 * Seaport would. Returns null if the order is structurally unusable.
 */
export function orderDigest(params: Params): { digest: string; counter: bigint } | null {
  try {
    const domain = {
      name: "Seaport",
      version: "1.6",
      chainId: CHAIN.id,
      verifyingContract: SEAPORT_ADDRESS,
    };
    const counter = BigInt(String(params.counter ?? 0));
    const value = {
      offerer: params.offerer,
      zone: params.zone ?? ZERO_ADDRESS,
      offer: (params.offer ?? []).map((o) => normItem(o, false)),
      consideration: (params.consideration ?? []).map((c) => normItem(c, true)),
      orderType: String(params.orderType ?? 0),
      startTime: String(params.startTime ?? 0),
      endTime: String(params.endTime ?? 0),
      zoneHash: params.zoneHash ?? ZERO_HASH,
      salt: String(params.salt ?? 0),
      conduitKey: params.conduitKey ?? ZERO_HASH,
      counter: counter.toString(),
    };
    const digest = TypedDataEncoder.hash(domain, EIP_712_ORDER_TYPE as never, value);
    return { digest, counter };
  } catch {
    return null;
  }
}

/**
 * Recover the EOA that signed an order, or null on any malformation. Pure /
 * offline — no network. Callers still must confirm the recovered address is the
 * offerer, and (for contract wallets) fall back to EIP-1271.
 */
export function recoverOrderSigner(rawOrder: unknown): string | null {
  const order = rawOrder as { parameters?: Params; signature?: unknown } | null;
  const p = order?.parameters;
  if (!p || typeof p.offerer !== "string") return null;
  const sig = normalizedSignature(order?.signature);
  if (!sig) return null;
  const d = orderDigest(p);
  if (!d) return null;
  try {
    const recovered = recoverAddress(d.digest, {
      r: sig.r,
      s: sig.s,
      v: sig.v,
    });
    if (!recovered || recovered === ZERO_ADDRESS) return null;
    return recovered;
  } catch {
    return null;
  }
}

/** True when the order's signature does NOT prove the offerer authorized it.
 * Offline check only (no counter / no 1271); used to permit removal of forged
 * orders. A contract-wallet order recovers to a non-offerer EOA and would look
 * "invalid" here — that is acceptable for the *removal* path (see route DELETE),
 * which also offers an authenticated owner path. */
export function signatureFailsOffline(rawOrder: unknown): boolean {
  const order = rawOrder as { parameters?: Params } | null;
  const offerer = order?.parameters?.offerer;
  if (typeof offerer !== "string") return true;
  const recovered = recoverOrderSigner(rawOrder);
  if (!recovered) return true;
  return recovered.toLowerCase() !== offerer.toLowerCase();
}

/** Default RPC bound to the configured chain. */
export function defaultRpc(): Rpc {
  // Server-side ordered list: private provider (RPC_URL) first, public
  // fallbacks after — same chain the /api/rpc proxy walks.
  const urls: string[] =
    SERVER_RPC_URLS.length > 0 ? SERVER_RPC_URLS : [CHAIN.rpcUrls.default];
  async function rpcOnce(url: string, method: string, params: unknown[]): Promise<string> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await res.json()) as { result?: string; error?: unknown };
    if (json.error || typeof json.result !== "string") {
      throw new Error("rpc error");
    }
    return json.result;
  }
  // Verification stays fail-closed, but a single transient RPC blip (the
  // public endpoint 502s intermittently — seen live) shouldn't bounce a
  // user's freshly signed listing. Walk providers with a retry pass each,
  // then reject.
  async function rpc(method: string, params: unknown[]): Promise<string> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const url of urls) {
        try {
          return await rpcOnce(url, method, params);
        } catch (error) {
          lastError = error;
        }
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error("rpc error");
  }
  return {
    getCode: (address) => rpc("eth_getCode", [address, "latest"]),
    call: (to, data) => rpc("eth_call", [{ to, data }, "latest"]),
  };
}

/**
 * Full, fail-closed order-signature verification.
 *
 * 1. Recompute the Seaport EIP-712 digest (incl. counter).
 * 2. Normalise the signature (EIP-2098 compact → 65 bytes; reject high-s,
 *    bad v, malformed hex, zero recovery). Any error rejects.
 * 3. If the offerer has no code → EOA path: require ecrecover === offerer.
 *    If it has code → EIP-1271 path: eth_call isValidSignature, require the
 *    0x1626ba7e magic value. RPC failure on either → REJECT (fail closed).
 * 4. Require the order's counter equals the offerer's current on-chain counter.
 *    RPC failure → REJECT (a stale-counter order is dead on-chain).
 */
export async function verifyOrderSignature(
  rawOrder: unknown,
  rpc: Rpc = defaultRpc()
): Promise<VerifyResult> {
  const order = rawOrder as { parameters?: Params; signature?: unknown } | null;
  const p = order?.parameters;
  if (!p || typeof p.offerer !== "string") {
    return { ok: false, reason: "Order has no offerer." };
  }
  const offerer = p.offerer;

  // Raw signature must at least be hex. EOA path additionally requires a
  // well-formed, non-malleable 65-byte (or compact) ECDSA sig; contract wallets
  // (EIP-1271) may use arbitrary signature bytes, so we only normalize for the
  // EOA branch.
  const rawSig = order?.signature;
  if (typeof rawSig !== "string" || !/^0x[0-9a-fA-F]*$/.test(rawSig)) {
    return { ok: false, reason: "Signature is not valid hex." };
  }

  const d = orderDigest(p);
  if (!d) return { ok: false, reason: "Order could not be digested." };

  // --- Determine EOA vs contract wallet. RPC failure => fail closed. ---
  let code: string;
  try {
    code = await rpc.getCode(offerer);
  } catch {
    return { ok: false, reason: "Could not confirm offerer account (RPC unavailable).", transient: true };
  }

  const isContract = typeof code === "string" && code !== "0x" && code !== "0x0" && code.length > 2;

  if (!isContract) {
    // EOA path — normalise (reject malleable/high-s/bad-v), recover and compare.
    const sig = normalizedSignature(rawSig);
    if (!sig) return { ok: false, reason: "Signature is malformed or malleable." };
    let recovered: string;
    try {
      recovered = recoverAddress(d.digest, { r: sig.r, s: sig.s, v: sig.v });
    } catch {
      return { ok: false, reason: "Signature did not recover to a valid address." };
    }
    if (!recovered || recovered === ZERO_ADDRESS) {
      return { ok: false, reason: "Signature recovered to the zero address." };
    }
    if (recovered.toLowerCase() !== offerer.toLowerCase()) {
      return { ok: false, reason: "Signature was not produced by the offerer." };
    }
  } else {
    // EIP-1271 path — ask the contract wallet with the raw signature bytes.
    // Fail closed on any RPC issue.
    let result: string;
    try {
      const data = IFACE.encodeFunctionData("isValidSignature", [d.digest, rawSig]);
      result = await rpc.call(offerer, data);
    } catch {
      return { ok: false, reason: "Could not verify contract-wallet signature (RPC unavailable).", transient: true };
    }
    let magic: string;
    try {
      [magic] = IFACE.decodeFunctionResult("isValidSignature", result) as unknown as [string];
    } catch {
      // Could be a deliberately-malformed reply from a malicious wallet, or
      // could be an RPC/proxy hiccup mangling the response — we can't tell
      // which, so treat it as transient (don't purge) rather than guess.
      return { ok: false, reason: "Contract wallet returned an undecodable value.", transient: true };
    }
    if (typeof magic !== "string" || magic.toLowerCase() !== EIP1271_MAGIC) {
      return { ok: false, reason: "Contract wallet rejected the signature." };
    }
  }

  // --- Counter check. A stale-counter order is dead; RPC failure => reject. ---
  let counterResult: string;
  try {
    counterResult = await rpc.call(SEAPORT_ADDRESS, IFACE.encodeFunctionData("getCounter", [offerer]));
  } catch {
    return { ok: false, reason: "Could not confirm order counter (RPC unavailable).", transient: true };
  }
  try {
    const [current] = IFACE.decodeFunctionResult("getCounter", counterResult) as unknown as [bigint];
    if (BigInt(current) !== d.counter) {
      return { ok: false, reason: "Order counter is stale (bulk-cancelled or wrong)." };
    }
  } catch {
    return { ok: false, reason: "Could not decode order counter.", transient: true };
  }

  return { ok: true };
}
