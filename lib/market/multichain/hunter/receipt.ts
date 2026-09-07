import { postgresQuery } from "@/lib/postgres";
import type { HunterReceipt } from "./types";

/**
 * Work receipts (FAILURES-AND-INVENTIONS failure 5). A job that finished
 * without moving its cursor or writing a row is a different outcome from
 * one that did work; both used to be "succeeded". The receipt is stored on
 * the job's own payload (no schema change) so the diagnostics endpoint and
 * the queue telemetry can tell them apart.
 */
export function isNoop(r: HunterReceipt): boolean {
  const moved = JSON.stringify(r.cursorBefore) !== JSON.stringify(r.cursorAfter);
  return !moved && r.rowsWritten === 0 && r.findings === 0;
}

export async function attachReceipt(jobId: number, receipt: HunterReceipt): Promise<void> {
  await postgresQuery(
    `UPDATE plank_data_jobs
        SET payload = payload || jsonb_build_object('receipt', $2::jsonb, 'noop', $3::boolean)
      WHERE id = $1`,
    [jobId, JSON.stringify(receipt), isNoop(receipt)]
  ).catch(() => undefined);
}
