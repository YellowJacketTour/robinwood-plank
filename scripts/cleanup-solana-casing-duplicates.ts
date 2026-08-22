/**
 * One-time cleanup for a real, already-fixed bug: every write path in
 * lib/market/multichain/store.ts used to unconditionally .toLowerCase()
 * every contract_address before storing/matching it -- correct for EVM
 * hex addresses, WRONG for Solana's case-sensitive base58 pubkeys. The
 * write-path fix already landed (normalizeContractAddress preserves case
 * for non-EVM chains), but every row registered BEFORE that fix is a
 * permanent, unrecoverable-in-place duplicate: a real collection now has
 * one corrupted all-lowercase row (which can never sync -- every stored
 * sync_error for it is a real "Pubkey Validation Err") sitting alongside
 * a correctly-cased row for the exact same real collection.
 *
 * SAFE TO DELETE, NOT JUST SAFE TO IGNORE: a corrupted row's own pubkey
 * is invalid, so it has never had and can never have real snapshot data
 * -- deleting it loses nothing, it only removes permanent dead weight
 * (this is exactly the "solana is now showing 49 thousand collections"
 * inflation flagged live 2026-08-20).
 *
 * DRY-RUN BY DEFAULT. Nothing is deleted unless --apply is passed
 * explicitly. Always run without --apply first and read the report.
 *
 * Usage:
 *   tsx scripts/cleanup-solana-casing-duplicates.ts              (report only)
 *   tsx scripts/cleanup-solana-casing-duplicates.ts --apply      (actually delete)
 *   tsx scripts/cleanup-solana-casing-duplicates.ts --chain=solana-mainnet --apply
 */
import { hasPostgresConfig, postgresQuery } from "../lib/postgres";

const APPLY = process.argv.includes("--apply");
const chainArg = process.argv.find((a) => a.startsWith("--chain="));
const CHAIN_SLUG = chainArg ? chainArg.slice("--chain=".length) : "solana-mainnet";

type DupPair = {
  corrupted_id: number;
  corrupted_address: string;
  real_id: number;
  real_address: string;
  real_name: string | null;
};

async function main() {
  if (!hasPostgresConfig()) {
    throw new Error("cleanup-solana-casing-duplicates: no Postgres config -- set PGHOST/PGDATABASE/PGUSER/PGPASSWORD first.");
  }

  // A row is a "corrupted duplicate" only when a SIBLING row exists for
  // the same chain whose address, once lowercased, matches this one --
  // AND that sibling is NOT itself all-lowercase (i.e. it carries real
  // mixed case). This never matches a genuinely standalone all-lowercase
  // address that was never corrupted (no sibling means no match, by
  // construction) -- see this file's own header for why that distinction
  // matters.
  const result = await postgresQuery<DupPair>(
    `SELECT
       a.id AS corrupted_id, a.contract_address AS corrupted_address,
       b.id AS real_id, b.contract_address AS real_address, b.name AS real_name
     FROM plank_multichain_collections a
     JOIN plank_multichain_collections b
       ON a.chain_slug = b.chain_slug
      AND LOWER(a.contract_address) = LOWER(b.contract_address)
      AND a.contract_address <> b.contract_address
     WHERE a.chain_slug = $1
       AND a.contract_address = LOWER(a.contract_address)
       AND b.contract_address <> LOWER(b.contract_address)
     ORDER BY a.id`,
    [CHAIN_SLUG]
  );

  const pairs = result.rows;
  console.log(`[cleanup] chain=${CHAIN_SLUG} found ${pairs.length} corrupted-duplicate pair(s)${APPLY ? "" : " (DRY RUN -- pass --apply to actually delete)"}`);

  if (pairs.length === 0) {
    console.log("[cleanup] nothing to do.");
    return;
  }

  for (const p of pairs.slice(0, 20)) {
    console.log(`  corrupted #${p.corrupted_id} (${p.corrupted_address}) duplicates real #${p.real_id} (${p.real_address}) "${p.real_name ?? "unnamed"}"`);
  }
  if (pairs.length > 20) console.log(`  ...and ${pairs.length - 20} more`);

  if (!APPLY) {
    console.log("\n[cleanup] Re-run with --apply to delete the corrupted rows listed above (and their snapshot rows via ON DELETE CASCADE, same as any other collection deletion path in this app).");
    return;
  }

  const ids = pairs.map((p) => p.corrupted_id);
  const deleted = await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id = ANY($1::int[])`, [ids]);
  console.log(`[cleanup] deleted ${deleted.rowCount ?? 0} corrupted row(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[cleanup] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
