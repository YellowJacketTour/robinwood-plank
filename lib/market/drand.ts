import { Interface } from "ethers";
import { sendTransaction, waitForTransaction } from "@/lib/wallet";
import { DRAND_BEACON_ADDRESS } from "@/lib/constants";

/** Matches .github/workflows/relay-drand.yml's DRAND_CHAIN_HASH exactly —
 * the two relay paths (the GH Action and this in-app one) must agree on
 * which drand beacon they're both forwarding from. */
export const DRAND_CHAIN_HASH = "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3";
const DRAND_API = "https://api.drand.sh";

export const BEACON_IFACE = new Interface([
  "function submitRound(uint64 round, uint256[2] signature)",
  "function isRoundAvailable(uint64 round) view returns (bool)",
]);

/**
 * DrandBeacon.submitRound is PERMISSIONLESS by design (see
 * contracts/DrandBeacon.sol and scripts/relay-drand.ts's own doc comment):
 * it forwards a round drand already published to the entire world over
 * plain HTTP, and the contract verifies the BLS signature on-chain before
 * accepting it — this script/function has no privilege whatsoever and
 * cannot influence the outcome, only deliver it early.
 *
 * Confirmed live and necessary: the vault has exactly one redemption slot
 * vault-wide, and a pending request that never gets relayed blocks every
 * OTHER user's requestRandomRedeem/redeemTarget too (RequestPending /
 * ReservedForPendingRedeem) — not just its own requester. The GitHub
 * Actions relay is supposed to handle this automatically every 10 minutes,
 * but it's a single point of failure (secret expires, wallet runs out of
 * gas, workflow gets disabled) with no visible symptom until someone tries
 * to redeem and silently can't. This gives ANY connected wallet a way to
 * unstick it themselves instead of waiting on/debugging that workflow.
 */
function parseG1Signature(hex: string): [bigint, bigint] {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length !== 128) {
    throw new Error(
      `Unexpected drand signature length (${h.length} hex chars, expected 128) — this beacon may use point compression, refusing to guess.`
    );
  }
  return [BigInt("0x" + h.slice(0, 64)), BigInt("0x" + h.slice(64))];
}

export type DrandRoundStatus = { round: bigint; available: boolean };

/** Fetches the round's real BLS signature from drand's own public API
 * (never from our own backend — the whole point is that nobody has to
 * trust us for this) and returns ready-to-send calldata. Throws if the
 * round hasn't actually been published yet (should be pre-checked via
 * lib/market/vault.ts's getPendingRound() before calling this). */
export async function fetchRoundCalldata(round: bigint): Promise<string> {
  const res = await fetch(`${DRAND_API}/${DRAND_CHAIN_HASH}/public/${round.toString()}`);
  if (!res.ok) {
    throw new Error(`Drand round ${round} isn't published yet (or the public API is down) — try again shortly.`);
  }
  const data = (await res.json()) as { round: number; signature: string };
  const sig = parseG1Signature(data.signature);
  return BEACON_IFACE.encodeFunctionData("submitRound", [round, sig]);
}

/** Relays a published-but-not-yet-on-chain drand round — the self-serve
 * unstick button. Any connected wallet can call this; it costs them a
 * little gas and nothing else, and it can only ever deliver a real,
 * already-public value (the contract verifies the BLS signature itself). */
export async function relayDrandRound(
  accountAddress: string,
  round: bigint,
  onSubmitted?: (hash: string) => void
): Promise<string> {
  const calldata = await fetchRoundCalldata(round);
  const hash = await sendTransaction({
    to: DRAND_BEACON_ADDRESS,
    from: accountAddress,
    data: calldata,
    kind: "beacon",
  });
  onSubmitted?.(hash);
  await waitForTransaction(hash, { label: "Relay drand round" });
  return hash;
}
