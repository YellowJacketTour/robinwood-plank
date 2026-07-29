/**
 * Single page-level art warmer — dedupes fence + vault dashboard + listings
 * so we don't triple-fetch the same vault images on Instant Swap mount.
 */

import { warmArtQueue } from "@/lib/art-cache";

type WarmItem = { tokenId: string; imageUrl: string | null | undefined };
type Flags = { vault?: boolean; listed?: boolean; owned?: boolean };

let lastSig = "";
let lastAt = 0;
const COOLDOWN_MS = 25_000;

function signature(items: WarmItem[]): string {
  return items
    .map((i) => `${i.tokenId}:${i.imageUrl || ""}`)
    .sort()
    .join("|")
    .slice(0, 4000);
}

/**
 * Warm art into Cache API at most once per signature per cooldown window.
 */
export function warmArtOnce(
  items: WarmItem[],
  opts?: { concurrency?: number; flags?: Flags; force?: boolean }
): void {
  if (typeof window === "undefined") return;
  const usable = items.filter((i) => i.tokenId && i.imageUrl);
  if (usable.length === 0) return;
  const sig = signature(usable);
  const now = Date.now();
  if (!opts?.force && sig === lastSig && now - lastAt < COOLDOWN_MS) return;
  lastSig = sig;
  lastAt = now;
  void warmArtQueue(usable, {
    concurrency: opts?.concurrency ?? 3,
    flags: opts?.flags,
  });
}
