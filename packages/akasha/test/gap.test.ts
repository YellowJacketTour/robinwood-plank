/**
 * Gap backfill: bounded work, and legal reasons only.
 *
 * The budget is the cost control. A gap of a million blocks must not become a
 * million fetches in one step, or one reconnect on one chain starves every
 * other lane -- which is exactly how production's mesh stalled.
 */
import { test } from "node:test";
import { eq, ok, throws } from "./_expect.ts";
import { ArchiveStore } from "../src/hose/store.ts";
import { GapWorker, assertLegalGap, GAP_BUDGET } from "../src/hose/gap.ts";
import type { ChainId, Header } from "../src/shared/types.ts";

const hx = (s: string) => s as `0x${string}`;

function storeWithGap(
  chain: ChainId,
  from: number,
  to: number,
  reason: Parameters<typeof assertLegalGap>[0],
  artifactId?: string
): ArchiveStore {
  const s = new ArchiveStore();
  s.enqueueGap({ chain, fromHeight: from, toHeight: to, reason, artifactId });
  return s;
}

/** Records which heights were asked for, so the budget is observable. */
function tracker() {
  const asked: number[] = [];
  const fetchHeader = async (chain: ChainId, height: number): Promise<Header | undefined> => {
    asked.push(height);
    return { chain, height, hash: hx(`0x${height.toString(16)}`), parentHash: hx("0x0") };
  };
  return { asked, fetchHeader };
}

test("a huge gap is walked in budget-sized steps, not all at once", async () => {
  const s = storeWithGap("ethereum", 100, 1_000_000, "reconnect");
  const { asked, fetchHeader } = tracker();
  const w = new GapWorker(s, new Map(), fetchHeader);

  eq(await w.step(), true);
  eq(asked.length, GAP_BUDGET.evm, "one step fetches exactly the EVM budget");
  eq(asked[0], 100);
  eq(asked.at(-1), 100 + GAP_BUDGET.evm! - 1);
});

test("the remainder is re-enqueued so the walk resumes where it stopped", async () => {
  const s = storeWithGap("ethereum", 100, 1_000_000, "reconnect");
  const { fetchHeader } = tracker();
  const w = new GapWorker(s, new Map(), fetchHeader);
  await w.step();

  const next = s.popGap();
  ok(next, "the unfinished remainder is still queued");
  eq(next!.fromHeight, 100 + GAP_BUDGET.evm!, "resumes at the next unwalked height");
  eq(next!.toHeight, 1_000_000);
  eq(next!.attempts, 1, "and counts the attempt, so a stuck gap is visible");
});

test("a gap smaller than the budget completes and is not re-enqueued", async () => {
  const s = storeWithGap("ethereum", 10, 12, "reorg");
  const { asked, fetchHeader } = tracker();
  const w = new GapWorker(s, new Map(), fetchHeader);

  eq(await w.step(), true);
  eq(asked, [10, 11, 12]);
  eq(s.popGap(), undefined, "nothing left to do");
});

test("budgets differ by chain family: Bitcoin walks one block per step", async () => {
  const s = storeWithGap("bitcoin", 800_000, 800_100, "reconnect");
  const { asked, fetchHeader } = tracker();
  await new GapWorker(s, new Map(), fetchHeader).step();
  eq(asked, [800_000], "a Bitcoin block is expensive; one per step");

  const sol = storeWithGap("solana", 1, 10_000, "seq_gap");
  const t2 = tracker();
  await new GapWorker(sol, new Map(), t2.fetchHeader).step();
  eq(t2.asked.length, GAP_BUDGET.solana);
});

test("an empty queue is a no-op, not an error", async () => {
  const w = new GapWorker(new ArchiveStore(), new Map(), async () => undefined);
  eq(await w.step(), false);
});

test("only legal reasons are accepted", () => {
  for (const r of ["reconnect", "reorg", "bloom_audit", "seq_gap"] as const) {
    assertLegalGap(r, false);
  }
  throws(() => assertLegalGap("because_i_felt_like_it" as never, true), /illegal gap reason/);
});

test("an attention_history gap requires an artifact that actually exists", async () => {
  // Attention may schedule a backfill for something we already hold. It may
  // NOT invent a subject: that is identity by attention, which this design
  // refuses everywhere.
  const s = storeWithGap("ethereum", 1, 5, "attention_history", "eth:0xmissing");
  const { fetchHeader } = tracker();
  await new GapWorker(s, new Map(), fetchHeader)
    .step()
    .then(
      () => ok(false, "a gap naming an unknown artifact must not run"),
      (e: Error) => ok(/requires an existing artifact genesis/.test(e.message))
    );

  // With the artifact present, the same gap is legal.
  const s2 = storeWithGap("ethereum", 1, 3, "attention_history", "eth:0xreal");
  s2.putArtifact({
    id: "eth:0xreal",
    chain: "ethereum",
    kind: "token",
    firstSeenBlockHash: hx("0x1"),
    firstSeenHeight: 1,
  } as never);
  const t2 = tracker();
  eq(await new GapWorker(s2, new Map(), t2.fetchHeader).step(), true);
  eq(t2.asked, [1, 2, 3]);
});

test("the artifact check is a real lookup, not a reason comparison", () => {
  // The bug this pins: `assertLegalGap(reason, reason !== "attention_history")`
  // passes false exactly when the artifact is required, so the guard could
  // never pass and every attention_history gap threw.
  throws(
    () => assertLegalGap("attention_history", "attention_history" !== "attention_history"),
    /requires an existing artifact genesis/
  );
  assertLegalGap("attention_history", true);
});
