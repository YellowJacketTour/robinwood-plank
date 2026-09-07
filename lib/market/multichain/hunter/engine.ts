import type { HunterDriver, HunterFamily, HunterFinding, HunterReceipt } from "./types";
import { readHunterCursor, writeHunterCursor } from "./cursor";

/**
 * The engine owns everything a driver should not: cursor read/write, the
 * time budget, the receipt, and the sink. A driver only turns one chunk of
 * a chain into Findings.
 */
export type HuntSink = (finding: HunterFinding) => Promise<number>;

export async function runHunt(input: {
  driver: HunterDriver;
  chainSlug: string;
  budgetMs: number;
  signal?: AbortSignal;
  sink: HuntSink;
  scope?: string;
  log?: (msg: string) => void;
}): Promise<HunterReceipt> {
  const log = input.log ?? ((m: string) => console.log(`[hunter:${input.driver.family}:${input.chainSlug}] ${m}`));
  const startedAt = new Date();
  const deadline = Date.now() + input.budgetMs;
  const cursorBefore = await readHunterCursor(input.driver.family, input.chainSlug, input.scope);
  let cursor = cursorBefore;
  let sourceCalls = 0;
  let findings = 0;
  let rowsWritten = 0;
  let sourceStatus: HunterReceipt["sourceStatus"] = "ok";
  let note: string | undefined;

  // Keep hunting chunks until the budget is spent, the driver reports it
  // is caught up (cursorAfter == cursor), or the source pushes back.
  for (let pass = 0; pass < 200; pass += 1) {
    if (input.signal?.aborted || Date.now() >= deadline - 500) break;
    const r = await input.driver.hunt(cursor, { chainSlug: input.chainSlug, deadline, signal: input.signal, log });
    sourceCalls += r.sourceCalls;
    sourceStatus = r.sourceStatus;
    note = r.note ?? note;
    for (const f of r.findings) {
      findings += 1;
      rowsWritten += await input.sink(f).catch((err) => {
        log(`sink failed: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      });
    }
    const moved = JSON.stringify(r.cursorAfter) !== JSON.stringify(cursor);
    if (r.cursorAfter && moved) {
      cursor = r.cursorAfter;
      await writeHunterCursor(input.driver.family, input.chainSlug, cursor, input.scope);
    }
    if (r.sourceStatus !== "ok" || !moved) break;
  }

  return {
    family: input.driver.family,
    chainSlug: input.chainSlug,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    sourceCalls,
    sourceStatus,
    cursorBefore,
    cursorAfter: cursor,
    findings,
    rowsWritten,
    note,
  };
}

export function familyForChain(chainSlug: string): HunterFamily {
  if (chainSlug === "solana-mainnet") return "solana";
  if (chainSlug === "bitcoin-mainnet") return "bitcoin";
  return "evm";
}
