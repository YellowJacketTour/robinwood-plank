/**
 * relay-drand.ts — push published drand rounds on-chain + free vault redeem slots.
 *
 * THIS IS OPTIONAL CONVENIENCE INFRASTRUCTURE, NOT A TRUST DEPENDENCY.
 *
 * DrandBeacon.submitRound is permissionless and verifies the BLS signature
 * on-chain. This script has no privilege whatsoever: it fetches a round that
 * drand already published to the whole world over plain HTTP and forwards it.
 * Anyone can run it — the vault owner as a cron job, a user waiting on their
 * own redemption, a random bot, a competitor. If nobody runs it, a pending
 * redemption simply waits (and can be forfeited after ~24h); if a hundred
 * people run it, the first valid submission wins and the rest are cheap
 * no-ops. It cannot influence the value it relays, and a wrong or forged
 * value is rejected by the contract, not by this script.
 *
 * After relaying, it also walks each configured vault and, if a random
 * redeem is pending and the target round is on-chain, permissionlessly
 * settles via claimRandomRedeemFor so one abandoned wallet cannot clog
 * deposit/redeem for everyone.
 *
 * The signer is a LOW-PRIVILEGE relayer identity: any wallet with a little gas
 * works. Never point this at a deploy or treasury key — it does not need one
 * and there is no reason to expose one.
 *
 *   RELAYER_PRIVATE_KEY=0x...        # throwaway, gas-only
 *   RPC_URL=https://...              # Robinhood Chain RPC (chainId 4663)
 *   BEACON_ADDRESS=0x...             # deployed DrandBeacon
 *   DRAND_CHAIN_HASH=...             # hex, no 0x, e.g. the evmnet chain hash
 *   DRAND_API=https://api.drand.sh   # optional; mirrors: api2/api3.drand.sh
 *   ROUND=12345                      # optional; default = latest
 *   VAULT_ADDRESSES=0x…,0x…          # optional; settle pending redeems
 *   WATCH=1                          # optional; keep relaying every period
 *
 * Usage:
 *   npx tsx scripts/relay-drand.ts
 */
import { JsonRpcProvider, Wallet, Contract, ZeroAddress } from "ethers";

const BEACON_ABI = [
  "function submitRound(uint64 round, uint256[2] signature)",
  "function isRoundAvailable(uint64 round) view returns (bool)",
  "function period() view returns (uint256)",
];

const VAULT_ABI = [
  "function pendingRequester() view returns (address)",
  "function pendingRound() view returns (uint64 round, bool available)",
  "function pinPendingDraw()",
  "function claimRandomRedeemFor(address requester) returns (uint256 tokenId)",
  "function forfeitExpiredRedeem(address requester)",
];

type DrandRound = { round: number; signature: string; randomness?: string };

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

/**
 * drand's BN254 beacon serialises a G1 signature as 64 bytes: x || y, each a
 * 32-byte big-endian field element. (Some drand beacons use compressed points;
 * if the hex is 32 bytes long you are talking to a compressed-G1 beacon and
 * this needs a decompression step — fail loudly rather than guess.)
 */
function parseG1(hex: string): [bigint, bigint] {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length !== 128) {
    throw new Error(
      `Expected an uncompressed 64-byte G1 signature (128 hex chars), got ${h.length}. ` +
        `This beacon may use point compression — decompress before submitting; do not guess.`
    );
  }
  return [BigInt("0x" + h.slice(0, 64)), BigInt("0x" + h.slice(64))];
}

async function fetchRound(api: string, chainHash: string, round?: string): Promise<DrandRound> {
  const suffix = round ? round : "latest";
  const url = `${api.replace(/\/$/, "")}/${chainHash}/public/${suffix}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`drand API ${url} returned ${res.status}`);
  return (await res.json()) as DrandRound;
}

function parseVaultAddresses(): string[] {
  const raw = process.env.VAULT_ADDRESSES || "";
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^0x[a-fA-F0-9]{40}$/.test(s));
}

async function relayRound(
  beacon: Contract,
  api: string,
  chainHash: string,
  roundHint?: string
): Promise<number | null> {
  const data = await fetchRound(api, chainHash, roundHint);
  const sig = parseG1(data.signature);

  if (await beacon.isRoundAvailable(data.round)) {
    console.log(`round ${data.round} already on-chain — nothing to do`);
    return data.round;
  }
  // The chain, not this script, decides whether the signature is real. A bad
  // one reverts here and writes nothing.
  const tx = await beacon.submitRound(data.round, sig);
  console.log(`submitting round ${data.round} in ${tx.hash} …`);
  const receipt = await tx.wait();
  console.log(`round ${data.round} verified on-chain (block ${receipt?.blockNumber})`);
  return data.round;
}

/**
 * Free the single vault-wide random-redeem slot when possible:
 * relay target round if needed, pin, then claimFor the requester.
 * Forfeit only if the contract says the request expired unpinned.
 */
async function settlePendingVault(
  wallet: Wallet,
  beacon: Contract,
  api: string,
  chainHash: string,
  vaultAddr: string
): Promise<void> {
  const vault = new Contract(vaultAddr, VAULT_ABI, wallet);
  let requester: string;
  try {
    requester = (await vault.pendingRequester()) as string;
  } catch (err) {
    console.log(`vault ${vaultAddr}: no pendingRequester() — skip (${(err as Error).message})`);
    return;
  }
  if (!requester || requester.toLowerCase() === ZeroAddress.toLowerCase()) {
    console.log(`vault ${vaultAddr}: no pending redeem`);
    return;
  }

  let round = BigInt(0);
  let available = false;
  try {
    const pend = (await vault.pendingRound()) as { round: bigint; available: boolean } | [bigint, boolean];
    if (Array.isArray(pend)) {
      round = pend[0];
      available = pend[1];
    } else {
      round = pend.round;
      available = pend.available;
    }
  } catch (err) {
    console.log(`vault ${vaultAddr}: pendingRound() failed — ${(err as Error).message}`);
    return;
  }

  console.log(
    `vault ${vaultAddr}: pending requester ${requester} round ${round.toString()} available=${available}`
  );

  if (round > BigInt(0) && !available) {
    try {
      await relayRound(beacon, api, chainHash, round.toString());
      available = Boolean(await beacon.isRoundAvailable(round));
    } catch (err) {
      console.error(`vault ${vaultAddr}: relay target round failed — ${(err as Error).message}`);
    }
  }

  // Try pin then settle. claimRandomRedeemFor pins internally on settle path
  // in current vault builds; pin first is cheap when already pinned.
  try {
    const pinTx = await vault.pinPendingDraw();
    console.log(`vault ${vaultAddr}: pinPendingDraw ${pinTx.hash}`);
    await pinTx.wait();
  } catch (err) {
    // Expected when round not yet available or already pinned / no request.
    console.log(`vault ${vaultAddr}: pin skipped — ${(err as Error).message?.slice(0, 120)}`);
  }

  try {
    const claimTx = await vault.claimRandomRedeemFor(requester);
    console.log(`vault ${vaultAddr}: claimRandomRedeemFor ${claimTx.hash}`);
    const rc = await claimTx.wait();
    console.log(`vault ${vaultAddr}: settled for ${requester} (block ${rc?.blockNumber})`);
    return;
  } catch (err) {
    console.log(`vault ${vaultAddr}: claimFor not ready — ${(err as Error).message?.slice(0, 160)}`);
  }

  // Last resort: expired unpinned requests (should be rare with a live relayer).
  try {
    const forfeitTx = await vault.forfeitExpiredRedeem(requester);
    console.log(`vault ${vaultAddr}: forfeitExpiredRedeem ${forfeitTx.hash}`);
    await forfeitTx.wait();
    console.log(`vault ${vaultAddr}: forfeited expired request for ${requester}`);
  } catch (err) {
    console.log(`vault ${vaultAddr}: forfeit not applicable — ${(err as Error).message?.slice(0, 120)}`);
  }
}

async function main() {
  const provider = new JsonRpcProvider(required("RPC_URL"));
  const wallet = new Wallet(required("RELAYER_PRIVATE_KEY"), provider);
  const beacon = new Contract(required("BEACON_ADDRESS"), BEACON_ABI, wallet);
  const api = process.env.DRAND_API || "https://api.drand.sh";
  const chainHash = required("DRAND_CHAIN_HASH").replace(/^0x/, "");
  const watch = process.env.WATCH === "1";
  const vaults = parseVaultAddresses();

  const bal = await provider.getBalance(wallet.address);
  console.log(`relayer ${wallet.address} balance ${Number(bal) / 1e18} ETH`);
  if (bal < BigInt("100000000000000")) {
    // 0.0001 ETH
    console.warn("WARNING: relayer balance very low — fund gas-only wallet soon");
  }

  const tick = async () => {
    // Always push latest published round (keeps beacon warm for near-term redeems).
    await relayRound(beacon, api, chainHash, process.env.ROUND);

    for (const v of vaults) {
      try {
        await settlePendingVault(wallet, beacon, api, chainHash, v);
      } catch (err) {
        console.error(`vault ${v}: settle error — ${(err as Error).message}`);
      }
    }
  };

  if (!watch) {
    await tick();
    return;
  }

  const periodMs = Number(await beacon.period()) * 1000;
  console.log(`watching; relaying every ${periodMs}ms. Ctrl-C to stop.`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick();
    } catch (err) {
      // A relayer losing a race or hitting a transient API blip is normal and
      // must never stop the loop.
      console.error("relay attempt failed:", (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, periodMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
