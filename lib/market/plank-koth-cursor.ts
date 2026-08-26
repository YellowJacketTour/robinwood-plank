/**
 * Season 2 $PLANK KOTH's own scan cursor -- see migration 080's own header
 * for why this exists as a standalone module instead of reusing
 * lib/market/multichain/discovery/evm-log-scan.ts's readCursor/writeCursor:
 * that file transitively imports a large chunk of the multichain module
 * graph (store.ts, alchemy adapters, control-plane, source-budget,
 * transfer-ledger), none of which this backend needs -- importing it
 * purely for two generic get/set functions meant the $PLANK KOTH backend
 * could never run anywhere the broader multichain system wasn't also
 * deployed. Same real behavior (a durable, string-keyed integer value),
 * zero shared dependency.
 */
import { postgresQuery } from "@/lib/postgres";

export async function readCursor(cursorKey: string): Promise<number | null> {
  const result = await postgresQuery<{ cursor_value: string }>(
    `SELECT cursor_value FROM plank_koth_cursor WHERE cursor_key = $1`,
    [cursorKey]
  );
  return result.rows[0] ? Number(result.rows[0].cursor_value) : null;
}

export async function writeCursor(cursorKey: string, value: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_koth_cursor (cursor_key, cursor_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cursor_key) DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = NOW()`,
    [cursorKey, value]
  );
}
