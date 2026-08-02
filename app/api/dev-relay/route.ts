import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";

/**
 * DEV-ONLY random-redeem relayer for the local stack.
 *
 * V3's random redeem is two-step: the user burns a share and pins a future
 * drand round, then someone claims once that round's randomness is on-chain. In
 * production a gas-sponsored relayer injects the real drand signature and claims
 * for the user (see the V1/V2 settle-random flow). Locally the beacon is a mock
 * with no real signatures, so this route stands in for that relayer: it injects
 * the mock round's randomness and calls claimRandomRedeemFor — the exact same
 * permissionless finish, just with fabricated randomness.
 *
 * Hard-gated on NEXT_PUBLIC_DEV_LOCAL_CHAIN=1; 404s in any real build. Uses the
 * well-known Hardhat account #0 key, which only ever funds a local node.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEV_LOCAL = process.env.NEXT_PUBLIC_DEV_LOCAL_CHAIN === "1";
const NODE_URL = process.env.NEXT_PUBLIC_DEV_LOCAL_RPC || "http://127.0.0.1:8545";
const BEACON = process.env.NEXT_PUBLIC_DRAND_BEACON_ADDRESS || "";
// Hardhat account #0 — a public, well-known key that only funds local nodes.
const HH_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Minimal surface shared by BOTH the legacy (V1/V2) and V3 vaults, so this one
// relay can finish a random redeem on any of them (they share the mock beacon).
const VAULT_ABI = [
  "function pendingRequester() view returns (address)",
  "function pendingRound() view returns (uint64 round, bool available)",
  "function claimRandomRedeemFor(address requester) returns (uint256)",
];
const BEACON_ABI = [
  "function isRoundAvailable(uint64 round) view returns (bool)",
  "function setRandomness(uint64 round, bytes32 value)",
];

function json(status: string, extra: Record<string, unknown> = {}, code = 200) {
  return new Response(JSON.stringify({ status, ...extra }), {
    status: code,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request) {
  if (!DEV_LOCAL) return json("not_found", {}, 404);
  if (!BEACON) return json("no_relay", { detail: "beacon address not configured" });

  let vault = "";
  try {
    ({ vault } = (await req.json()) as { vault?: string; requester?: string } as { vault: string });
  } catch {
    return json("error", { detail: "bad body" }, 400);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) return json("error", { detail: "bad vault" }, 400);

  try {
    const provider = new JsonRpcProvider(NODE_URL, { chainId: 31337, name: "localhost" });
    const signer = new Wallet(HH_KEY0, provider);
    const v = new Contract(vault, VAULT_ABI, signer);

    const requester = (await v.pendingRequester()) as string;
    if (requester === "0x0000000000000000000000000000000000000000") {
      return json("idle");
    }

    const [targetRound] = (await v.pendingRound()) as [bigint, boolean];
    const beacon = new Contract(BEACON, BEACON_ABI, signer);

    if (!(await beacon.isRoundAvailable(targetRound))) {
      const value = keccak256(toUtf8Bytes(`local:${targetRound.toString()}:${requester}`));
      await (await beacon.setRandomness(targetRound, value)).wait();
    }

    const tx = await v.claimRandomRedeemFor(requester);
    const receipt = await tx.wait();
    return json("settled", { requester, tokenTx: receipt?.hash });
  } catch (e) {
    return json("error", { detail: e instanceof Error ? e.message : String(e) });
  }
}
