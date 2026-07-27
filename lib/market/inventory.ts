import { CHAIN } from "@/lib/constants";

/**
 * Token IDs a wallet owns in a collection, read straight from chain.
 *
 * Used to disable "Accept" on bids the connected wallet can't actually fill.
 * Without it, a user clicks Accept on someone's offer, signs, and the
 * transaction reverts — which reads as a broken marketplace rather than
 * "you don't own that one".
 */
export async function getOwnedTokenIds(
  contractAddress: string,
  owner: string
): Promise<Set<string>> {
  const owned = new Set<string>();
  try {
    const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

    const call = async (data: string): Promise<string | null> => {
      const res = await fetch(CHAIN.rpcUrls.default, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: contractAddress, data }, "latest"],
        }),
      });
      const json = (await res.json()) as { result?: string };
      return json.result ?? null;
    };

    const balHex = await call(`0x70a08231${pad(owner)}`); // balanceOf
    if (!balHex) return owned;
    const balance = Number(BigInt(balHex));
    if (!Number.isFinite(balance) || balance <= 0) return owned;

    // Cap the walk — a whale shouldn't stall the page.
    const limit = Math.min(balance, 200);
    const results = await Promise.all(
      Array.from({ length: limit }, (_, i) =>
        // tokenOfOwnerByIndex(address,uint256)
        call(`0x2f745c59${pad(owner)}${pad(BigInt(i).toString(16))}`)
      )
    );
    for (const r of results) {
      if (r && r !== "0x") owned.add(BigInt(r).toString());
    }
  } catch {
    // Fail open: an empty set only means we can't pre-disable buttons.
  }
  return owned;
}
