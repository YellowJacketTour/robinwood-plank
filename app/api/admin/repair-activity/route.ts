import { verifyAdminProof, type AdminProof } from "@/lib/admin-auth";
import { logAdminAction } from "@/lib/admin-log";
import { ethBlockNumberDisplay } from "@/lib/market/fetch-rpc";
import { reindexNftRange } from "@/lib/market/chain-indexer";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Re-derive kind/venue/price for a block range already in the permanent
 * ledger, using whatever classifier is live NOW — not the one that wrote the
 * rows originally. Exists specifically for the vault-mislabelled-as-sale
 * incident (commit dd750d1): NEXT_PUBLIC_MARKET_VAULT_ADDRESS drifted stale
 * on this server sometime around block 27,935,949, so every V3 deposit/
 * redeem after that point was written as an open-market "sale". The fix
 * (classify from a vault's own emitted event, not the env address list) is
 * evidence-based, so re-running it over the affected range repairs those
 * rows correctly EVEN IF the env var is still stale — the receipt itself
 * proves what happened, the env list is now only a fallback.
 *
 * Same "only derived columns move" guarantee as reindexNftRange/
 * repairChainEvents: price_wei is filled, never erased; kind/venue are
 * overwritten only when they actually differ from what's newly derived.
 *
 * Defaults to the exact incident range if the caller doesn't override it.
 */
const INCIDENT_FROM_BLOCK = 27_935_949;
// reindexNftRange has no internal time cutoff — bound how many blocks one
// request will attempt so a large range (this incident spans roughly a
// million blocks) can never hang a single HTTP request. The response reports
// a `nextFromBlock` cursor so the caller pages through, exactly like
// backfill-events' "call again to continue" pattern.
const MAX_BLOCKS_PER_CALL = 200_000;

export async function POST(req: Request) {
  const limited = rateLimit(req, {
    key: "admin-repair-activity",
    limit: 5,
    windowMs: 60_000,
  });
  if (limited) return limited;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      auth?: AdminProof;
      fromBlock?: number;
      toBlock?: number;
    };
    const auth = body.auth;
    if (
      !auth ||
      typeof auth.address !== "string" ||
      typeof auth.timestamp !== "number" ||
      typeof auth.signature !== "string"
    ) {
      return publicJson(
        { error: "BAD_AUTH", message: "auth requires address, timestamp, and signature." },
        400
      );
    }

    const fromBlock =
      Number.isInteger(body.fromBlock) && (body.fromBlock as number) >= 0
        ? (body.fromBlock as number)
        : INCIDENT_FROM_BLOCK;

    // The signed payload binds the actual range, not just the action name —
    // an admin approving "repair from block X" should not be reusable to
    // silently repair a different range later.
    const verdict = verifyAdminProof(
      "repair-activity",
      JSON.stringify({ fromBlock }),
      auth
    );
    if (!verdict.ok) {
      const status = verdict.error === "UNAUTHORIZED" ? 403 : 401;
      return publicJson(
        {
          error: verdict.error,
          message:
            verdict.error === "STALE"
              ? "Signature expired — sign again."
              : verdict.error === "UNAUTHORIZED"
                ? "This wallet is not an admin."
                : "Signature verification failed.",
        },
        status
      );
    }

    const startedAt = Date.now();
    const realHead = Number.isInteger(body.toBlock)
      ? (body.toBlock as number)
      : await ethBlockNumberDisplay();

    if (!Number.isFinite(realHead) || realHead < fromBlock) {
      return publicJson(
        { error: "BAD_RANGE", message: `Resolved head ${realHead} is before fromBlock ${fromBlock}.` },
        400
      );
    }

    const toBlock = Math.min(realHead, fromBlock + MAX_BLOCKS_PER_CALL);
    const caughtUp = toBlock >= realHead;

    const result = await reindexNftRange({ fromBlock, toBlock });

    await logAdminAction(
      verdict.address,
      "repair-activity",
      `range ${fromBlock}-${toBlock} (real head ${realHead}), ${result.windows} window(s), +${result.rowsInserted} inserted, ${result.rowsRepaired} repaired, ${result.logsScanned} logs scanned, caughtUp=${caughtUp}`
    );

    return publicJson({
      ok: true,
      fromBlock,
      toBlock,
      realHead,
      caughtUp,
      nextFromBlock: caughtUp ? null : toBlock + 1,
      ...result,
      elapsedMs: Date.now() - startedAt,
      note: caughtUp
        ? "Fully repaired through the current head."
        : `Repaired ${fromBlock}-${toBlock}. Call again with fromBlock=${toBlock + 1} to continue.`,
    });
  } catch (error) {
    return publicError(error, "Repair pass failed.");
  }
}
